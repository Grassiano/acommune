import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { decodeInvite, encodeInvite } from "acommune-shared";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cliPath = resolve(process.cwd(), "dist/cli.js");
const fetchMockPath = resolve(process.cwd(), ".test-dist/test/fetch-mock.js");
const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-cli-test-"));
  directories.push(directory);
  return directory;
}

async function runCli(
  directory: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = {},
): Promise<RunResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: directory,
      env: { ...process.env, ...environment, HOME: directory },
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
    child.on("close", (code) => {
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
  });
}

function fetchEnvironment(
  directory: string,
  responses: readonly Record<string, unknown>[],
): { environment: NodeJS.ProcessEnv; logPath: string } {
  const logPath = join(directory, "fetch.jsonl");
  return {
    environment: {
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchMockPath}`]
        .filter((part) => part !== undefined && part !== "")
        .join(" "),
      ACOMMUNE_TEST_FETCH_RESPONSES: JSON.stringify(responses),
      ACOMMUNE_TEST_FETCH_LOG: logPath,
    },
    logPath,
  };
}

function inviteTokenFromOutput(output: string): string {
  const match = /npx acommune join (acm1_[A-Za-z0-9_-]+)/.exec(output);
  assert.ok(match !== null);
  return match[1]!;
}

async function jsonObject(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("acommune join", () => {
  it("writes the acommune MCP server entry", async () => {
    const directory = await tempDirectory();
    const configPath = join(directory, "claude.json");
    await writeFile(configPath, "{}\n", "utf8");

    const result = await runCli(directory, [
      "join",
      "demo",
      "--code",
      "abc123",
      "--relay",
      "http://localhost:4477",
      "--config",
      configPath,
    ]);

    assert.equal(result.code, 0, result.stderr);
    const config = await jsonObject(configPath);
    const servers = config.mcpServers as Record<string, unknown>;
    const acommune = servers.acommune as Record<string, unknown>;
    assert.equal(acommune.command, "node");
    const args = acommune.args as unknown[];
    assert.equal(args.length, 1);
    assert.equal(typeof args[0], "string");
    assert.ok((args[0] as string).endsWith("/mcp/dist/server.js"));
    await access(args[0] as string);
    assert.deepEqual(acommune.env, { RELAY_URL: "http://localhost:4477" });
  });

  it("preserves existing config and other MCP servers", async () => {
    const directory = await tempDirectory();
    const configPath = join(directory, "claude.json");
    const original = {
      theme: "dark",
      mcpServers: {
        existing: { command: "existing-command", args: ["one"] },
        acommune: { command: "old-command" },
      },
    };
    await writeFile(configPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");

    const result = await runCli(directory, ["join", "nightbuild", "--code", "7H2K", "--config", configPath]);

    assert.equal(result.code, 0, result.stderr);
    const config = await jsonObject(configPath);
    assert.equal(config.theme, "dark");
    const servers = config.mcpServers as Record<string, unknown>;
    assert.deepEqual(servers.existing, original.mcpServers.existing);
    assert.notDeepEqual(servers.acommune, original.mcpServers.acommune);
  });

  it("refuses invalid existing JSON without changing it", async () => {
    const directory = await tempDirectory();
    const configPath = join(directory, "claude.json");
    const original = "{ definitely not json\n";
    await writeFile(configPath, original, "utf8");

    const result = await runCli(directory, ["join", "demo", "--code", "abc123", "--config", configPath]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /is not valid JSON\. Nothing was changed\./);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(access(`${configPath}.bak`));
  });

  it("reports a friendly error when --code is missing", async () => {
    const directory = await tempDirectory();
    const result = await runCli(directory, ["join", "demo"]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /join requires --code <code>/);
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /\n\s+at /);
  });

  it("backs up the original config before replacing it", async () => {
    const directory = await tempDirectory();
    const configPath = join(directory, "claude.json");
    const original = '{"keep":true}\n';
    await writeFile(configPath, original, "utf8");

    const result = await runCli(directory, ["join", "demo", "--code", "abc123", "--config", configPath]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(`${configPath}.bak`, "utf8"), original);
  });
});

describe("one-line onboarding", () => {
  it("creates a room, writes local config, and prints a decodable invite", async () => {
    const directory = await tempDirectory();
    const relay = "https://relay.example.com";
    const mock = fetchEnvironment(directory, [
      { status: 201, body: { room_id: "room-id", name: "demo", pairing_code: "abcdef123456" } },
    ]);

    const result = await runCli(
      directory,
      ["create", "demo", "--relay", relay],
      mock.environment,
    );

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await jsonObject(join(directory, ".acommune", "config.json")), {
      relay,
      room: "demo",
      code: "abcdef123456",
    });
    assert.deepEqual(decodeInvite(inviteTokenFromOutput(result.stdout)), {
      relay,
      room: "demo",
      code: "abcdef123456",
    });
    const request = await readFile(mock.logPath, "utf8");
    assert.match(request, /"method":"POST"/);
    assert.match(request, /"url":"https:\/\/relay\.example\.com\/rooms"/);
    assert.match(request, /"body":\{"name":"demo"\}/);
  });

  it("refuses an existing room response that does not include a code", async () => {
    const directory = await tempDirectory();
    const relay = "https://relay.example.com";
    const mock = fetchEnvironment(directory, [
      { status: 200, body: { room_id: "room-id", name: "demo" } },
    ]);

    const result = await runCli(
      directory,
      ["create", "demo", "--relay", relay],
      mock.environment,
    );

    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      `Room "demo" already exists on ${relay} — I don't have its code. Get the invite from someone who has it, or if you own this relay run \`acommune rotate --room demo\` from a machine whose config already has the code.\n`,
    );
    await assert.rejects(access(join(directory, ".acommune", "config.json")));
  });

  it("maps the relay's ROOM_NAME_TAKEN response to the no-code guidance", async () => {
    const directory = await tempDirectory();
    const relay = "https://relay.example.com";
    const mock = fetchEnvironment(directory, [
      {
        status: 409,
        body: { error: { code: "ROOM_NAME_TAKEN", message: "Room name is already in use" } },
      },
    ]);

    const result = await runCli(
      directory,
      ["create", "demo", "--relay", relay],
      mock.environment,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /^Room "demo" already exists/);
    await assert.rejects(access(join(directory, ".acommune", "config.json")));
  });

  it("joins an invite by writing local config and merging the MCP server", async () => {
    const directory = await tempDirectory();
    const claudePath = join(directory, ".claude.json");
    await writeFile(claudePath, '{"theme":"dark"}\n', "utf8");
    const invite = {
      relay: "https://relay.example.com",
      room: "demo",
      code: "abcdef123456",
    };

    const result = await runCli(directory, ["join", encodeInvite(invite)]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      'Joined "demo". Run /bus in a session, or the hooks will auto-join new sessions.\n',
    );
    assert.deepEqual(await jsonObject(join(directory, ".acommune", "config.json")), invite);
    const claude = await jsonObject(claudePath);
    assert.equal(claude.theme, "dark");
    const servers = claude.mcpServers as Record<string, unknown>;
    const acommune = servers.acommune as Record<string, unknown>;
    assert.deepEqual(acommune.env, { RELAY_URL: invite.relay });
  });

  it("refuses to replace a different configured room without --force", async () => {
    const directory = await tempDirectory();
    const configDirectory = join(directory, ".acommune");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    const original = '{"relay":"https://old.example.com","room":"old-room","code":"old-code"}\n';
    await writeFile(configPath, original, "utf8");

    const result = await runCli(directory, ["join", encodeInvite({
      relay: "https://new.example.com",
      room: "new-room",
      code: "new-code",
    })]);

    assert.equal(result.code, 1);
    assert.match(result.stderr, /room "old-room", not "new-room".*--force/i);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(access(`${configPath}.bak`));
  });

  it("replaces a different room with --force and backs up the old config", async () => {
    const directory = await tempDirectory();
    const configDirectory = join(directory, ".acommune");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    const original = '{"relay":"https://old.example.com","room":"old-room","code":"old-code"}\n';
    await writeFile(configPath, original, "utf8");
    await writeFile(join(directory, ".claude.json"), "{}\n", "utf8");
    const invite = {
      relay: "https://new.example.com",
      room: "new-room",
      code: "new-code",
    };

    const result = await runCli(directory, ["join", encodeInvite(invite), "--force"]);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(await jsonObject(configPath), invite);
    assert.equal(await readFile(`${configPath}.bak`, "utf8"), original);
  });

  it("rotates with the current code and saves the client-generated replacement", async () => {
    const directory = await tempDirectory();
    const configDirectory = join(directory, ".acommune");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    const relay = "https://relay.example.com";
    await writeFile(configPath, `${JSON.stringify({ relay, room: "demo", code: "current-code" })}\n`, "utf8");
    const mock = fetchEnvironment(directory, [{ status: 200, body: { ok: true } }]);

    const result = await runCli(directory, ["rotate"], mock.environment);

    assert.equal(result.code, 0, result.stderr);
    const requestLine = (await readFile(mock.logPath, "utf8")).trim();
    const request: unknown = JSON.parse(requestLine);
    assert.ok(typeof request === "object" && request !== null && !Array.isArray(request));
    const record = request as Record<string, unknown>;
    assert.equal(record.url, `${relay}/rooms/demo/rotate-code`);
    assert.deepEqual(record.headers, {
      "content-type": "application/json",
      "x-acommune-code": "current-code",
    });
    const body = record.body as Record<string, unknown>;
    assert.equal(typeof body.new_code, "string");
    assert.ok((body.new_code as string).length >= 12);
    const nextConfig = await jsonObject(configPath);
    assert.equal(nextConfig.code, body.new_code);
    const printedInvite = decodeInvite(inviteTokenFromOutput(result.stdout));
    assert.deepEqual(printedInvite, {
      relay,
      room: "demo",
      code: body.new_code,
    });
  });

  it("rejects a mismatched rotate guard before making an HTTP request", async () => {
    const directory = await tempDirectory();
    const configDirectory = join(directory, ".acommune");
    await mkdir(configDirectory, { recursive: true });
    const configPath = join(configDirectory, "config.json");
    const original = '{"relay":"https://relay.example.com","room":"demo","code":"current-code"}\n';
    await writeFile(configPath, original, "utf8");
    const mock = fetchEnvironment(directory, [{ status: 200, body: { ok: true } }]);

    const result = await runCli(
      directory,
      ["rotate", "--room", "other-room"],
      mock.environment,
    );

    assert.equal(result.code, 1);
    assert.match(result.stderr, /config is for room "demo", not "other-room"/i);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(access(mock.logPath));
  });
});
