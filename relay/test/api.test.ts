import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import type { Message, SyncResult } from "acommune-shared";

import { RoomNotifier } from "../src/notifier.js";
import {
  MAX_MESSAGE_BODY_BYTES,
  createServer,
  type ServerDependencies,
} from "../src/server.js";
import { openDatabase } from "../src/sqlite.js";
import { BOARD_MESSAGE_BYTES_LIMIT } from "../src/store.js";

interface Harness {
  dbPath: string;
  port?: number;
  socketPath?: string;
  directServer?: Server;
  close: () => Promise<void>;
}

interface RoomResponse {
  room_id: string;
  name: string;
}

interface JoinResponse {
  reclaim_token: string;
  cursor: number;
}

interface BoardResponse {
  room: string;
  presence: Array<{
    session_name: string;
    last_seen: string;
    current_claim?: unknown;
  }>;
  messages: Array<{
    seq: number;
    sender: string;
    kind: string;
    body: unknown;
    ts: string;
  }>;
  verified: boolean;
}

interface JsonResponse<T> {
  status: number;
  body: T;
}

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function startHarness(
  dependencies: Omit<ServerDependencies, "dbPath"> = {},
): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-test-"));
  const dbPath = join(directory, "relay.sqlite");
  const server = createServer({ ...dependencies, dbPath, version: "test" });
  let port: number | undefined;
  let socketPath: string | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    port = (server.address() as AddressInfo).port;
  } catch (error: unknown) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { code?: unknown }).code !== "EPERM"
    ) {
      throw error;
    }
    socketPath = join(directory, "relay.sock");
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => resolve());
      });
    } catch (socketError: unknown) {
      if (
        typeof socketError !== "object" ||
        socketError === null ||
        !("code" in socketError) ||
        (socketError as { code?: unknown }).code !== "EPERM"
      ) {
        throw socketError;
      }
      socketPath = undefined;
    }
  }
  const directServer = port === undefined && socketPath === undefined ? server : undefined;
  return {
    dbPath,
    ...(port === undefined ? {} : { port }),
    ...(socketPath === undefined ? {} : { socketPath }),
    ...(directServer === undefined ? {} : { directServer }),
    close: async () => {
      if (directServer === undefined) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error === undefined ? resolve() : reject(error)));
        });
      } else {
        server.emit("close");
      }
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function jsonRequest<T>(
  harness: Harness,
  path: string,
  init: RequestOptions = {},
): Promise<JsonResponse<T>> {
  if (harness.directServer !== undefined) {
    return new Promise((resolve, reject) => {
      const input =
        init.body === undefined
          ? Readable.from([])
          : Readable.from([Buffer.from(init.body)]);
      const request = Object.assign(input, {
        method: init.method ?? "GET",
        url: path,
        headers: { "content-type": "application/json", ...init.headers },
      }) as unknown as IncomingMessage;
      let status = 0;
      const chunks: Buffer[] = [];
      const emitter = new EventEmitter();
      let response: ServerResponse;
      response = Object.assign(emitter, {
        destroyed: false,
        writeHead: (code: number) => {
          status = code;
          return response;
        },
        end: (chunk?: string | Buffer) => {
          if (chunk !== undefined) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          try {
            resolve({
              status,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (error: unknown) {
            reject(error);
          }
          return response;
        },
      }) as unknown as ServerResponse;
      harness.directServer?.emit("request", request, response);
    });
  }
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        ...(harness.socketPath === undefined
          ? { hostname: "127.0.0.1", port: harness.port }
          : { socketPath: harness.socketPath }),
        path,
        method: init.method ?? "GET",
        headers: { "content-type": "application/json", ...init.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (error: unknown) {
            reject(error);
          }
        });
      },
    );
    request.once("error", reject);
    if (init.body !== undefined) {
      request.write(init.body);
    }
    request.end();
  });
}

async function createRoom(
  harness: Harness,
  name = "test room",
  pairingCode = "pair-me",
): Promise<RoomResponse> {
  const response = await jsonRequest<RoomResponse>(harness, "/rooms", {
    method: "POST",
    body: JSON.stringify({ name, pairing_code: pairingCode }),
  });
  assert.equal(response.status, 201);
  return response.body;
}

