import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Kind, Message } from "acommune-shared";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface RelayHandle {
  url: string;
  requests: URL[];
  environment?: NodeJS.ProcessEnv;
  requestLogPath?: string;
}

const cliPath = resolve(process.cwd(), "dist/cli.js");
const directories: string[] = [];
const servers: Server[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-harvest-test-"));
  directories.push(directory);
  return directory;
}

function message(seq: number, kind: Kind, body: unknown, sender = "alice"): Message {
  return {
    seq,
    prev_hash: `prev-${seq}`,
    hash: `hash-${seq}`,
    sender,
    kind,
    body,
    ts: new Date(Date.UTC(2026, 6, 1, 0, seq)).toISOString(),
  };
}

async function fakeRelay(messages: readonly Message[]): Promise<RelayHandle> {
  const requests: URL[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://relay.test");
    requests.push(url);
    assert.equal(request.headers["x-acommune-code"], "pairing-code");
    assert.equal(url.pathname, "/rooms/demo/messages");
    const afterSeq = Number(url.searchParams.get("after_seq"));
    const limit = Number(url.searchParams.get("limit"));
    const kinds = new Set((url.searchParams.get("kinds") ?? "").split(","));
    const selected = messages
      .filter((item) => item.seq > afterSeq && kinds.has(item.kind))
      .slice(0, limit);
    const lastSeq = selected.at(-1)?.seq ?? Math.max(afterSeq, messages.at(-1)?.seq ?? 0);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ messages: selected, last_seq: lastSeq }));
  });
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EPERM"
    ) {
      throw error;
    }
    const mockDirectory = await tempDirectory();
    const messagesPath = join(mockDirectory, "messages.json");
    const requestLogPath = join(mockDirectory, "requests.jsonl");
    await writeFile(messagesPath, JSON.stringify(messages), "utf8");
    const importPath = resolve(process.cwd(), ".test-dist/test/harvest-fetch-mock.js");
    return {
      url: "http://127.0.0.1:1",
      requests,
      environment: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${importPath}`]
          .filter((part) => part !== undefined && part !== "")
          .join(" "),
        ACOMMUNE_HARVEST_TEST_MESSAGES: messagesPath,
        ACOMMUNE_HARVEST_TEST_REQUEST_LOG: requestLogPath,
      },
      requestLogPath,
    };
  }
  servers.push(server);
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}`, requests };
}

async function configure(home: string, relay: string, vaultPath?: string): Promise<void> {
  const directory = join(home, ".acommune");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), `${JSON.stringify({
    relay,
    room: "demo",
    code: "pairing-code",
    ...(vaultPath === undefined ? {} : { vault_path: vaultPath }),
  })}\n`, "utf8");
}

