#!/usr/bin/env node
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";

const DEFAULT_RELAY_URL = "http://127.0.0.1:4477";
const HOOK_HTTP_TIMEOUT_MS = 2_000;
const CLAIM_CACHE_FRESH_MS = 10 * 60 * 1_000;
const CLAIM_CACHE_MAX_AGE_MS = 60 * 60 * 1_000;
const HOOK_COMMAND_MARKER = "acommune hook";
const USAGE = `Usage:
  acommune join <room> --code <code> [--relay <url>] [--name <session_name>] [--config <path>]
  acommune hooks install [--project <dir> | --user]
  acommune hook <session-start | claim>  (internal)
  acommune --help
  acommune --version`;

interface JoinOptions {
  room: string;
  code: string;
  relay: string;
  name?: string;
  config?: string;
}

interface HooksInstallOptions {
  project?: string;
  user: boolean;
}

interface AcommuneConfig {
  relay: string;
  room: string;
  code: string;
  sessionNamePrefix?: string;
  joinTempDirs?: boolean;
}

interface SessionIdentity {
  sessionName: string;
  reclaimToken: string;
  room: string;
  relay: string;
}

interface ActiveClaim {
  sessionName: string;
  refreshedAt: string;
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

function parseHooksInstall(args: readonly string[]): HooksInstallOptions {
  let project: string | undefined;
  let user = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    const inlineValue = equals === -1 ? undefined : argument.slice(equals + 1);

    if (flag === "--project") {
      if (project !== undefined) throw new CliError("--project can only be specified once.");
      if (inlineValue !== undefined) {
        if (inlineValue === "") throw new CliError("--project needs a value.");
        project = inlineValue;
      } else {
        index += 1;
        project = readFlagValue(args, index - 1, flag);
      }
      continue;
    }
    if (argument === "--user") {
      user = true;
      continue;
    }
    throw new CliError(
      argument.startsWith("-")
        ? `Unknown option: ${argument}`
        : `Unexpected argument: ${argument}`,
    );
  }

  if (project !== undefined && user) {
    throw new CliError("--project and --user cannot be used together.");
  }
  return { ...(project === undefined ? {} : { project }), user };
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

async function readConfig(
  configPath: string,
): Promise<{ config: JsonObject; exists: boolean; mode?: number }> {
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
  const mode = (await stat(configPath)).mode & 0o777;
  return { config: parsed, exists: true, mode };
}

function configPath(): string {
  return join(homedir(), ".acommune", "config.json");
}

async function loadAcommuneConfig(): Promise<AcommuneConfig> {
  const path = configPath();
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new CliError(
      `No acommune config found at ${path}. Run \`acommune join <room> --code <code>\` first.`,
    );
  }
  if (
    !isJsonObject(parsed) ||
    typeof parsed.relay !== "string" ||
    typeof parsed.room !== "string" ||
    typeof parsed.code !== "string" ||
    parsed.relay.length === 0 ||
    parsed.room.length === 0 ||
    parsed.code.length === 0 ||
    (parsed.session_name_prefix !== undefined &&
      typeof parsed.session_name_prefix !== "string")
  ) {
    throw new CliError(
      `No acommune config found at ${path}. Run \`acommune join <room> --code <code>\` first.`,
    );
  }

  let relay: URL;
  try {
    relay = new URL(parsed.relay);
  } catch {
    throw new CliError(
      `No acommune config found at ${path}. Run \`acommune join <room> --code <code>\` first.`,
    );
  }
  if (relay.protocol !== "http:" && relay.protocol !== "https:") {
    throw new CliError(
      `No acommune config found at ${path}. Run \`acommune join <room> --code <code>\` first.`,
    );
  }

  return {
    relay: parsed.relay.replace(/\/+$/, ""),
    room: parsed.room,
    code: parsed.code,
    ...(parsed.session_name_prefix === undefined
      ? {}
      : { sessionNamePrefix: parsed.session_name_prefix }),
    ...(typeof parsed.join_temp_dirs === "boolean"
      ? { joinTempDirs: parsed.join_temp_dirs }
      : {}),
  };
}

