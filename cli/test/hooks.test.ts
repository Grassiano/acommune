import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface MockResponse {
  status?: number;
  body?: unknown;
  error?: boolean;
}

interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface RelayHandle {
  url: string;
  environment: Record<string, string>;
  requests: () => Promise<RecordedRequest[]>;
}

type JsonObject = Record<string, unknown>;

const cliPath = resolve(process.cwd(), "dist/cli.js");
const fetchMockPath = resolve(process.cwd(), ".test-dist/test/fetch-mock.js");
const directories: string[] = [];
const servers: Server[] = [];
let relayNumber = 0;

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-hooks-test-"));
  directories.push(directory);
  return directory;
}

async function runCli(
  directory: string,
  args: readonly string[],
  input?: unknown,
  environment: Record<string, string> = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: directory,
      env: { ...process.env, ...environment, HOME: directory },
      stdio: ["pipe", "pipe", "pipe"],
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
    child.on("close", (code) => {
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function jsonObject(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

async function requestJson(request: IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<unknown>) {
    assert.ok(chunk instanceof Uint8Array);
    chunks.push(Buffer.from(chunk));
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  assert.ok(isJsonObject(parsed));
  return parsed;
}

async function fakeRelay(
  directory: string,
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
  mockResponses: readonly MockResponse[],
): Promise<RelayHandle> {
  const server = createServer(handler);
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    servers.push(server);
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    return {
      url: `http://127.0.0.1:${address.port}`,
      environment: {},
      requests: async () => [],
    };
  } catch (error: unknown) {
    if (!isJsonObject(error) || error.code !== "EPERM") throw error;
    const logPath = join(directory, `fetch-log-${relayNumber}.jsonl`);
    relayNumber += 1;
    return {
      url: "http://127.0.0.1:1",
      environment: {
        NODE_OPTIONS: `--import=${fetchMockPath}`,
        ACOMMUNE_TEST_FETCH_RESPONSES: JSON.stringify(mockResponses),
        ACOMMUNE_TEST_FETCH_LOG: logPath,
      },
      requests: async () => {
        try {
          return (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as RecordedRequest);
        } catch (readError: unknown) {
          if (isJsonObject(readError) && readError.code === "ENOENT") return [];
          throw readError;
        }
      },
    };
  }
}

async function unreachableRelay(directory: string): Promise<RelayHandle> {
  const server = createServer();
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    await new Promise<void>((resolveClose, reject) => {
      server.close((error) => error === undefined ? resolveClose() : reject(error));
    });
    return {
      url: `http://127.0.0.1:${address.port}`,
      environment: {},
      requests: async () => [],
    };
  } catch (error: unknown) {
    if (!isJsonObject(error) || error.code !== "EPERM") throw error;
    const logPath = join(directory, `fetch-log-${relayNumber}.jsonl`);
    relayNumber += 1;
    return {
      url: "http://127.0.0.1:1",
      environment: {
        NODE_OPTIONS: `--import=${fetchMockPath}`,
        ACOMMUNE_TEST_FETCH_RESPONSES: JSON.stringify([{ error: true }]),
        ACOMMUNE_TEST_FETCH_LOG: logPath,
      },
      requests: async () => [],
    };
  }
}

async function writeConfig(
  directory: string,
  relay: string,
  room = "demo",
  joinTempDirs?: boolean,
): Promise<void> {
  const acommuneDirectory = join(directory, ".acommune");
  await mkdir(acommuneDirectory, { recursive: true, mode: 0o700 });
  const path = join(acommuneDirectory, "config.json");
  await writeFile(
    path,
    `${JSON.stringify({
      relay,
      room,
      code: "pairing-code",
      ...(joinTempDirs === undefined ? {} : { join_temp_dirs: joinTempDirs }),
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(path, 0o600);
}

async function writeIdentity(
  directory: string,
  relay: string,
  sessionId: string,
  room = "demo",
): Promise<string> {
  const sessionsDirectory = join(directory, ".acommune", "sessions");
  await mkdir(sessionsDirectory, { recursive: true, mode: 0o700 });
  const path = join(sessionsDirectory, `${room}.${sessionId}.json`);
  await writeFile(
    path,
    `${JSON.stringify({
      session_name: "cc-project",
      reclaim_token: "r".repeat(48),
      room,
      relay,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

function ownedHookCount(settings: JsonObject, event: string): number {
  assert.ok(isJsonObject(settings.hooks));
  const groups = settings.hooks[event];
  assert.ok(Array.isArray(groups));
  let count = 0;
  for (const group of groups) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) continue;
    for (const handler of group.hooks) {
      if (
        isJsonObject(handler) &&
        typeof handler.command === "string" &&
        handler.command.includes("acommune hook")
      ) {
        count += 1;
      }
    }
  }
  return count;
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

describe("acommune hooks install", () => {
  it("merges, backs up, and idempotently replaces its hook entries", async () => {
    const directory = await tempDirectory();
    await writeConfig(directory, "http://127.0.0.1:4477");
    const claudeDirectory = join(directory, ".claude");
    const settingsPath = join(claudeDirectory, "settings.json");
    const original = {
      theme: "dark",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "run-stop-check" }] }],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "audit-bash" }],
          },
        ],
      },
    };
    await mkdir(claudeDirectory);
    await writeFile(settingsPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const first = await runCli(directory, ["hooks", "install"]);
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /Installed acommune SessionStart and PreToolUse hooks/);
    assert.deepEqual(await jsonObject(`${settingsPath}.bak`), original);

    const firstSettings = await jsonObject(settingsPath);
    assert.equal(firstSettings.theme, "dark");
    assert.ok(isJsonObject(firstSettings.hooks));
    assert.deepEqual(firstSettings.hooks.Stop, original.hooks.Stop);
    assert.equal(ownedHookCount(firstSettings, "SessionStart"), 1);
    assert.equal(ownedHookCount(firstSettings, "PreToolUse"), 1);
    const preToolGroups = firstSettings.hooks.PreToolUse;
    assert.ok(Array.isArray(preToolGroups));
    assert.ok(preToolGroups.some((group) => isJsonObject(group) && group.matcher === "Bash"));
    assert.ok(
      preToolGroups.some(
        (group) => isJsonObject(group) && group.matcher === "Edit|Write|MultiEdit",
      ),
    );

    const firstContent = await readFile(settingsPath, "utf8");
    const second = await runCli(directory, ["hooks", "install"]);
    assert.equal(second.code, 0, second.stderr);
    const secondSettings = await jsonObject(settingsPath);
    assert.equal(ownedHookCount(secondSettings, "SessionStart"), 1);
    assert.equal(ownedHookCount(secondSettings, "PreToolUse"), 1);
    assert.equal(await readFile(settingsPath, "utf8"), firstContent);
  });
});

