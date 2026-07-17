import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Kind, Message } from "acommune-shared";
import {
  appendAudit,
  buildPrompt,
  processOneTrigger,
  readWatchCursor,
  runBrainOnTrigger,
  runWatchIteration,
  selectTrigger,
  type WatchIdentity,
} from "../src/watch.js";

type JsonObject = Record<string, unknown>;

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface RelayHandle {
  url: string;
  requests: RecordedRequest[];
}

interface MockResponse {
  status?: number;
  body: unknown;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cliPath = resolve(process.cwd(), "dist/cli.js");
const directories: string[] = [];
const servers: Server[] = [];
const originalFetch = globalThis.fetch;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-watch-test-"));
  directories.push(directory);
  return directory;
}

async function requestBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<unknown>) {
    assert.ok(chunk instanceof Uint8Array);
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text === "" ? undefined : JSON.parse(text) as unknown;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function fakeRelay(
  responder: (request: RecordedRequest) => MockResponse | Promise<MockResponse>,
): Promise<RelayHandle> {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (incoming, response) => {
    const body = await requestBody(incoming);
    const recorded: RecordedRequest = {
      method: incoming.method ?? "",
      url: incoming.url ?? "",
      headers: incoming.headers,
      ...(body === undefined ? {} : { body }),
    };
    requests.push(recorded);
    const mock = await responder(recorded);
    sendJson(response, mock.status ?? 200, mock.body);
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    servers.push(server);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return { url: `http://127.0.0.1:${address.port}`, requests };
  } catch (error: unknown) {
    if (!isJsonObject(error) || error.code !== "EPERM") throw error;
    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const inputUrl = input instanceof Request ? input.url : String(input);
      const url = new URL(inputUrl);
      const headers = new Headers(input instanceof Request ? input.headers : undefined);
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
      let body: unknown;
      if (typeof init?.body === "string" && init.body !== "") body = JSON.parse(init.body) as unknown;
      const recorded: RecordedRequest = {
        method: init?.method ?? (input instanceof Request ? input.method : "GET"),
        url: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers.entries()),
        ...(body === undefined ? {} : { body }),
      };
      requests.push(recorded);
      const mock = await responder(recorded);
      return new Response(JSON.stringify(mock.body), {
        status: mock.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    };
    return { url: "http://127.0.0.1:1", requests };
  }
}

function message(seq: number, sender: string, kind: Kind, body: unknown): Message {
  return {
    seq,
    prev_hash: `prev-${seq}`,
    hash: `hash-${seq}`,
    sender,
    kind,
    body,
    ts: `2026-07-17T00:00:0${seq}.000Z`,
  };
}

function identity(relay: string): WatchIdentity {
  return {
    sessionName: "worker",
    reclaimToken: "r".repeat(48),
    room: "demo",
    relay,
  };
}

function brainCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

function fixedBrain(text: string): string {
  return brainCommand(
    `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(text)}))`,
  );
}

function syncResponse(): JsonObject {
  return { received: [], sent: [], cursor: 1, status: "empty" };
}

async function runCli(directory: string, args: readonly string[]): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: directory,
      env: { ...process.env, HOME: directory },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolveResult({ code: code ?? -1, stdout, stderr }));
  });
}

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("watch trigger selection", () => {
  it("skips self-authored and differently addressed handoffs before selecting a question", () => {
    const messages = [
      message(1, "worker", "question", { question: "self" }),
      message(2, "alice", "handoff", { to: "somebody-else", what: "work" }),
      message(3, "bob", "question", { question: "help?" }),
    ];
    assert.equal(selectTrigger(messages, "worker", ["question", "handoff"]), messages[2]);
  });

  it("uses the handoff recipient fallback chain", () => {
    const addressed = message(1, "alice", "handoff", {
      target: "worker",
      assignee: "somebody-else",
    });
    assert.equal(selectTrigger([addressed], "worker", ["handoff"]), addressed);
    assert.equal(
      selectTrigger([message(2, "alice", "handoff", { recipient: "other" })], "worker", ["handoff"]),
      undefined,
    );
  });
});

