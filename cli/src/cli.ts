#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";

const DEFAULT_RELAY_URL = "http://127.0.0.1:4477";
const USAGE = `Usage:
  acommune join <room> --code <code> [--relay <url>] [--name <session_name>] [--config <path>]
  acommune --help
  acommune --version`;

interface JoinOptions {
  room: string;
  code: string;
  relay: string;
  name?: string;
  config?: string;
}

type JsonObject = Record<string, unknown>;

class CliError extends Error {}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readVersion(): Promise<string> {
  const packagePath = resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
  const parsed: unknown = JSON.parse(await readFile(packagePath, "utf8"));
  if (!isJsonObject(parsed) || typeof parsed.version !== "string") {
    throw new CliError(`Could not read the acommune version from ${packagePath}.`);
  }
  return parsed.version;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new CliError(`${flag} needs a value.`);
  }
  return value;
}

function parseJoin(args: readonly string[]): JoinOptions {
  const room = args[0];
  if (room === undefined || room.startsWith("-")) {
    throw new CliError("join needs a room name.");
  }

  let code: string | undefined;
  let relay = DEFAULT_RELAY_URL;
  let name: string | undefined;
  let config: string | undefined;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);
    const value = (): string => {
      if (inlineValue !== undefined) {
        if (inlineValue === "") throw new CliError(`${flag} needs a value.`);
        return inlineValue;
      }
      index += 1;
      return readFlagValue(args, index - 1, flag);
    };

    switch (flag) {
      case "--code":
        code = value();
        break;
      case "--relay":
        relay = value();
        break;
      case "--name":
        name = value();
        break;
      case "--config":
        config = value();
        break;
      default:
        throw new CliError(
          argument.startsWith("-")
            ? `Unknown option: ${argument}`
            : `Unexpected argument: ${argument}`,
        );
    }
  }

  if (code === undefined || code.trim() === "") {
    throw new CliError("join requires --code <code>.");
  }
  if (room.trim() === "") throw new CliError("Room name cannot be empty.");

  let relayUrl: URL;
  try {
    relayUrl = new URL(relay);
  } catch {
    throw new CliError(`Invalid relay URL: ${relay}`);
  }
  if (relayUrl.protocol !== "http:" && relayUrl.protocol !== "https:") {
    throw new CliError("Relay URL must start with http:// or https://.");
  }

  return {
    room: room.trim(),
    code,
    relay: relay.replace(/\/+$/, ""),
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : { config }),
  };
}

async function resolveConfigPath(override?: string): Promise<string> {
  if (override !== undefined) return resolve(expandHome(override));
  const claudeConfig = join(homedir(), ".claude.json");
  if (await isFile(claudeConfig)) return claudeConfig;
  return join(process.cwd(), ".mcp.json");
}

async function packageBinCandidate(packageJsonPath: string): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(packageJsonPath, "utf8"));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.bin)) return undefined;
    const bin = parsed.bin["acommune-mcp"];
    return typeof bin === "string" ? resolve(dirname(packageJsonPath), bin) : undefined;
  } catch {
    return undefined;
  }
}

async function resolveMcpServer(): Promise<string> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const candidates: Array<string | undefined> = [
    resolve(cliDirectory, "../../mcp/dist/server.js"),
    resolve(cliDirectory, "../../acommune-mcp/dist/server.js"),
    resolve(process.cwd(), "mcp/dist/server.js"),
    resolve(process.cwd(), "node_modules/acommune-mcp/dist/server.js"),
  ];

  const require = createRequire(import.meta.url);
  try {
    candidates.push(require.resolve("acommune-mcp"));
  } catch {
    // The repository and explicit node_modules candidates still apply.
  }
  try {
    const packageJsonPath = require.resolve("acommune-mcp/package.json");
    candidates.push(await packageBinCandidate(packageJsonPath));
  } catch {
    // A package with restrictive exports may still have resolved through its main entry.
  }

  for (const candidate of candidates) {
    if (candidate !== undefined && isAbsolute(candidate) && (await isFile(candidate))) {
      return candidate;
    }
  }
  throw new CliError(
    "Could not find the acommune-mcp server. Build or install acommune-mcp, then set your MCP server args path to its absolute dist/server.js file.",
  );
}

async function readConfig(configPath: string): Promise<{ config: JsonObject; exists: boolean; raw?: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error: unknown) {
    if (isJsonObject(error) && error.code === "ENOENT") {
      return { config: {}, exists: false };
    }
    throw new CliError(`Could not read config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CliError(`Config ${configPath} is not valid JSON. Nothing was changed.`);
  }
  if (!isJsonObject(parsed)) {
    throw new CliError(`Config ${configPath} must contain a JSON object. Nothing was changed.`);
  }
  return { config: parsed, exists: true, raw };
}

async function writeConfig(
  configPath: string,
  mcpServerPath: string,
  relay: string,
): Promise<void> {
  const current = await readConfig(configPath);
  const existingServers = current.config.mcpServers;
  if (existingServers !== undefined && !isJsonObject(existingServers)) {
    throw new CliError(`Config ${configPath} has a non-object mcpServers value. Nothing was changed.`);
  }

  const nextServers: JsonObject = {
    ...(existingServers ?? {}),
    acommune: {
      command: "node",
      args: [mcpServerPath],
      env: { RELAY_URL: relay },
    },
  };
  const nextConfig: JsonObject = { ...current.config, mcpServers: nextServers };

  await mkdir(dirname(configPath), { recursive: true });
  if (current.exists) await copyFile(configPath, `${configPath}.bak`);
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf8");
    await rename(temporary, configPath);
  } catch (error: unknown) {
    throw new CliError(`Could not write config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function rememberRoom(room: string, relay: string): Promise<void> {
  const directory = join(homedir(), ".acommune");
  const roomsPath = join(directory, "rooms.json");
  let rooms: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(roomsPath, "utf8"));
    if (isJsonObject(parsed)) rooms = parsed;
  } catch {
    // This convenience note must never prevent MCP configuration.
  }
  rooms[room] = { relay };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${roomsPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(rooms, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, roomsPath);
  await chmod(roomsPath, 0o600);
}

async function joinRoom(options: JoinOptions): Promise<void> {
  const configPath = await resolveConfigPath(options.config);
  const mcpServerPath = await resolveMcpServer();
  await writeConfig(configPath, mcpServerPath, options.relay);
  try {
    await rememberRoom(options.room, options.relay);
  } catch (error: unknown) {
    process.stderr.write(
      `Warning: could not save the room note: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }

  const nameArgument = options.name === undefined ? "" : ` name=${JSON.stringify(options.name)}`;
  process.stdout.write(
    `Added acommune to ${configPath}.\n` +
      `Relay: ${options.relay}\n` +
      `Restart Claude Code, then in your session run: bus_join room=${JSON.stringify(options.room)} code=${JSON.stringify(options.code)}${nameArgument}  — you'll be in #${options.room}.\n`,
  );
}

async function main(args: readonly string[]): Promise<void> {
  const command = args[0];
  if (command === undefined || command === "--help" || command === "-h") {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (command === "--version") {
    process.stdout.write(`${await readVersion()}\n`);
    return;
  }
  if (command !== "join") throw new CliError(`Unknown command: ${command}`);
  await joinRoom(parseJoin(args.slice(1)));
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n\n${USAGE}\n`);
  process.exitCode = 1;
});
