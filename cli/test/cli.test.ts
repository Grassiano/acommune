import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { afterEach, describe, it } from "node:test";

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const cliPath = resolve(process.cwd(), "dist/cli.js");
const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-cli-test-"));
  directories.push(directory);
  return directory;
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
    child.on("close", (code) => {
      resolveResult({ code: code ?? -1, stdout, stderr });
    });
  });
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
