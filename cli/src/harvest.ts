import { open, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Kind, Message } from "acommune-shared";
import { isJsonObject, isSafeFilePart, writePrivateJson } from "./private-files.js";
import { messageFrom } from "./watch.js";

const HARVEST_LIMIT = 500;
const ENTRY_BODY_LIMIT = 2_000;
const TRUNCATED_MARKER = " [truncated]";
const INDEX_HEADER = "# acommune harvest\n\nMonthly bus memory notes, in first-harvest order.\n\n";

export interface HarvestOptions {
  relay: string;
  room: string;
  code: string;
  kinds: readonly Kind[];
  afterSeq: number;
  vaultPath: string;
  cursorPath: string;
  cursorFloor: number;
  dryRun: boolean;
}

export interface HarvestFileResult {
  path: string;
  count: number;
  operation: "create" | "append";
}

export interface HarvestResult {
  count: number;
  cursor: number;
  files: HarvestFileResult[];
  indexOperation?: "create" | "append";
}

interface DigestState {
  path: string;
  content: string;
  existed: boolean;
  dirty: boolean;
  newCount: number;
}

interface IndexState {
  path: string;
  content: string;
  existed: boolean;
  dirty: boolean;
}

function sanitized(value: string, maximumLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, maximumLength);
}

function bodyText(body: unknown): string {
  if (isJsonObject(body) && typeof body.summary === "string") return body.summary;
  if (typeof body === "string") return body;
  if (isJsonObject(body) && typeof body.detail === "string") return body.detail;
  const serialized = JSON.stringify(body);
  return serialized === undefined ? String(body) : serialized;
}

function neutralizeBlockIds(value: string): string {
  return value.replace(/\^acm-(?=\d)/g, "\\^acm-");
}

function entryBody(body: unknown): string | undefined {
  const summary = neutralizeBlockIds(sanitized(bodyText(body), Number.MAX_SAFE_INTEGER)).trim();
  if (summary === "") return undefined;

  const detailValue = isJsonObject(body) && typeof body.detail === "string"
    ? neutralizeBlockIds(sanitized(body.detail, Number.MAX_SAFE_INTEGER)).trim()
    : undefined;
  const combined = detailValue === undefined || detailValue === "" || detailValue === summary
    ? summary
    : `${summary}\n${detailValue}`;
  if (combined.length <= ENTRY_BODY_LIMIT) return combined;
  return `${combined.slice(0, ENTRY_BODY_LIMIT - TRUNCATED_MARKER.length)}${TRUNCATED_MARKER}`;
}

function monthAndMinute(timestamp: string): { month: string; minute: string } {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Relay returned a message with an invalid timestamp.");
  }
  const iso = date.toISOString();
  return { month: iso.slice(0, 7), minute: iso.slice(0, 16).replace("T", " ") };
}

function digestHeader(room: string, month: string): string {
  const safeRoom = sanitized(room, 80);
  return `---\ntype: acommune-harvest\nroom: ${safeRoom}\nmonth: ${month}\n---\n# ${safeRoom} knowledge — ${month}\n\n`;
}

function digestEntry(message: Message, minute: string, body: string): string {
  const sender = sanitized(message.sender, 80);
  const kind = sanitized(message.kind, 80);
  return `## ${sender} · ${kind} · ${minute}\n${body}\n\n^acm-${message.seq}`;
}

function hasAnchor(content: string, sequence: number): boolean {
  const anchor = `^acm-${sequence}`;
  return content.split("\n").some((line, index, lines) => {
    if (line !== anchor) return false;
    let following = index + 1;
    while (lines[following] === "") following += 1;
    return lines[following] === undefined || lines[following]?.startsWith("## ") === true;
  });
}

function appendEntry(content: string, entry: string): string {
  const separator = content.endsWith("\n") ? "" : "\n";
  return `${content}${separator}${entry}\n\n`;
}

