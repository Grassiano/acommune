import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { KINDS, type Kind, type Message } from "acommune-shared";
import { isJsonObject, isSafeFilePart, writePrivateJson } from "./private-files.js";

const MESSAGE_LIMIT = 100;
const DEFAULT_BRAIN_TIMEOUT_MS = 10 * 60 * 1_000;
const SIGNAL_BRAIN_GRACE_MS = 5_000;
const kindSet = new Set<string>(KINDS);

export interface WatchIdentity {
  sessionName: string;
  reclaimToken: string;
  room: string;
  relay: string;
}

export interface AuditEntry {
  seq: number;
  kind: Kind;
  sender: string;
  mode: "brain" | "cap";
  outcome: string;
  duration_ms: number;
}

export interface AuditRecord extends AuditEntry {
  ts: string;
}

export interface ProcessOneTriggerOptions {
  relay: string;
  room: string;
  code: string;
  identity: WatchIdentity;
  trigger: Message;
  brainCmd: string;
  auditPath: string;
  cursorPath: string;
  mode?: "brain" | "cap";
  timeoutMs?: number;
}

export interface WatchIterationOptions {
  relay: string;
  room: string;
  code: string;
  identity: WatchIdentity;
  triggerKinds: readonly Kind[];
  afterSeq: number;
  brainCmd: string;
  auditPath: string;
  cursorPath: string;
  maxPerDay: number;
  timeoutMs?: number;
  now?: Date;
}

export interface WatchIterationResult {
  afterSeq: number;
  processedTrigger: boolean;
  capped: boolean;
}

export interface WatchLoopOptions extends Omit<WatchIterationOptions, "afterSeq" | "now"> {
  pollSeconds: number;
  cooldownSeconds: number;
}

let activeBrainChild: ChildProcessWithoutNullStreams | undefined;
const pendingAuditWrites = new Set<Promise<void>>();
const auditQueues = new Map<string, Promise<void>>();

function isKind(value: unknown): value is Kind {
  return typeof value === "string" && kindSet.has(value);
}

function messageFrom(value: unknown): Message | undefined {
  if (
    !isJsonObject(value) ||
    typeof value.seq !== "number" ||
    !Number.isInteger(value.seq) ||
    value.seq < 0 ||
    typeof value.prev_hash !== "string" ||
    typeof value.hash !== "string" ||
    typeof value.sender !== "string" ||
    !isKind(value.kind) ||
    typeof value.ts !== "string" ||
    (value.client_msg_id !== undefined && typeof value.client_msg_id !== "string")
  ) {
    return undefined;
  }
  return {
    seq: value.seq,
    prev_hash: value.prev_hash,
    hash: value.hash,
    sender: value.sender,
    kind: value.kind,
    body: value.body,
    ts: value.ts,
    ...(value.client_msg_id === undefined ? {} : { client_msg_id: value.client_msg_id }),
  };
}

async function checkedJson(response: Response, action: string): Promise<unknown> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error(`Relay returned invalid JSON while ${action}.`);
  }
  if (!response.ok) throw new Error(`Relay rejected ${action} with HTTP ${response.status}.`);
  return value;
}

export async function fetchTriggerMessages(
  relay: string,
  room: string,
  code: string,
  afterSeq: number,
  triggerKinds: readonly Kind[],
): Promise<{ messages: Message[]; lastSeq: number }> {
  const url = new URL(`${relay}/rooms/${encodeURIComponent(room)}/messages`);
  url.searchParams.set("after_seq", String(afterSeq));
  url.searchParams.set("kinds", triggerKinds.join(","));
  url.searchParams.set("limit", String(MESSAGE_LIMIT));
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-acommune-code": code },
  });
  const value = await checkedJson(response, "reading trigger messages");
  if (!isJsonObject(value) || !Array.isArray(value.messages) || typeof value.last_seq !== "number") {
    throw new Error("Relay returned an invalid messages response.");
  }
  const messages = value.messages.map(messageFrom);
  if (messages.some((message) => message === undefined)) {
    throw new Error("Relay returned an invalid message.");
  }
  return { messages: messages.filter((message): message is Message => message !== undefined), lastSeq: value.last_seq };
}

function handoffRecipient(body: unknown): unknown {
  if (!isJsonObject(body)) return undefined;
  if (body.to !== undefined) return body.to;
  if (body.target !== undefined) return body.target;
  if (body.assignee !== undefined) return body.assignee;
  return body.recipient;
}

export function selectTrigger(
  messages: readonly Message[],
  selfName: string,
  triggerKinds: readonly Kind[],
): Message | undefined {
  const triggers = new Set<Kind>(triggerKinds);
  return messages.find((message) => {
    if (!triggers.has(message.kind) || message.sender === selfName) return false;
    if (message.kind !== "handoff") return true;
    const recipient = handoffRecipient(message.body);
    return (
      recipient === undefined ||
      recipient === null ||
      (typeof recipient === "string" && (recipient.trim() === "" || recipient === selfName))
    );
  });
}