describe("acommune hook session-start", () => {
  it("joins and writes a private per-session identity", async () => {
    const directory = await tempDirectory();
    const requests: JsonObject[] = [];
    const relay = await fakeRelay(directory, async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/rooms/demo/join");
      requests.push(await requestJson(request));
      sendJson(response, 200, { reclaim_token: "token-one", cursor: 3 });
    }, [{ body: { reclaim_token: "token-one", cursor: 3 } }]);
    await writeConfig(directory, relay.url);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      { session_id: "session-1", cwd: "/Users/tester/project" },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    const recorded = await relay.requests();
    const joinRequests = requests.length > 0
      ? requests
      : recorded.map((request) => request.body).filter(isJsonObject);
    assert.deepEqual(joinRequests, [
      { session_name: "cc-project", pairing_code: "pairing-code" },
    ]);
    const identityPath = join(
      directory,
      ".acommune",
      "sessions",
      "demo.session-1.json",
    );
    assert.deepEqual(await jsonObject(identityPath), {
      session_name: "cc-project",
      reclaim_token: "token-one",
      room: "demo",
      relay: relay.url,
    });
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, ".acommune", "sessions"))).mode & 0o777, 0o700);
  });

  it("skips sessions whose cwd is under a system temp root", async () => {
    const directory = await tempDirectory();
    let requestCount = 0;
    const relay = await fakeRelay(directory, (_request, response) => {
      requestCount += 1;
      sendJson(response, 500, { error: { code: "TEST_FAILURE", message: "unexpected" } });
    }, [{ status: 500, body: { error: { code: "TEST_FAILURE", message: "unexpected" } } }]);
    await writeConfig(directory, relay.url);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      {
        session_id: "session-private-tmp",
        cwd: "/private/tmp/cc-tmp.omaLx76bsP/project",
      },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(requestCount, 0);
    assert.deepEqual(await relay.requests(), []);
    await assert.rejects(
      readFile(join(
        directory,
        ".acommune",
        "sessions",
        "demo.session-private-tmp.json",
      )),
    );
  });

  it("skips sessions whose cwd basename is ephemeral outside a temp root", async () => {
    const directory = await tempDirectory();
    let requestCount = 0;
    const relay = await fakeRelay(directory, (_request, response) => {
      requestCount += 1;
      sendJson(response, 500, { error: { code: "TEST_FAILURE", message: "unexpected" } });
    }, [{ status: 500, body: { error: { code: "TEST_FAILURE", message: "unexpected" } } }]);
    await writeConfig(directory, relay.url);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      { session_id: "session-tmp-basename", cwd: "/Users/tester/tmp.abc123" },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(requestCount, 0);
    assert.deepEqual(await relay.requests(), []);
    await assert.rejects(
      readFile(join(
        directory,
        ".acommune",
        "sessions",
        "demo.session-tmp-basename.json",
      )),
    );
  });

  it("joins temp-directory sessions when join_temp_dirs is enabled", async () => {
    const directory = await tempDirectory();
    const requests: JsonObject[] = [];
    const relay = await fakeRelay(directory, async (request, response) => {
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/rooms/demo/join");
      requests.push(await requestJson(request));
      sendJson(response, 200, { reclaim_token: "token-temp", cursor: 5 });
    }, [{ body: { reclaim_token: "token-temp", cursor: 5 } }]);
    await writeConfig(directory, relay.url, "demo", true);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      {
        session_id: "session-temp-enabled",
        cwd: "/private/tmp/cc-tmp.override/project",
      },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    const recorded = await relay.requests();
    const joinRequests = requests.length > 0
      ? requests
      : recorded.map((request) => request.body).filter(isJsonObject);
    assert.deepEqual(joinRequests, [
      { session_name: "cc-project", pairing_code: "pairing-code" },
    ]);
    const identityPath = join(
      directory,
      ".acommune",
      "sessions",
      "demo.session-temp-enabled.json",
    );
    assert.deepEqual(await jsonObject(identityPath), {
      session_name: "cc-project",
      reclaim_token: "token-temp",
      room: "demo",
      relay: relay.url,
    });
    assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
    assert.equal((await stat(join(directory, ".acommune", "sessions"))).mode & 0o777, 0o700);
  });

  it("retries AGENT_NAME_IN_USE with a numeric suffix", async () => {
    const directory = await tempDirectory();
    const names: string[] = [];
    const relay = await fakeRelay(directory, async (request, response) => {
      const body = await requestJson(request);
      if (typeof body.session_name !== "string") throw new Error("Missing session name");
      names.push(body.session_name);
      if (names.length === 1) {
        sendJson(response, 409, {
          error: { code: "AGENT_NAME_IN_USE", message: "already in use" },
        });
      } else {
        sendJson(response, 200, { reclaim_token: "token-two", cursor: 4 });
      }
    }, [
      {
        status: 409,
        body: { error: { code: "AGENT_NAME_IN_USE", message: "already in use" } },
      },
      { body: { reclaim_token: "token-two", cursor: 4 } },
    ]);
    await writeConfig(directory, relay.url);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      { session_id: "session-2", cwd: "/Users/tester/project" },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    const recorded = await relay.requests();
    const joinedNames = names.length > 0
      ? names
      : recorded.flatMap((request) =>
          isJsonObject(request.body) && typeof request.body.session_name === "string"
            ? [request.body.session_name]
            : [],
        );
    assert.deepEqual(joinedNames, ["cc-project", "cc-project-2"]);
    const identity = await jsonObject(
      join(directory, ".acommune", "sessions", "demo.session-2.json"),
    );
    assert.equal(identity.session_name, "cc-project-2");
  });

  it("fails open and silently when the relay is unreachable", async () => {
    const directory = await tempDirectory();
    const relay = await unreachableRelay(directory);
    await writeConfig(directory, relay.url);

    const result = await runCli(
      directory,
      ["hook", "session-start"],
      { session_id: "session-down", cwd: "/Users/tester/project" },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    await assert.rejects(
      readFile(join(directory, ".acommune", "sessions", "demo.session-down.json")),
    );
  });
});