async function boardRequest(
  harness: Harness,
  room: string,
  code = "pair-me",
): Promise<JsonResponse<BoardResponse>> {
  return jsonRequest<BoardResponse>(
    harness,
    `/rooms/${encodeURIComponent(room)}/board`,
    {
      method: "POST",
      headers: { "x-acommune-code": code },
    },
  );
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startDisconnectingLongPoll(
  harness: Harness,
  path: string,
  body: string,
): () => void {
  if (harness.directServer !== undefined) {
    const input = Object.assign(Readable.from([Buffer.from(body)]), {
      method: "POST",
      url: path,
      headers: { "content-type": "application/json" },
    }) as unknown as IncomingMessage;
    const emitter = new EventEmitter();
    let response: ServerResponse;
    response = Object.assign(emitter, {
      destroyed: false,
      writeHead: () => response,
      end: () => response,
    }) as unknown as ServerResponse;
    harness.directServer.emit("request", input, response);
    return () => emitter.emit("close");
  }

  const request = httpRequest({
    ...(harness.socketPath === undefined
      ? { hostname: "127.0.0.1", port: harness.port }
      : { socketPath: harness.socketPath }),
    path,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    },
  });
  request.on("error", () => undefined);
  request.on("response", (response) => response.resume());
  request.end(body);
  return () => request.destroy();
}

async function joinRoom(
  harness: Harness,
  room: string,
  sessionName: string,
  reclaimToken?: string,
): Promise<JoinResponse> {
  const response = await jsonRequest<JoinResponse>(
    harness,
    `/rooms/${encodeURIComponent(room)}/join`,
    {
      method: "POST",
      body: JSON.stringify({
        session_name: sessionName,
        pairing_code: "pair-me",
        ...(reclaimToken === undefined
          ? {}
          : { reclaim_token: reclaimToken }),
      }),
    },
  );
  assert.equal(response.status, 200);
  return response.body;
}

async function sync(
  harness: Harness,
  room: string,
  sessionName: string,
  reclaimToken: string,
  options: {
    outbox?: Array<{
      kind: string;
      body: unknown;
      client_msg_id?: string;
    }>;
    wait_seconds?: number;
    max_items?: number;
  } = {},
): Promise<JsonResponse<SyncResult>> {
  return jsonRequest<SyncResult>(
    harness,
    `/rooms/${encodeURIComponent(room)}/sync`,
    {
      method: "POST",
      body: JSON.stringify({
        session_name: sessionName,
        reclaim_token: reclaimToken,
        ...options,
      }),
    },
  );
}