export function buildPrompt(
  name: string,
  kind: Kind,
  digestJson: string,
  triggerMessage: Message,
): string {
  return `Digest JSON:\n${digestJson}\n\nTrigger message JSON:\n${JSON.stringify(triggerMessage)}\n\nYou are ${name}, a worker agent on the acommune coordination bus. A ${kind} arrived — answer it. Reply with the exact text to post to the bus: short, concrete, actionable. If you cannot help, say precisely what is missing or who should handle it. Output ONLY the reply text. You have no tools and cannot execute anything — answer from the context given.`;
}

export async function runBrainOnTrigger(
  trigger: Message,
  digest: unknown,
  brainCmd: string,
  selfName: string,
  timeoutMs: number,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  try {
    const prompt = buildPrompt(selfName, trigger.kind, JSON.stringify(digest), trigger);
    // brainCmd is local configuration/CLI input only; relay-provided data is stdin, never executable input.
    const child = spawn(brainCmd, [], { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    activeBrainChild = child;
    return await new Promise((resolveResult) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timedOut = false;
      const finish = (result: { ok: true; text: string } | { ok: false; reason: string }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (activeBrainChild === child) activeBrainChild = undefined;
        resolveResult(result);
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => finish({ ok: false, reason: error.message }));
      child.on("close", (code, signal) => {
        if (timedOut) {
          finish({ ok: false, reason: "timeout" });
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim();
          finish({
            ok: false,
            reason: detail === ""
              ? `exit ${code ?? signal ?? "unknown"}`
              : `exit ${code ?? signal ?? "unknown"}: ${detail}`,
          });
          return;
        }
        const text = stdout.trim();
        finish(text === "" ? { ok: false, reason: "empty output" } : { ok: true, text });
      });
      child.stdin.on("error", () => {
        // A fast-exiting brain can close stdin before the prompt is fully written.
      });
      child.stdin.end(prompt);
    });
  } catch (error: unknown) {
    activeBrainChild = undefined;
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function postAnswer(
  relay: string,
  room: string,
  identity: WatchIdentity,
  text: string,
  reSeq: number,
): Promise<void> {
  const prefix = `[${identity.sessionName}] `;
  const response = await fetch(`${relay}/rooms/${encodeURIComponent(room)}/sync`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_name: identity.sessionName,
      reclaim_token: identity.reclaimToken,
      outbox: [{
        kind: "answer",
        body: { summary: `${prefix}${text.slice(0, 120)}`, detail: text, re_seq: reSeq },
      }],
      wait_seconds: 0,
      max_items: 1,
    }),
  });
  const value = await checkedJson(response, "posting an answer");
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.received) ||
    !Array.isArray(value.sent) ||
    typeof value.cursor !== "number" ||
    (value.status !== "ready" && value.status !== "timeout" && value.status !== "empty")
  ) {
    throw new Error("Relay returned an invalid sync response.");
  }
}