function resolveCliEntry(): string {
  // Hooks run without relying on PATH, so point Node at this built module itself.
  return resolve(dirname(fileURLToPath(import.meta.url)), "cli.js");
}

function hookCommand(name: "session-start" | "claim"): string {
  return `node ${JSON.stringify(resolveCliEntry())} hook ${name} # ${HOOK_COMMAND_MARKER} ${name}`;
}

function withoutOwnedHookHandlers(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  const groups: unknown[] = [];
  for (const group of value) {
    if (!isJsonObject(group) || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const hooks = group.hooks.filter(
      (handler) =>
        !isJsonObject(handler) ||
        typeof handler.command !== "string" ||
        !handler.command.includes(HOOK_COMMAND_MARKER),
    );
    if (hooks.length > 0) groups.push({ ...group, hooks });
  }
  return groups;
}

async function installHooks(options: HooksInstallOptions): Promise<void> {
  await loadAcommuneConfig();
  const root = options.user
    ? homedir()
    : resolve(expandHome(options.project ?? process.cwd()));
  const settingsPath = join(root, ".claude", "settings.json");
  const current = await readConfig(settingsPath);
  const existingHooks = current.config.hooks;
  if (existingHooks !== undefined && !isJsonObject(existingHooks)) {
    throw new CliError(
      `Config ${settingsPath} has a non-object hooks value. Nothing was changed.`,
    );
  }
  if (
    existingHooks !== undefined &&
    ((existingHooks.SessionStart !== undefined &&
      !Array.isArray(existingHooks.SessionStart)) ||
      (existingHooks.PreToolUse !== undefined &&
        !Array.isArray(existingHooks.PreToolUse)))
  ) {
    throw new CliError(
      `Config ${settingsPath} has an invalid acommune hook event value. Nothing was changed.`,
    );
  }

  const hooks: JsonObject = { ...(existingHooks ?? {}) };
  hooks.SessionStart = [
    ...withoutOwnedHookHandlers(hooks.SessionStart),
    {
      hooks: [{ type: "command", command: hookCommand("session-start") }],
    },
  ];
  hooks.PreToolUse = [
    ...withoutOwnedHookHandlers(hooks.PreToolUse),
    {
      matcher: "Edit|Write|MultiEdit",
      hooks: [{ type: "command", command: hookCommand("claim") }],
    },
  ];
  const nextConfig: JsonObject = { ...current.config, hooks };

  await mkdir(dirname(settingsPath), { recursive: true });
  if (current.exists) {
    await copyFile(settingsPath, `${settingsPath}.bak`);
    if (current.mode !== undefined) await chmod(`${settingsPath}.bak`, current.mode);
  }
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: current.mode ?? 0o600,
    });
    await rename(temporary, settingsPath);
  } catch (error: unknown) {
    throw new CliError(
      `Could not write config ${settingsPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  process.stdout.write(`Installed acommune SessionStart and PreToolUse hooks in ${settingsPath}.\n`);
}

async function readStdinJson(): Promise<JsonObject> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<unknown>) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
    } else if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk));
    } else {
      throw new Error("Unexpected stdin input");
    }
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isJsonObject(parsed)) throw new Error("Hook input must be an object");
  return parsed;
}

async function fetchBeforeDeadline(
  url: string | URL,
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Hook request timed out");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function responseJson(response: Response): Promise<JsonObject> {
  const parsed: unknown = await response.json();
  if (!isJsonObject(parsed)) throw new Error("Relay response must be an object");
  return parsed;
}

function relayErrorCode(value: JsonObject): string | undefined {
  return isJsonObject(value.error) && typeof value.error.code === "string"
    ? value.error.code
    : undefined;
}

function isSafeFilePart(value: string): boolean {
  return value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\");
}

function sessionIdentityPath(room: string, sessionId: string): string {
  if (!isSafeFilePart(room) || !isSafeFilePart(sessionId)) {
    throw new Error("Unsafe session identity name");
  }
  return join(homedir(), ".acommune", "sessions", `${room}.${sessionId}.json`);
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const acommuneDirectory = join(homedir(), ".acommune");
  await chmod(acommuneDirectory, 0o700);
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    try {
      await unlink(temporary);
    } catch {
      // The temporary file may not have been created.
    }
    throw error;
  }
}

function isEphemeralSessionCwd(cwd: string, environment: NodeJS.ProcessEnv): boolean {
  const normalizedCwd = resolve(cwd).replace(/\\/g, "/");
  const tempRoots = ["/tmp/", "/private/tmp/", "/var/folders/"];
  if (environment.TMPDIR !== undefined && environment.TMPDIR.length > 0) {
    tempRoots.push(`${environment.TMPDIR.replace(/\\/g, "/").replace(/\/+$/, "")}/`);
  }

  // Prefix matching intentionally treats every directory beneath a temp root as ephemeral.
  return (
    tempRoots.some((root) => normalizedCwd.startsWith(root)) ||
    /^tmp\.|^\.tmp|^scratchpad$/i.test(basename(normalizedCwd))
  );
}

async function runSessionStartHook(): Promise<void> {
  try {
    const input = await readStdinJson();
    if (typeof input.session_id !== "string" || typeof input.cwd !== "string") return;
    const config = await loadAcommuneConfig();
    if (config.joinTempDirs !== true && isEphemeralSessionCwd(input.cwd, process.env)) return;
    const deadline = Date.now() + HOOK_HTTP_TIMEOUT_MS;
    const baseName = `${config.sessionNamePrefix ?? "cc"}-${basename(input.cwd)}`;

    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const sessionName = attempt === 1 ? baseName : `${baseName}-${attempt}`;
      const response = await fetchBeforeDeadline(
        `${config.relay}/rooms/${encodeURIComponent(config.room)}/join`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            session_name: sessionName,
            pairing_code: config.code,
          }),
        },
        deadline,
      );
      const result = await responseJson(response);
      if (response.ok) {
        if (typeof result.reclaim_token !== "string" || typeof result.cursor !== "number") {
          throw new Error("Invalid join response");
        }
        await writePrivateJson(
          sessionIdentityPath(config.room, input.session_id),
          {
            session_name: sessionName,
            reclaim_token: result.reclaim_token,
            room: config.room,
            relay: config.relay,
          },
        );
        return;
      }
      if (response.status !== 409 || relayErrorCode(result) !== "AGENT_NAME_IN_USE") {
        throw new Error("Relay rejected session join");
      }
    }
  } catch {
    // Session hooks always fail open and must not add transcript noise.
  }
  process.exitCode = 0;
}

async function loadSessionIdentity(path: string): Promise<SessionIdentity> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (
    !isJsonObject(parsed) ||
    typeof parsed.session_name !== "string" ||
    typeof parsed.reclaim_token !== "string" ||
    typeof parsed.room !== "string" ||
    typeof parsed.relay !== "string"
  ) {
    throw new Error("Invalid session identity");
  }
  return {
    sessionName: parsed.session_name,
    reclaimToken: parsed.reclaim_token,
    room: parsed.room,
    relay: parsed.relay,
  };
}

function cachePath(room: string): string {
  if (!isSafeFilePart(room)) throw new Error("Unsafe claim cache name");
  return join(homedir(), ".acommune", `claims-${room}.json`);
}

async function readClaimCache(path: string): Promise<Record<string, number>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isJsonObject(parsed)) return {};
    const entries = Object.entries(parsed).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]),
    );
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function parseClaims(value: JsonObject): ActiveClaim[] {
  if (!Array.isArray(value.claims)) throw new Error("Invalid claims response");
  return value.claims.map((claim) => {
    if (
      !isJsonObject(claim) ||
      typeof claim.session_name !== "string" ||
      typeof claim.path !== "string" ||
      typeof claim.claim_seq !== "number" ||
      typeof claim.refreshed_at !== "string" ||
      typeof claim.expires_at !== "string" ||
      !Number.isFinite(Date.parse(claim.refreshed_at)) ||
      !Number.isFinite(Date.parse(claim.expires_at))
    ) {
      throw new Error("Invalid claim entry");
    }
    return { sessionName: claim.session_name, refreshedAt: claim.refreshed_at };
  });
}

function sanitized(value: string, maximumLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").slice(0, maximumLength);
}

function conflictWarning(claim: ActiveClaim, path: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(claim.refreshedAt)) / 60_000));
  return `acommune: "${sanitized(claim.sessionName, 40)}" claimed ${sanitized(path, 200)} ${minutes}m ago — coordinate on the bus before editing.`;
}

function validateSyncResponse(value: JsonObject): void {
  if (
    !Array.isArray(value.received) ||
    !Array.isArray(value.sent) ||
    typeof value.cursor !== "number" ||
    !Number.isFinite(value.cursor) ||
    (value.status !== "ready" && value.status !== "timeout" && value.status !== "empty")
  ) {
    throw new Error("Invalid sync response");
  }
}

async function runClaimHook(): Promise<void> {
  try {
    const input = await readStdinJson();
    if (typeof input.session_id !== "string" || !isJsonObject(input.tool_input)) return;
    const path = input.tool_input.file_path;
    if (typeof path !== "string") return;

    const config = await loadAcommuneConfig();
    const identity = await loadSessionIdentity(
      sessionIdentityPath(config.room, input.session_id),
    );
    if (identity.room !== config.room || identity.relay !== config.relay) return;

    const claimsPath = cachePath(config.room);
    const cache = await readClaimCache(claimsPath);
    const cacheKey = `${input.session_id}|${path}`;
    const now = Date.now();
    const cachedAt = cache[cacheKey];
    if (cachedAt !== undefined && now - cachedAt < CLAIM_CACHE_FRESH_MS) return;

    const deadline = now + HOOK_HTTP_TIMEOUT_MS;
    const claimsUrl = new URL(
      `${config.relay}/rooms/${encodeURIComponent(config.room)}/claims`,
    );
    claimsUrl.searchParams.set("file", path);
    const claimsResponse = await fetchBeforeDeadline(
      claimsUrl,
      { method: "GET", headers: { "x-acommune-code": config.code } },
      deadline,
    );
    const claimsResult = await responseJson(claimsResponse);
    if (!claimsResponse.ok) throw new Error("Relay rejected claim lookup");
    const conflict = parseClaims(claimsResult).find(
      (claim) => claim.sessionName !== identity.sessionName,
    );
    if (conflict !== undefined) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: conflictWarning(conflict, path, now),
          },
        }),
      );
      return;
    }

    const syncResponse = await fetchBeforeDeadline(
      `${config.relay}/rooms/${encodeURIComponent(config.room)}/sync`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          session_name: identity.sessionName,
          reclaim_token: identity.reclaimToken,
          outbox: [
            {
              kind: "claim",
              body: { summary: `editing ${basename(path)}`, files: [path] },
            },
          ],
          wait_seconds: 0,
        }),
      },
      deadline,
    );
    const syncResult = await responseJson(syncResponse);
    if (!syncResponse.ok) throw new Error("Relay rejected claim post");
    validateSyncResponse(syncResult);

    const pruned = Object.fromEntries(
      Object.entries(cache).filter((entry) => now - entry[1] < CLAIM_CACHE_MAX_AGE_MS),
    );
    pruned[cacheKey] = now;
    await writePrivateJson(claimsPath, pruned);
  } catch {
    // Claim hooks always fail open and stay silent on every error path.
  }
  process.exitCode = 0;
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
  if (current.exists) {
    await copyFile(configPath, `${configPath}.bak`);
    if (current.mode !== undefined) await chmod(`${configPath}.bak`, current.mode);
  }
  const temporary = `${configPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(nextConfig, null, 2)}\n`, {
      encoding: "utf8",
      mode: current.mode ?? 0o600,
    });
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
  if (command === "join") {
    await joinRoom(parseJoin(args.slice(1)));
    return;
  }
  if (command === "hooks" && args[1] === "install") {
    await installHooks(parseHooksInstall(args.slice(2)));
    return;
  }
  if (command === "hook" && args[1] === "session-start" && args.length === 2) {
    await runSessionStartHook();
    return;
  }
  if (command === "hook" && args[1] === "claim" && args.length === 2) {
    await runClaimHook();
    return;
  }
  throw new CliError(`Unknown command: ${args.join(" ")}`);
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Error: ${message}\n\n${USAGE}\n`);
  process.exitCode = 1;
});