describe("relay HTTP protocol", () => {
  it("requires pairing codes of at least six characters", async () => {
    const harness = await startHarness();
    try {
      const response = await jsonRequest<{ error: { code: string } }>(
        harness,
        "/rooms",
        {
          method: "POST",
          body: JSON.stringify({ name: "short-code", pairing_code: "12345" }),
        },
      );
      assert.equal(response.status, 400);
      assert.equal(response.body.error.code, "VALIDATION_ERROR");
    } finally {
      await harness.close();
    }
  });

  it("rate-limits room creation per client IP", async () => {
    const harness = await startHarness({ roomCreateLimitPerMinute: 2 });
    try {
      await createRoom(harness, "rate-one");
      await createRoom(harness, "rate-two");
      const limited = await jsonRequest<{ error: { code: string } }>(
        harness,
        "/rooms",
        {
          method: "POST",
          body: JSON.stringify({ name: "rate-three", pairing_code: "pair-me" }),
        },
      );
      assert.equal(limited.status, 429);
      assert.equal(limited.body.error.code, "ROOM_CREATE_RATE_LIMITED");
    } finally {
      await harness.close();
    }
  });

  it("enforces the relay-wide room cap", async () => {
    const harness = await startHarness({ roomLimit: 1 });
    try {
      await createRoom(harness, "only-room");
      const full = await jsonRequest<{ error: { code: string } }>(
        harness,
        "/rooms",
        {
          method: "POST",
          body: JSON.stringify({ name: "one-too-many", pairing_code: "pair-me" }),
        },
      );
      assert.equal(full.status, 507);
      assert.equal(full.body.error.code, "ROOM_LIMIT_REACHED");
    } finally {
      await harness.close();
    }
  });

  it("stores a unique salt and salted pairing-code hash", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const otherRoom = await createRoom(harness, "second salted room");
      const database = openDatabase(harness.dbPath);
      const stored = database
        .prepare(
          "SELECT pairing_hash, pairing_salt FROM rooms WHERE room_id = ?",
        )
        .get(room.room_id) as
        | { pairing_hash: string; pairing_salt: string | null }
        | undefined;
      const otherStored = database
        .prepare("SELECT pairing_salt FROM rooms WHERE room_id = ?")
        .get(otherRoom.room_id) as { pairing_salt: string | null } | undefined;
      database.close();
      assert.notEqual(stored, undefined);
      assert.match(stored?.pairing_salt ?? "", /^[a-f0-9]{32}$/);
      assert.notEqual(stored?.pairing_salt, otherStored?.pairing_salt);
      const unsalted = createHash("sha256").update("pair-me").digest("hex");
      assert.notEqual(stored?.pairing_hash, unsalted);
      assert.equal(
        stored?.pairing_hash,
        createHash("sha256")
          .update(`${stored?.pairing_salt ?? ""}pair-me`)
          .digest("hex"),
      );
    } finally {
      await harness.close();
    }
  });

  it("returns the same room for repeated name and pairing code", async () => {
    const harness = await startHarness();
    try {
      const first = await createRoom(harness);
      const second = await jsonRequest<RoomResponse>(harness, "/rooms", {
        method: "POST",
        body: JSON.stringify({ name: first.name, pairing_code: "pair-me" }),
      });

      assert.equal(second.status, 200);
      assert.equal(second.body.room_id, first.room_id);
      assert.equal(second.body.name, first.name);
    } finally {
      await harness.close();
    }
  });

  it("rejects a reused room name with a different pairing code", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const response = await jsonRequest<{ error: { code: string } }>(
        harness,
        "/rooms",
        {
          method: "POST",
          body: JSON.stringify({
            name: room.name,
            pairing_code: "different-code",
          }),
        },
      );

      assert.equal(response.status, 409);
      assert.equal(response.body.error.code, "ROOM_NAME_TAKEN");
    } finally {
      await harness.close();
    }
  });

  it("rejects a wrong pairing code", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const response = await jsonRequest<unknown>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/join`,
        {
          method: "POST",
          body: JSON.stringify({
            session_name: "alice",
            pairing_code: "wrong",
          }),
        },
      );
      assert.equal(response.status, 401);
    } finally {
      await harness.close();
    }
  });

  it("throttles repeated failed board and join pairing attempts", async () => {
    const harness = await startHarness({ failedPairingLimitPerMinute: 2 });
    try {
      const room = await createRoom(harness);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const wrong = await jsonRequest<{ error: { code: string } }>(
          harness,
          `/rooms/${encodeURIComponent(room.name)}/board`,
          {
            method: "POST",
            headers: { "x-acommune-code": "wrong" },
          },
        );
        assert.equal(wrong.status, 401);
      }
      const throttled = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/join`,
        {
          method: "POST",
          body: JSON.stringify({
            session_name: "guesser",
            pairing_code: "still-wrong",
          }),
        },
      );
      assert.equal(throttled.status, 429);
      assert.equal(throttled.body.error.code, "PAIRING_RATE_LIMITED");
    } finally {
      await harness.close();
    }
  });

  it("reserves session names and permits token-based reclaim", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const first = await joinRoom(harness, room.name, "alice");
      assert.match(first.reclaim_token, /^[a-f0-9]{48}$/);

      const conflict = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/join`,
        {
          method: "POST",
          body: JSON.stringify({
            session_name: "alice",
            pairing_code: "pair-me",
          }),
        },
      );
      assert.equal(conflict.status, 409);
      assert.equal(conflict.body.error.code, "AGENT_NAME_IN_USE");

      const reclaimed = await joinRoom(
        harness,
        room.name,
        "alice",
        first.reclaim_token,
      );
      assert.equal(reclaimed.reclaim_token, first.reclaim_token);
    } finally {
      await harness.close();
    }
  });

  it("joins two sessions by room name and exposes both in presence", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const bob = await joinRoom(harness, room.name, "bob");
      const posted = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        {
          outbox: [{ kind: "progress", body: { task: "shipping" } }],
          wait_seconds: 0,
        },
      );
      assert.equal(posted.status, 200);
      assert.equal(posted.body.sent.length, 1);

      const received = await sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 0 },
      );
      const message = received.body.received.find(
        (candidate) => candidate.kind === "progress",
      );
      assert.deepEqual(message?.body, { task: "shipping" });
      assert.equal(message?.sender, "alice");

      const presence = await jsonRequest<{
        sessions: Array<{ session_name: string }>;
      }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/presence`,
        {
          method: "POST",
          body: JSON.stringify({ reclaim_token: alice.reclaim_token }),
        },
      );
      assert.equal(presence.status, 200);
      assert.deepEqual(
        presence.body.sessions.map((session) => session.session_name),
        ["alice", "bob"],
      );
      const queryRejected = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/presence?reclaim_token=${alice.reclaim_token}`,
      );
      assert.equal(queryRejected.status, 404);
    } finally {
      await harness.close();
    }
  });

  it("returns an authenticated read-only board state", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const bob = await joinRoom(harness, room.name, "bob");
      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [
          { kind: "progress", body: { note: "board route is taking shape" } },
          { kind: "claim", body: "editing relay/src/server.ts" },
        ],
        wait_seconds: 0,
      });

      const queryOnly = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/board?code=pair-me`,
      );
      assert.equal(queryOnly.status, 404);
      const postQueryOnly = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/board?code=pair-me`,
        { method: "POST" },
      );
      assert.equal(postQueryOnly.status, 401);

      const board = await boardRequest(harness, room.name);
      assert.equal(board.status, 200);
      assert.equal(board.body.room, room.name);
      assert.equal(board.body.verified, true);
      assert.deepEqual(
        board.body.presence.map((session) => session.session_name),
        ["alice", "bob"],
      );
      assert.equal(
        board.body.presence.find((session) => session.session_name === "alice")
          ?.current_claim,
        "editing relay/src/server.ts",
      );
      assert.equal(
        board.body.messages.some(
          (message) =>
            message.sender === "alice" &&
            message.kind === "progress" &&
            "note" in (message.body as { note: string }),
        ),
        true,
      );
      assert.deepEqual(Object.keys(board.body.messages.at(-1) ?? {}).sort(), [
        "body",
        "kind",
        "sender",
        "seq",
        "ts",
      ]);

      const unreadAfterBoard = await sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 0 },
      );
      assert.equal(
        unreadAfterBoard.body.received.some(
          (message) => message.body === "editing relay/src/server.ts",
        ),
        true,
      );

      const wrong = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/board`,
        {
          method: "POST",
          headers: { "x-acommune-code": "wrong" },
        },
      );
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.error.code, "INVALID_PAIRING_CODE");

      const missing = await jsonRequest<{ error: { code: string } }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/board`,
        { method: "POST" },
      );
      assert.equal(missing.status, 401);

      const bodyAuthenticated = await jsonRequest<BoardResponse>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/board`,
        {
          method: "POST",
          body: JSON.stringify({ code: "pair-me" }),
        },
      );
      assert.equal(bodyAuthenticated.status, 200);
    } finally {
      await harness.close();
    }
  });

  it("clears a current claim after later progress or handoff", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [{ kind: "claim", body: { file: "relay/src/store.ts" } }],
        wait_seconds: 0,
      });
      const claimed = await boardRequest(harness, room.name);
      assert.deepEqual(claimed.body.presence[0]?.current_claim, {
        file: "relay/src/store.ts",
      });

      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [{ kind: "progress", body: "finished the store change" }],
        wait_seconds: 0,
      });
      const progressed = await boardRequest(harness, room.name);
      assert.equal(
        Object.hasOwn(progressed.body.presence[0] ?? {}, "current_claim"),
        false,
      );
    } finally {
      await harness.close();
    }
  });

  it("caps aggregate board message bytes while keeping the newest messages", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const bodies = Array.from({ length: 20 }, (_, index) =>
        `${String(index).padStart(2, "0")}:${"x".repeat(15_000)}`,
      );
      const posted = await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: bodies.map((body) => ({ kind: "knowledge", body })),
        wait_seconds: 0,
      });
      assert.equal(posted.status, 200);
      const state = await boardRequest(harness, room.name);
      const aggregateBytes = state.body.messages.reduce(
        (total, message) =>
          total + Buffer.byteLength(JSON.stringify(message.body), "utf8"),
        0,
      );
      assert.ok(aggregateBytes <= BOARD_MESSAGE_BYTES_LIMIT);
      assert.ok(state.body.messages.length < bodies.length + 1);
      assert.equal(
        state.body.messages.at(-1)?.seq,
        posted.body.sent.at(-1)?.seq,
      );
    } finally {
      await harness.close();
    }
  });

  it("rejects coordination message bodies over the per-message byte limit", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const oversized = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        {
          outbox: [
            { kind: "knowledge", body: "x".repeat(MAX_MESSAGE_BODY_BYTES) },
          ],
          wait_seconds: 0,
        },
      );
      assert.equal(oversized.status, 400);
    } finally {
      await harness.close();
    }
  });

  it("memoizes board verification until a message append invalidates it", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const initial = await boardRequest(harness, room.name);
      assert.equal(initial.body.verified, true);

      const database = openDatabase(harness.dbPath);
      database
        .prepare(
          "UPDATE messages SET body_json = ? WHERE room_id = ? AND seq = 1",
        )
        .run(JSON.stringify({ tampered: true }), room.room_id);
      database.close();

      const cached = await boardRequest(harness, room.name);
      assert.equal(cached.body.verified, true);
      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [{ kind: "progress", body: "invalidate verification cache" }],
        wait_seconds: 0,
      });
      const recomputed = await boardRequest(harness, room.name);
      assert.equal(recomputed.body.verified, false);
    } finally {
      await harness.close();
    }
  });

  it("advances each session cursor and returns only newer messages", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const bob = await joinRoom(harness, room.name, "bob");
      const first = await sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 0 },
      );
      assert.ok(first.body.received.length >= 2);

      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [{ kind: "knowledge", body: "new fact" }],
        wait_seconds: 0,
      });
      const second = await sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 0 },
      );
      assert.equal(second.body.received.length, 1);
      assert.equal(second.body.received[0]?.body, "new fact");
      assert.ok(second.body.cursor > first.body.cursor);
    } finally {
      await harness.close();
    }
  });

  it("deduplicates a sender's client_msg_id", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const item = {
        kind: "claim",
        body: { file: "server.ts" },
        client_msg_id: "stable-id",
      };
      const first = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        { outbox: [item], wait_seconds: 0 },
      );
      const second = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        { outbox: [item], wait_seconds: 0 },
      );
      assert.equal(second.body.sent[0]?.seq, first.body.sent[0]?.seq);

      const bob = await joinRoom(harness, room.name, "bob");
      const all = await sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 0 },
      );
      assert.equal(
        all.body.received.filter(
          (message) => message.client_msg_id === "stable-id",
        ).length,
        1,
      );
    } finally {
      await harness.close();
    }
  });

  it("verifies the hash chain and reports the first tampered sequence", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const posted = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        {
          outbox: [{ kind: "knowledge", body: { fact: true } }],
          wait_seconds: 0,
        },
      );
      const postedSeq = posted.body.sent[0]?.seq;
      assert.equal(typeof postedSeq, "number");

      const valid = await jsonRequest<{ ok: boolean }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/verify`,
      );
      assert.deepEqual(valid.body, { ok: true });

      const database = openDatabase(harness.dbPath);
      database
        .prepare(
          "UPDATE messages SET body_json = ? WHERE room_id = ? AND seq = ?",
        )
        .run(JSON.stringify({ fact: false }), room.room_id, postedSeq);
      database.close();

      const invalid = await jsonRequest<{ ok: boolean; badSeq: number }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/verify`,
      );
      assert.deepEqual(invalid.body, { ok: false, badSeq: postedSeq });
    } finally {
      await harness.close();
    }
  });

  it("wakes a long-poll when another session posts", async () => {
    const harness = await startHarness();
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      const bob = await joinRoom(harness, room.name, "bob");
      await sync(harness, room.name, "bob", bob.reclaim_token, {
        wait_seconds: 0,
      });

      const started = Date.now();
      const pending = sync(
        harness,
        room.name,
        "bob",
        bob.reclaim_token,
        { wait_seconds: 2 },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      await sync(harness, room.name, "alice", alice.reclaim_token, {
        outbox: [{ kind: "answer", body: "wake up" }],
        wait_seconds: 0,
      });

      const result = await pending;
      assert.equal(result.body.status, "ready");
      assert.ok(Date.now() - started < 1_900);
      assert.equal(
        result.body.received.some(
          (message: Message) => message.body === "wake up",
        ),
        true,
      );
    } finally {
      await harness.close();
    }
  });

  it("bounds long polls and removes a waiter when its client disconnects", async () => {
    const notifier = new RoomNotifier({ maxPerRoom: 1, maxTotal: 1 });
    const harness = await startHarness({ notifier });
    try {
      const room = await createRoom(harness);
      const alice = await joinRoom(harness, room.name, "alice");
      await sync(harness, room.name, "alice", alice.reclaim_token, {
        wait_seconds: 0,
      });
      const requestBody = JSON.stringify({
        session_name: "alice",
        reclaim_token: alice.reclaim_token,
        wait_seconds: 30,
      });
      const disconnect = startDisconnectingLongPoll(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/sync`,
        requestBody,
      );
      await waitFor(() => notifier.waiterCount === 1);

      const bounded = await sync(
        harness,
        room.name,
        "alice",
        alice.reclaim_token,
        { wait_seconds: 1 },
      );
      assert.equal(bounded.status, 503);

      disconnect();
      await waitFor(() => notifier.waiterCount === 0);
    } finally {
      await harness.close();
    }
  });
});