describe("watch prompt and brain", () => {
  it("includes digest, trigger, and the exact answer-only standing orders", () => {
    const trigger = message(7, "alice", "question", { question: "What next?" });
    const prompt = buildPrompt("worker", trigger.kind, "{\"sessions\":[]}", trigger);
    assert.match(prompt, /Digest JSON:\n\{"sessions":\[\]\}/);
    assert.match(prompt, /Trigger message JSON:/);
    assert.ok(prompt.endsWith("You are worker, a worker agent on the acommune coordination bus. A question arrived — answer it. Reply with the exact text to post to the bus: short, concrete, actionable. If you cannot help, say precisely what is missing or who should handle it. Output ONLY the reply text. You have no tools and cannot execute anything — answer from the context given."));
  });

  it("returns timeout instead of throwing", async () => {
    const result = await runBrainOnTrigger(
      message(1, "alice", "question", {}),
      {},
      brainCommand("setTimeout(()=>{},1000)"),
      "worker",
      20,
    );
    assert.deepEqual(result, { ok: false, reason: "timeout" });
  });
});

describe("watch delivery and answers", () => {
  it("keeps the cursor unchanged after audit-only crash simulation, then reprocesses", async () => {
    const directory = await tempDirectory();
    const cursorPath = join(directory, ".acommune", "watch-cursor-demo.json");
    const auditPath = join(directory, ".acommune", "watch-audit-demo.jsonl");
    const trigger = message(1, "alice", "question", { question: "help" });
    const relay = await fakeRelay((request) => {
      const url = new URL(request.url, "http://relay.test");
      if (url.pathname.endsWith("/messages")) {
        const after = Number(url.searchParams.get("after_seq"));
        return { body: { messages: after < 1 ? [trigger] : [], last_seq: 1 } };
      }
      if (url.pathname.endsWith("/digest")) {
        return { body: { sessions: [], open_tasks: [], claims: [] } };
      }
      return { body: syncResponse() };
    });

    await appendAudit(auditPath, {
      seq: trigger.seq,
      kind: trigger.kind,
      sender: trigger.sender,
      mode: "brain",
      outcome: "interrupted before cursor advance",
      duration_ms: 1,
    });
    assert.equal(await readWatchCursor(cursorPath), 0);

    const result = await runWatchIteration({
      relay: relay.url,
      room: "demo",
      code: "pairing-code",
      identity: identity(relay.url),
      triggerKinds: ["question", "handoff"],
      afterSeq: 0,
      brainCmd: fixedBrain("reprocessed answer"),
      auditPath,
      cursorPath,
      maxPerDay: 50,
    });
    assert.equal(result.afterSeq, 1);
    assert.equal(result.processedTrigger, true);
    assert.equal(await readWatchCursor(cursorPath), 1);
    assert.equal(relay.requests.filter((request) => request.url.endsWith("/sync")).length, 1);
  });

  it("posts full answer detail with a bounded prefixed summary and re_seq", async () => {
    const directory = await tempDirectory();
    const answer = "fixed ".repeat(40).trim();
    const relay = await fakeRelay((request) => ({
      body: request.url.endsWith("/digest") ? { sessions: [{ name: "alice" }] } : syncResponse(),
    }));
    await processOneTrigger({
      relay: relay.url,
      room: "demo",
      code: "pairing-code",
      identity: identity(relay.url),
      trigger: message(9, "alice", "question", { question: "answer me" }),
      brainCmd: fixedBrain(answer),
      auditPath: join(directory, "audit.jsonl"),
      cursorPath: join(directory, "cursor.json"),
    });

    const sync = relay.requests.find((request) => request.url.endsWith("/sync"));
    assert.ok(sync !== undefined && isJsonObject(sync.body));
    assert.ok(Array.isArray(sync.body.outbox));
    const item = sync.body.outbox[0];
    assert.ok(isJsonObject(item) && item.kind === "answer" && isJsonObject(item.body));
    assert.equal(item.body.summary, `[worker] ${answer.slice(0, 120)}`);
    assert.ok(typeof item.body.summary === "string" && item.body.summary.startsWith("[worker] "));
    assert.ok(typeof item.body.summary === "string" && item.body.summary.length <= 120 + "[worker] ".length);
    assert.equal(item.body.detail, answer);
    assert.equal(item.body.re_seq, 9);
  });

  it("always posts an answer for non-zero and empty brain output", async () => {
    const directory = await tempDirectory();
    const relay = await fakeRelay((request) => ({
      body: request.url.endsWith("/digest") ? {} : syncResponse(),
    }));
    const common = {
      relay: relay.url,
      room: "demo",
      code: "pairing-code",
      identity: identity(relay.url),
      auditPath: join(directory, "audit.jsonl"),
      cursorPath: join(directory, "cursor.json"),
    };
    await processOneTrigger({
      ...common,
      trigger: message(2, "alice", "question", {}),
      brainCmd: brainCommand("process.exit(1)"),
    });
    await processOneTrigger({
      ...common,
      trigger: message(3, "bob", "question", {}),
      brainCmd: fixedBrain("   \n  "),
    });

    const details = relay.requests
      .filter((request) => request.url.endsWith("/sync"))
      .flatMap((request) => {
        if (!isJsonObject(request.body) || !Array.isArray(request.body.outbox)) return [];
        const item = request.body.outbox[0];
        return isJsonObject(item) && isJsonObject(item.body) && typeof item.body.detail === "string"
          ? [item.body.detail]
          : [];
      });
    assert.equal(details.length, 2);
    assert.match(details[0] ?? "", /Unable to answer: brain exit 1/);
    assert.match(details[1] ?? "", /Unable to answer: brain empty output/);
  });

  it("posts one cap answer and spawns the brain only once", async () => {
    const directory = await tempDirectory();
    const markerPath = join(directory, "brain-spawns.txt");
    const cursorPath = join(directory, "cursor.json");
    const auditPath = join(directory, "audit.jsonl");
    const triggers = [
      message(1, "alice", "question", { question: "one" }),
      message(2, "bob", "question", { question: "two" }),
    ];
    const relay = await fakeRelay((request) => {
      const url = new URL(request.url, "http://relay.test");
      if (url.pathname.endsWith("/messages")) {
        const after = Number(url.searchParams.get("after_seq"));
        return {
          body: {
            messages: triggers.filter((trigger) => trigger.seq > after),
            last_seq: 2,
          },
        };
      }
      if (url.pathname.endsWith("/digest")) {
        return { body: { sessions: [] } };
      }
      return { body: syncResponse() };
    });
    const brainCmd = brainCommand(
      `const fs=require('node:fs');process.stdin.resume();process.stdin.on('end',()=>{fs.appendFileSync(${JSON.stringify(markerPath)},'spawn\\n');process.stdout.write('first answer')})`,
    );
    const common = {
      relay: relay.url,
      room: "demo",
      code: "pairing-code",
      identity: identity(relay.url),
      triggerKinds: ["question"] as const,
      brainCmd,
      auditPath,
      cursorPath,
      maxPerDay: 1,
    };
    const first = await runWatchIteration({ ...common, afterSeq: 0 });
    const second = await runWatchIteration({ ...common, afterSeq: first.afterSeq });
    assert.equal(second.capped, true);
    assert.equal(await readFile(markerPath, "utf8"), "spawn\n");

    const details = relay.requests
      .filter((request) => request.url.endsWith("/sync"))
      .flatMap((request) => {
        if (!isJsonObject(request.body) || !Array.isArray(request.body.outbox)) return [];
        const item = request.body.outbox[0];
        return isJsonObject(item) && isJsonObject(item.body) && typeof item.body.detail === "string"
          ? [item.body.detail]
          : [];
      });
    assert.deepEqual(details, ["first answer", "worker at daily cap, needs Guy"]);
  });
});

describe("acommune watch status", () => {
  it("reports local state without contacting the relay", async () => {
    const directory = await tempDirectory();
    const acommuneDirectory = join(directory, ".acommune");
    await mkdir(acommuneDirectory, { recursive: true });
    await writeFile(join(acommuneDirectory, "config.json"), JSON.stringify({
      relay: "http://127.0.0.1:1",
      room: "demo",
      code: "pairing-code",
    }));
    await writeFile(join(acommuneDirectory, "watch-cursor-demo.json"), "{\"after_seq\":12}\n");
    await writeFile(
      join(acommuneDirectory, "watch-audit-demo.jsonl"),
      `${JSON.stringify({
        seq: 12,
        kind: "question",
        sender: "alice",
        mode: "brain",
        outcome: "answered",
        duration_ms: 10,
        ts: new Date().toISOString(),
      })}\n`,
    );

    const result = await runCli(directory, ["watch", "status"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Relay: http:\/\/127\.0\.0\.1:1/);
    assert.match(result.stdout, /Room: demo/);
    assert.match(result.stdout, /Cursor: 12/);
    assert.match(result.stdout, /Spawns today: 1/);
    assert.match(result.stdout, /Last trigger: question from alice/);
  });
});
