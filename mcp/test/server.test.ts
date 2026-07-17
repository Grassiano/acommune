import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

interface JoinArguments extends Record<string, unknown> {
  room?: string;
  session_name: string;
  pairing_code?: string;
}

interface StoredSession {
  room: string;
  session_name: string;
  reclaim_token: string;
}

interface MockResponse {
  status?: number;
  body: unknown;
}

const serverPath = resolve(process.cwd(), "dist/server.js");
const fetchMockPath = resolve(process.cwd(), ".test-dist/test/fetch-mock.js");
const directories: string[] = [];
const clients: Client[] = [];

function environment(overrides: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) result[name] = value;
  }
  return { ...result, ...overrides };
}

async function tempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-mcp-test-"));
  directories.push(directory);
  return directory;
}

async function writeConfig(
  directory: string,
  room: string,
  code: string,
): Promise<void> {
  const acommuneDirectory = join(directory, ".acommune");
  await mkdir(acommuneDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(acommuneDirectory, "config.json"),
    `${JSON.stringify({
      relay: "http://127.0.0.1:4477",
      room,
      code,
    }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
}

async function startClient(
  directory: string,
  expectedPairingCode: string | undefined,
  responses: readonly MockResponse[],
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    cwd: process.cwd(),
    env: environment({
      HOME: directory,
      NODE_OPTIONS: `--import=${fetchMockPath}`,
      RELAY_URL: "http://127.0.0.1:4477",
      ACOMMUNE_TEST_FETCH_RESPONSES: JSON.stringify(responses),
      ...(expectedPairingCode === undefined
        ? {}
        : { ACOMMUNE_TEST_PAIRING_CODE: expectedPairingCode }),
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "acommune-mcp-test", version: "1.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

async function closeClient(client: Client): Promise<void> {
  const index = clients.indexOf(client);
  if (index !== -1) clients.splice(index, 1);
  await client.close();
}

async function joinRoom(client: Client, args: JoinArguments): Promise<void> {
  const result = await client.callTool({ name: "bus_join", arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result.content));
}

async function storedSession(path: string): Promise<StoredSession> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  assert.ok(typeof parsed === "object" && parsed !== null && !Array.isArray(parsed));
  assert.equal(typeof (parsed as Record<string, unknown>).room, "string");
  assert.equal(typeof (parsed as Record<string, unknown>).session_name, "string");
  assert.equal(typeof (parsed as Record<string, unknown>).reclaim_token, "string");
  return parsed as StoredSession;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  await Promise.all(
    directories
      .splice(0)
      .map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("acommune MCP server", () => {
  it("joins with the room and pairing code from the local config", async () => {
    const directory = await tempDirectory();
    const code = "config-only-secret";
    await writeConfig(directory, "configured-room", code);
    const client = await startClient(directory, code, [
      { status: 201, body: { room_id: "room-id", name: "configured-room" } },
      { body: { reclaim_token: "configured-token", cursor: 0 } },
    ]);

    const result = await client.callTool({
      name: "bus_join",
      arguments: { session_name: "alice" },
    });

    assert.notEqual(result.isError, true, JSON.stringify(result.content));
    assert.doesNotMatch(JSON.stringify(result.content), new RegExp(code));
    assert.deepEqual(
      await storedSession(
        join(directory, ".acommune", "configured-room.alice.session.json"),
      ),
      {
        room: "configured-room",
        session_name: "alice",
        reclaim_token: "configured-token",
      },
    );
  });

  it("keeps concurrent identities for the same room in distinct files", async () => {
    const directory = await tempDirectory();
    const pairingCode = "explicit-secret";
    const [clientA, clientB] = await Promise.all([
      startClient(directory, pairingCode, [
        { status: 200, body: { room_id: "room-id", name: "shared-room" } },
        { body: { reclaim_token: "token-a", cursor: 0 } },
      ]),
      startClient(directory, pairingCode, [
        { status: 200, body: { room_id: "room-id", name: "shared-room" } },
        { body: { reclaim_token: "token-b", cursor: 0 } },
      ]),
    ]);

    await Promise.all([
      joinRoom(clientA, {
        room: "shared-room",
        session_name: "A",
        pairing_code: pairingCode,
      }),
      joinRoom(clientB, {
        room: "shared-room",
        session_name: "B",
        pairing_code: pairingCode,
      }),
    ]);

    const [sessionA, sessionB] = await Promise.all([
      storedSession(join(directory, ".acommune", "shared-room.A.session.json")),
      storedSession(join(directory, ".acommune", "shared-room.B.session.json")),
    ]);
    assert.deepEqual(sessionA, {
      room: "shared-room",
      session_name: "A",
      reclaim_token: "token-a",
    });
    assert.deepEqual(sessionB, {
      room: "shared-room",
      session_name: "B",
      reclaim_token: "token-b",
    });
    assert.notEqual(sessionA.reclaim_token, sessionB.reclaim_token);
  });

  it("resumes the only saved room identity in a fresh process", async () => {
    const directory = await tempDirectory();
    const pairingCode = "resume-secret";
    const firstClient = await startClient(directory, pairingCode, [
      { status: 200, body: { room_id: "room-id", name: "hq" } },
      { body: { reclaim_token: "alice-token", cursor: 0 } },
    ]);
    await joinRoom(firstClient, {
      room: "hq",
      session_name: "alice",
      pairing_code: pairingCode,
    });
    await closeClient(firstClient);

    const freshClient = await startClient(directory, undefined, [
      { body: { sessions: [{ session_name: "alice" }] } },
    ]);
    const result = await freshClient.callTool({
      name: "bus_who",
      arguments: { room: "hq" },
    });

    assert.notEqual(result.isError, true, JSON.stringify(result.content));
  });

  it("rejects ambiguous saved room identities in a fresh process", async () => {
    const directory = await tempDirectory();
    const pairingCode = "ambiguous-secret";
    const firstClient = await startClient(directory, pairingCode, [
      { status: 200, body: { room_id: "room-id", name: "hq" } },
      { body: { reclaim_token: "alice-token", cursor: 0 } },
    ]);
    await joinRoom(firstClient, {
      room: "hq",
      session_name: "alice",
      pairing_code: pairingCode,
    });
    await closeClient(firstClient);

    const secondClient = await startClient(directory, pairingCode, [
      { status: 200, body: { room_id: "room-id", name: "hq" } },
      { body: { reclaim_token: "bob-token", cursor: 0 } },
    ]);
    await joinRoom(secondClient, {
      room: "hq",
      session_name: "bob",
      pairing_code: pairingCode,
    });
    await closeClient(secondClient);

    const freshClient = await startClient(directory, undefined, []);
    const result = await freshClient.callTool({
      name: "bus_who",
      arguments: { room: "hq" },
    });

    assert.equal(result.isError, true);
    assert.match(
      JSON.stringify(result.content),
      /Multiple local sessions found for room hq; call bus_join again with an explicit session_name/,
    );
  });
});