describe("acommune hook claim", () => {
  it("uses a fresh local cache entry without contacting the relay", async () => {
    const directory = await tempDirectory();
    let requestCount = 0;
    const relay = await fakeRelay(directory, (_request, response) => {
      requestCount += 1;
      sendJson(response, 500, { error: { code: "TEST_FAILURE", message: "unexpected" } });
    }, [{ status: 500, body: { error: { code: "TEST_FAILURE", message: "unexpected" } } }]);
    await writeConfig(directory, relay.url);
    await writeIdentity(directory, relay.url, "cached-session");
    const path = join(directory, "src", "cached.ts");
    await writeFile(
      join(directory, ".acommune", "claims-demo.json"),
      `${JSON.stringify({ [`cached-session|${path}`]: Date.now() })}\n`,
      "utf8",
    );

    const result = await runCli(
      directory,
      ["hook", "claim"],
      { session_id: "cached-session", tool_input: { file_path: path } },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    assert.equal(requestCount, 0);
    assert.deepEqual(await relay.requests(), []);
  });

  it("emits a fixed, single-line warning with a sanitized bounded name", async () => {
    const directory = await tempDirectory();
    const maliciousName = `evil\n${"x".repeat(80)}`;
    const refreshedAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const claimsBody = {
      claims: [
        {
          session_name: maliciousName,
          path: "/relay-controlled/path",
          claim_seq: 7,
          refreshed_at: refreshedAt,
          expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        },
      ],
    };
    const relay = await fakeRelay(directory, (_request, response) => {
      sendJson(response, 200, {
        ...claimsBody,
      });
    }, [{ body: claimsBody }]);
    await writeConfig(directory, relay.url);
    await writeIdentity(directory, relay.url, "warning-session");
    const path = join(directory, "src", "warning.ts");

    const result = await runCli(
      directory,
      ["hook", "claim"],
      { session_id: "warning-session", tool_input: { file_path: path } },
      relay.environment,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    const output: unknown = JSON.parse(result.stdout);
    assert.ok(isJsonObject(output));
    assert.ok(isJsonObject(output.hookSpecificOutput));
    assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(output.hookSpecificOutput.permissionDecision, "allow");
    const reason = output.hookSpecificOutput.permissionDecisionReason;
    if (typeof reason !== "string") throw new Error("Missing warning reason");
    assert.doesNotMatch(reason, /[\n\r\t]/);
    const sanitizedName = `evil${"x".repeat(36)}`;
    assert.match(
      reason,
      new RegExp(
        `^acommune: "${sanitizedName}" claimed ${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\d+m ago — coordinate on the bus before editing\\.$`,
      ),
    );
    assert.doesNotMatch(reason, /relay-controlled/);
    assert.ok(reason.length < 300);
  });

  it("posts a claim and records it in the cache when there is no conflict", async () => {
    const directory = await tempDirectory();
    const requests: Array<{ method: string; url: string; body?: JsonObject }> = [];
    const relay = await fakeRelay(directory, async (request, response) => {
      if (request.method === "GET") {
        requests.push({ method: "GET", url: request.url ?? "" });
        assert.equal(request.headers["x-acommune-code"], "pairing-code");
        sendJson(response, 200, { claims: [] });
        return;
      }
      const body = await requestJson(request);
      requests.push({ method: request.method ?? "", url: request.url ?? "", body });
      sendJson(response, 200, {
        received: [],
        sent: [],
        cursor: 8,
        status: "empty",
      });
    }, [
      { body: { claims: [] } },
      { body: { received: [], sent: [], cursor: 8, status: "empty" } },
    ]);
    await writeConfig(directory, relay.url);
    await writeIdentity(directory, relay.url, "claim-session");
    const path = join(directory, "src", "claim.ts");

    const result = await runCli(
      directory,
      ["hook", "claim"],
      { session_id: "claim-session", tool_input: { file_path: path } },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
    const recorded = await relay.requests();
    const observedRequests = requests.length > 0
      ? requests
      : recorded.map((request) => ({
          method: request.method,
          url: new URL(request.url).pathname + new URL(request.url).search,
          ...(isJsonObject(request.body) ? { body: request.body } : {}),
        }));
    assert.equal(observedRequests.length, 2);
    assert.equal(observedRequests[0]?.method, "GET");
    const claimsUrl = new URL(observedRequests[0]?.url ?? "", relay.url);
    assert.equal(claimsUrl.pathname, "/rooms/demo/claims");
    assert.equal(claimsUrl.searchParams.get("file"), path);
    assert.equal(observedRequests[1]?.method, "POST");
    assert.equal(observedRequests[1]?.url, "/rooms/demo/sync");
    assert.deepEqual(observedRequests[1]?.body, {
      session_name: "cc-project",
      reclaim_token: "r".repeat(48),
      outbox: [
        {
          kind: "claim",
          body: { summary: `editing ${basename(path)}`, files: [path] },
        },
      ],
      wait_seconds: 0,
    });
    const cache = await jsonObject(join(directory, ".acommune", "claims-demo.json"));
    assert.equal(typeof cache[`claim-session|${path}`], "number");
  });

  it("fails open and silently when the relay is unreachable", async () => {
    const directory = await tempDirectory();
    const relay = await unreachableRelay(directory);
    await writeConfig(directory, relay.url);
    await writeIdentity(directory, relay.url, "down-session");

    const result = await runCli(
      directory,
      ["hook", "claim"],
      {
        session_id: "down-session",
        tool_input: { file_path: join(directory, "src", "down.ts") },
      },
      relay.environment,
    );

    assert.deepEqual(result, { code: 0, stdout: "", stderr: "" });
  });
});