async function runCli(
  home: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: home,
      env: { ...process.env, ...environment, HOME: home },
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

async function recordedRequests(relay: RelayHandle): Promise<URL[]> {
  if (relay.requestLogPath === undefined) return relay.requests;
  const content = await readFile(relay.requestLogPath, "utf8");
  return content.trim().split("\n").filter((line) => line !== "").map((line) => {
    const value: unknown = JSON.parse(line);
    assert.ok(typeof value === "object" && value !== null && "url" in value && typeof value.url === "string");
    return new URL(value.url, "http://relay.test");
  });
}

function occurrences(content: string, value: string): number {
  return content.split(value).length - 1;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
    ),
  );
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("acommune harvest", () => {
  it("backfills and paginates all knowledge into a monthly digest and index", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const messages = Array.from(
      { length: 501 },
      (_, index) => message(index + 1, "knowledge", { summary: `learning ${index + 1}` }),
    );
    const relay = await fakeRelay(messages);
    await configure(home, relay.url, vault);

    const result = await runCli(home, ["harvest"], relay.environment);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /harvested 501 new knowledge entries into .*demo knowledge 2026-07\.md \(cursor now 501\)/);
    const digestPath = join(vault, "acommune", "demo knowledge 2026-07.md");
    const digest = await readFile(digestPath, "utf8");
    assert.match(digest, /^---\ntype: acommune-harvest\nroom: demo\nmonth: 2026-07\n---/);
    assert.equal(occurrences(digest, "\n^acm-"), 501);
    assert.match(digest, /\n\^acm-1\n/);
    assert.match(digest, /\n\^acm-501\n/);
    const index = await readFile(join(vault, "acommune", "README.md"), "utf8");
    assert.match(index, /- \[\[demo knowledge 2026-07\]\]/);
    const requests = await recordedRequests(relay);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.searchParams.get("limit"), "500");
    assert.equal(requests[1]?.searchParams.get("after_seq"), "500");
  });

  it("is idempotent when the same relay data is harvested again", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const relay = await fakeRelay([
      message(1, "knowledge", { summary: "one" }),
      message(2, "knowledge", { summary: "two" }),
    ]);
    await configure(home, relay.url, vault);
    const first = await runCli(home, ["harvest"], relay.environment);
    assert.equal(first.code, 0, first.stderr);
    const digestPath = join(vault, "acommune", "demo knowledge 2026-07.md");
    const before = await readFile(digestPath, "utf8");

    const second = await runCli(home, ["harvest"], relay.environment);

    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /harvested 0 new knowledge entries \(cursor now 2\)/);
    assert.equal(await readFile(digestPath, "utf8"), before);
    assert.deepEqual(
      JSON.parse(await readFile(join(home, ".acommune", "harvest-cursor-demo.json"), "utf8")),
      { after_seq: 2 },
    );
  });

  it("deduplicates an overlapping --since replay without regressing the cursor", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const relay = await fakeRelay([
      message(1, "knowledge", "one"),
      message(2, "knowledge", "two"),
      message(3, "knowledge", "three"),
    ]);
    await configure(home, relay.url, vault);
    assert.equal((await runCli(home, ["harvest"], relay.environment)).code, 0);
    const digestPath = join(vault, "acommune", "demo knowledge 2026-07.md");

    const replay = await runCli(home, ["harvest", "--since", "1"], relay.environment);

    assert.equal(replay.code, 0, replay.stderr);
    assert.match(replay.stdout, /harvested 0 new knowledge entries \(cursor now 3\)/);
    const digest = await readFile(digestPath, "utf8");
    assert.equal(occurrences(digest, "^acm-1"), 1);
    assert.equal(occurrences(digest, "^acm-2"), 1);
    assert.equal(occurrences(digest, "^acm-3"), 1);
  });

  it("includes answers only when --kinds knowledge,answer is passed", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const relay = await fakeRelay([
      message(1, "knowledge", { summary: "known" }),
      message(2, "answer", { summary: "answered" }, "bob"),
    ]);
    await configure(home, relay.url, vault);

    const defaultRun = await runCli(home, ["harvest"], relay.environment);
    assert.equal(defaultRun.code, 0, defaultRun.stderr);
    const digestPath = join(vault, "acommune", "demo knowledge 2026-07.md");
    assert.doesNotMatch(await readFile(digestPath, "utf8"), /· answer ·/);

    const inclusive = await runCli(
      home,
      ["harvest", "--since=0", "--kinds=knowledge,answer"],
      relay.environment,
    );
    assert.equal(inclusive.code, 0, inclusive.stderr);
    const digest = await readFile(digestPath, "utf8");
    assert.match(digest, /## bob · answer · 2026-07-01 00:02/);
    assert.equal(occurrences(digest, "^acm-1"), 1);
    assert.equal(occurrences(digest, "^acm-2"), 1);
  });

  it("plans a dry run without writing notes, index, or cursor", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const relay = await fakeRelay([
      message(1, "knowledge", { summary: "one" }),
      message(2, "knowledge", { summary: "two" }),
    ]);
    await configure(home, relay.url);

    const result = await runCli(
      home,
      ["harvest", "--dry-run", "--vault", vault],
      relay.environment,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /dry run: would harvest 2 new knowledge entries/);
    assert.match(result.stdout, new RegExp(`create ${vault.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/acommune\/demo knowledge 2026-07\\.md: 2 new entries`));
    await assert.rejects(access(join(vault, "acommune", "demo knowledge 2026-07.md")));
    await assert.rejects(access(join(vault, "acommune", "README.md")));
    await assert.rejects(access(join(home, ".acommune", "harvest-cursor-demo.json")));
  });

  it("sanitizes, truncates, and neutralizes injected block ids", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const malicious = `safe\u0000\u0085 ^acm-999 ${"x".repeat(5_000)}`;
    const relay = await fakeRelay([
      message(1, "knowledge", { summary: malicious }, "bad\u0007actor"),
      message(999, "knowledge", { summary: "real 999" }, "bob"),
    ]);
    await configure(home, relay.url, vault);

    const result = await runCli(home, ["harvest"], relay.environment);

    assert.equal(result.code, 0, result.stderr);
    const digest = await readFile(join(vault, "acommune", "demo knowledge 2026-07.md"), "utf8");
    assert.doesNotMatch(digest, /\u0000|\u0007|\u0085/);
    assert.match(digest, /## badactor · knowledge/);
    assert.match(digest, /\\\^acm-999/);
    assert.match(digest, /\[truncated\]/);
    const firstBody = digest.match(/## badactor[^\n]*\n([^\n]*)\n\n\^acm-1/);
    assert.ok(firstBody?.[1] !== undefined);
    assert.ok(firstBody[1].length <= 2_000);
    assert.ok(firstBody[1].endsWith(" [truncated]"));
    const anchors = digest.split("\n").filter((line) => /^\^acm-\d+$/.test(line));
    assert.deepEqual(anchors, ["^acm-1", "^acm-999"]);
    assert.match(digest, /\^acm-999\n\n$/);
  });

  it("skips bodies without meaningful extracted text while advancing the cursor", async () => {
    const home = await tempDirectory();
    const vault = join(home, "vault");
    const relay = await fakeRelay([message(1, "knowledge", { summary: " \n\t" })]);
    await configure(home, relay.url, vault);

    const result = await runCli(home, ["harvest"], relay.environment);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /harvested 0 new knowledge entries \(cursor now 1\)/);
    await assert.rejects(access(join(vault, "acommune", "README.md")));
    assert.deepEqual(
      JSON.parse(await readFile(join(home, ".acommune", "harvest-cursor-demo.json"), "utf8")),
      { after_seq: 1 },
    );
  });
});