export async function appendAudit(auditPath: string, entry: AuditEntry): Promise<void> {
  const previous = auditQueues.get(auditPath) ?? Promise.resolve();
  const write = previous.catch(() => undefined).then(async () => {
    const directory = dirname(auditPath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await appendFile(
      auditPath,
      `${JSON.stringify({ ...entry, ts: new Date().toISOString() })}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    await chmod(auditPath, 0o600);
  });
  auditQueues.set(auditPath, write);
  pendingAuditWrites.add(write);
  try {
    await write;
  } finally {
    pendingAuditWrites.delete(write);
    if (auditQueues.get(auditPath) === write) auditQueues.delete(auditPath);
  }
}

export async function readAudit(auditPath: string): Promise<AuditRecord[]> {
  let content: string;
  try {
    content = await readFile(auditPath, "utf8");
  } catch (error: unknown) {
    if (isJsonObject(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const records: AuditRecord[] = [];
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      !isJsonObject(value) ||
      typeof value.seq !== "number" ||
      !isKind(value.kind) ||
      typeof value.sender !== "string" ||
      (value.mode !== "brain" && value.mode !== "cap") ||
      typeof value.outcome !== "string" ||
      typeof value.duration_ms !== "number" ||
      typeof value.ts !== "string"
    ) {
      continue;
    }
    records.push({
      seq: value.seq,
      kind: value.kind,
      sender: value.sender,
      mode: value.mode,
      outcome: value.outcome,
      duration_ms: value.duration_ms,
      ts: value.ts,
    });
  }
  return records;
}

export function watchCursorPath(room: string): string {
  if (!isSafeFilePart(room)) throw new Error("Unsafe watch cursor name");
  return join(homedir(), ".acommune", `watch-cursor-${room}.json`);
}

export function watchAuditPath(room: string): string {
  if (!isSafeFilePart(room)) throw new Error("Unsafe watch audit name");
  return join(homedir(), ".acommune", `watch-audit-${room}.jsonl`);
}

export async function readWatchCursor(cursorPath: string): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(cursorPath, "utf8"));
    return isJsonObject(value) && typeof value.after_seq === "number" && value.after_seq >= 0
      ? value.after_seq
      : 0;
  } catch {
    return 0;
  }
}

async function fetchDigest(relay: string, room: string, code: string): Promise<unknown> {
  const response = await fetch(`${relay}/rooms/${encodeURIComponent(room)}/digest`, {
    method: "GET",
    headers: { "x-acommune-code": code },
  });
  return checkedJson(response, "reading the room digest");
}

export async function processOneTrigger(
  options: ProcessOneTriggerOptions,
): Promise<{ text: string; outcome: string }> {
  const startedAt = Date.now();
  const mode = options.mode ?? "brain";
  let text: string;
  let outcome: string;
  if (mode === "cap") {
    text = "worker at daily cap, needs Guy";
    outcome = "capped";
  } else {
    const digest = await fetchDigest(options.relay, options.room, options.code);
    const brain = await runBrainOnTrigger(
      options.trigger,
      digest,
      options.brainCmd,
      options.identity.sessionName,
      options.timeoutMs ?? DEFAULT_BRAIN_TIMEOUT_MS,
    );
    if (brain.ok) {
      text = brain.text;
      outcome = "answered";
    } else {
      text = `Unable to answer: brain ${brain.reason}.`;
      outcome = `brain failure: ${brain.reason}`;
    }
  }
  await postAnswer(options.relay, options.room, options.identity, text, options.trigger.seq);
  await appendAudit(options.auditPath, {
    seq: options.trigger.seq,
    kind: options.trigger.kind,
    sender: options.trigger.sender,
    mode,
    outcome,
    duration_ms: Date.now() - startedAt,
  });
  await writePrivateJson(options.cursorPath, { after_seq: options.trigger.seq });
  return { text, outcome };
}

function utcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export async function runWatchIteration(
  options: WatchIterationOptions,
): Promise<WatchIterationResult> {
  const now = options.now ?? new Date();
  const records = await readAudit(options.auditPath);
  const todaysRecords = records.filter((record) => record.ts.startsWith(utcDate(now)));
  const capped = todaysRecords.some((record) => record.outcome === "capped");
  const spawns = todaysRecords.filter((record) => record.outcome !== "capped").length;
  const fetched = await fetchTriggerMessages(
    options.relay,
    options.room,
    options.code,
    options.afterSeq,
    options.triggerKinds,
  );
  if (capped) {
    if (fetched.lastSeq > options.afterSeq) {
      await writePrivateJson(options.cursorPath, { after_seq: fetched.lastSeq });
    }
    return { afterSeq: fetched.lastSeq, processedTrigger: false, capped: true };
  }
  const trigger = selectTrigger(fetched.messages, options.identity.sessionName, options.triggerKinds);
  if (trigger === undefined) {
    if (fetched.lastSeq > options.afterSeq) {
      await writePrivateJson(options.cursorPath, { after_seq: fetched.lastSeq });
    }
    return { afterSeq: fetched.lastSeq, processedTrigger: false, capped: false };
  }
  await processOneTrigger({
    relay: options.relay,
    room: options.room,
    code: options.code,
    identity: options.identity,
    trigger,
    brainCmd: options.brainCmd,
    auditPath: options.auditPath,
    cursorPath: options.cursorPath,
    ...(spawns >= options.maxPerDay ? { mode: "cap" as const } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return {
    afterSeq: trigger.seq,
    processedTrigger: true,
    capped: spawns >= options.maxPerDay,
  };
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (milliseconds <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const timeout = setTimeout(resolveDelay, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      resolveDelay();
    }, { once: true });
  });
}

export async function runWatchLoop(options: WatchLoopOptions): Promise<void> {
  let afterSeq = await readWatchCursor(options.cursorPath);
  let stopping = false;
  let nextTriggerAt = 0;
  let brainGraceTimeout: NodeJS.Timeout | undefined;
  const sleepController = new AbortController();
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    sleepController.abort();
    if (activeBrainChild !== undefined) {
      brainGraceTimeout = setTimeout(() => activeBrainChild?.kill(), SIGNAL_BRAIN_GRACE_MS);
    }
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    while (!stopping) {
      const cooldownRemaining = nextTriggerAt - Date.now();
      if (cooldownRemaining > 0) await delay(cooldownRemaining, sleepController.signal);
      if (stopping) break;
      try {
        const result = await runWatchIteration({
          relay: options.relay,
          room: options.room,
          code: options.code,
          identity: options.identity,
          triggerKinds: options.triggerKinds,
          afterSeq,
          brainCmd: options.brainCmd,
          auditPath: options.auditPath,
          cursorPath: options.cursorPath,
          maxPerDay: options.maxPerDay,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
        afterSeq = result.afterSeq;
        if (result.processedTrigger) {
          nextTriggerAt = Date.now() + options.cooldownSeconds * 1_000;
          continue;
        }
      } catch (error: unknown) {
        process.stderr.write(`acommune watch: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      await delay(options.pollSeconds * 1_000, sleepController.signal);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (brainGraceTimeout !== undefined) clearTimeout(brainGraceTimeout);
    await Promise.all([...pendingAuditWrites]);
  }
}
