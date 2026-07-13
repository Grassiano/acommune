import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, it } from "node:test";

import type { Message, SyncResult } from "acommune-shared";

import { createServer } from "../src/server.js";
import { openDatabase } from "../src/sqlite.js";

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

interface JsonResponse<T> {
  status: number;
  body: T;
}

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

async function startHarness(): Promise<Harness> {
  const directory = await mkdtemp(join(tmpdir(), "acommune-test-"));
  const dbPath = join(directory, "relay.sqlite");
  const server = createServer({ dbPath, version: "test" });
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
      const response = {
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
      } as unknown as ServerResponse;
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

async function createRoom(harness: Harness): Promise<RoomResponse> {
  const response = await jsonRequest<RoomResponse>(harness, "/rooms", {
    method: "POST",
    body: JSON.stringify({ name: "test room", pairing_code: "pair-me" }),
  });
  assert.equal(response.status, 201);
  return response.body;
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

      const query = new URLSearchParams({ reclaim_token: alice.reclaim_token });
      const presence = await jsonRequest<{
        sessions: Array<{ session_name: string }>;
      }>(
        harness,
        `/rooms/${encodeURIComponent(room.name)}/presence?${query.toString()}`,
      );
      assert.equal(presence.status, 200);
      assert.deepEqual(
        presence.body.sessions.map((session) => session.session_name),
        ["alice", "bob"],
      );
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
});