async function readOptionalText(path: string): Promise<{ content: string; existed: boolean }> {
  try {
    return { content: await readFile(path, "utf8"), existed: true };
  } catch (error: unknown) {
    if (isJsonObject(error) && error.code === "ENOENT") return { content: "", existed: false };
    throw error;
  }
}

async function atomicWriteText(path: string, content: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  let mode = 0o644;
  try {
    mode = (await stat(path)).mode & 0o777;
  } catch (error: unknown) {
    if (!isJsonObject(error) || error.code !== "ENOENT") throw error;
  }

  const temporary = `${path}.${process.pid}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "w", mode);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error: unknown) {
    await handle?.close().catch(() => undefined);
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function messagesResponse(value: unknown, afterSeq: number): { messages: Message[]; lastSeq: number } {
  if (
    !isJsonObject(value) ||
    !Array.isArray(value.messages) ||
    typeof value.last_seq !== "number" ||
    !Number.isInteger(value.last_seq) ||
    value.last_seq < afterSeq
  ) {
    throw new Error("Relay returned an invalid messages response.");
  }
  const messages = value.messages.map(messageFrom);
  if (messages.some((message) => message === undefined)) {
    throw new Error("Relay returned an invalid message.");
  }
  const validMessages = messages.filter((message): message is Message => message !== undefined);
  let previous = afterSeq;
  for (const message of validMessages) {
    if (message.seq <= previous) throw new Error("Relay returned messages out of sequence.");
    previous = message.seq;
  }
  if (validMessages.length > HARVEST_LIMIT) {
    throw new Error("Relay returned too many messages.");
  }
  return { messages: validMessages, lastSeq: value.last_seq };
}

async function fetchMessages(options: HarvestOptions, afterSeq: number): Promise<{ messages: Message[]; lastSeq: number }> {
  const url = new URL(`${options.relay}/rooms/${encodeURIComponent(options.room)}/messages`);
  url.searchParams.set("after_seq", String(afterSeq));
  url.searchParams.set("kinds", options.kinds.join(","));
  url.searchParams.set("limit", String(HARVEST_LIMIT));
  const response = await fetch(url, {
    method: "GET",
    headers: { "x-acommune-code": options.code },
  });
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Relay returned invalid JSON while reading harvest messages.");
  }
  if (!response.ok) {
    throw new Error(`Relay rejected harvest messages lookup with HTTP ${response.status}.`);
  }
  return messagesResponse(value, afterSeq);
}

async function digestState(
  states: Map<string, DigestState>,
  path: string,
  room: string,
  month: string,
): Promise<DigestState> {
  const known = states.get(path);
  if (known !== undefined) return known;
  const current = await readOptionalText(path);
  const state: DigestState = {
    path,
    content: current.existed && current.content !== "" ? current.content : digestHeader(room, month),
    existed: current.existed,
    dirty: false,
    newCount: 0,
  };
  states.set(path, state);
  return state;
}

async function readIndexState(vaultPath: string): Promise<IndexState> {
  const path = join(vaultPath, "acommune", "README.md");
  const current = await readOptionalText(path);
  return {
    path,
    content: current.existed && current.content !== "" ? current.content : INDEX_HEADER,
    existed: current.existed,
    dirty: false,
  };
}

function ensureIndexBullet(index: IndexState, digestPath: string): void {
  const bullet = `- [[${basename(digestPath, ".md")}]]`;
  if (index.content.split("\n").includes(bullet)) return;
  const separator = index.content.endsWith("\n") ? "" : "\n";
  index.content = `${index.content}${separator}${bullet}\n`;
  index.dirty = true;
}

export function harvestCursorPath(room: string): string {
  if (!isSafeFilePart(room)) {
    throw new Error("Harvest room names cannot contain slashes or path components.");
  }
  return join(homedir(), ".acommune", `harvest-cursor-${room}.json`);
}

export async function readHarvestCursor(path: string): Promise<number> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch (error: unknown) {
    if (isJsonObject(error) && error.code === "ENOENT") return 0;
    if (error instanceof SyntaxError) throw new Error(`Harvest cursor ${path} is not valid JSON.`);
    throw error;
  }
  if (
    !isJsonObject(value) ||
    typeof value.after_seq !== "number" ||
    !Number.isInteger(value.after_seq) ||
    value.after_seq < 0
  ) {
    throw new Error(`Harvest cursor ${path} is invalid.`);
  }
  return value.after_seq;
}

export async function runHarvest(options: HarvestOptions): Promise<HarvestResult> {
  if (!isSafeFilePart(options.room)) {
    throw new Error("Harvest room names cannot contain slashes or path components.");
  }
  const digestDirectory = join(options.vaultPath, "acommune");
  const states = new Map<string, DigestState>();
  const index = await readIndexState(options.vaultPath);
  let cursor = options.afterSeq;

  while (true) {
    const fetched = await fetchMessages(options, cursor);
    const batchCursor = fetched.messages.at(-1)?.seq ?? fetched.lastSeq;

    for (const message of fetched.messages) {
      const body = entryBody(message.body);
      if (body === undefined) continue;
      const time = monthAndMinute(message.ts);
      const path = join(digestDirectory, `${options.room} knowledge ${time.month}.md`);
      const state = await digestState(states, path, options.room, time.month);
      ensureIndexBullet(index, path);
      if (hasAnchor(state.content, message.seq)) continue;
      state.content = appendEntry(state.content, digestEntry(message, time.minute, body));
      state.dirty = true;
      state.newCount += 1;
    }

    if (!options.dryRun) {
      const dirtyStates = [...states.values()].filter((state) => state.dirty);
      await Promise.all(dirtyStates.map((state) => atomicWriteText(state.path, state.content)));
      if (index.dirty) await atomicWriteText(index.path, index.content);

      // Notes are durable before the cursor advances. A crash before this write replays the
      // batch, and exact trailing block anchors make that at-least-once replay idempotent.
      await writePrivateJson(options.cursorPath, {
        after_seq: Math.max(options.cursorFloor, batchCursor),
      });
      for (const state of dirtyStates) state.dirty = false;
      index.dirty = false;
    }

    cursor = batchCursor;
    if (fetched.messages.length < HARVEST_LIMIT || fetched.messages.length === 0) break;
  }

  const files = [...states.values()]
    .filter((state) => state.newCount > 0)
    .map((state): HarvestFileResult => ({
      path: state.path,
      count: state.newCount,
      operation: state.existed ? "append" : "create",
    }));
  return {
    count: files.reduce((sum, file) => sum + file.count, 0),
    cursor: Math.max(options.cursorFloor, cursor),
    files,
    ...(index.dirty ? { indexOperation: index.existed ? "append" : "create" } : {}),
  };
}

export function formatHarvestResult(result: HarvestResult, dryRun: boolean): string {
  if (dryRun) {
    const lines = [`dry run: would harvest ${result.count} new knowledge entries (cursor would be ${result.cursor})`];
    for (const file of result.files) {
      lines.push(`${file.operation} ${file.path}: ${file.count} new entries`);
    }
    if (result.indexOperation !== undefined) {
      lines.push(`${result.indexOperation} harvest index`);
    }
    return `${lines.join("\n")}\n`;
  }
  if (result.files.length === 1) {
    const file = result.files[0]!;
    return `harvested ${result.count} new knowledge entries into ${file.path} (cursor now ${result.cursor})\n`;
  }
  if (result.files.length > 1) {
    const files = result.files.map((file) => `${file.path} (${file.count})`).join(", ");
    return `harvested ${result.count} new knowledge entries into ${files} (cursor now ${result.cursor})\n`;
  }
  return `harvested 0 new knowledge entries (cursor now ${result.cursor})\n`;
}
