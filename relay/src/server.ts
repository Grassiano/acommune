#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { KINDS, type SyncResult } from "acommune-shared";
import { z, ZodError } from "zod";

import { RoomNotifier } from "./notifier.js";
import { RelayError, RelayStore, type OutboxItem } from "./store.js";

export const VERSION = "0.1.0";

export interface ServerDependencies {
  dbPath?: string;
  version?: string;
}

const roomSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pairing_code: z.string().min(1).max(1_024),
});

const joinSchema = z.object({
  session_name: z.string().trim().min(1).max(200),
  pairing_code: z.string().min(1).max(1_024),
  reclaim_token: z.string().length(48).optional(),
});

const outboxItemSchema = z.object({
  kind: z.enum(KINDS),
  body: z.custom<{} | null>((value) => value !== undefined, {
    message: "Message body is required",
  }),
  client_msg_id: z.string().min(1).max(500).optional(),
});

const syncSchema = z.object({
  session_name: z.string().trim().min(1).max(200),
  reclaim_token: z.string().length(48),
  outbox: z.array(outboxItemSchema).max(1_000).default([]),
  wait_seconds: z.number().min(0).max(120).default(30),
  max_items: z.number().int().min(1).max(1_000).default(50),
});

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_048_576) {
      throw new RelayError(413, "BODY_TOO_LARGE", "Request body is too large");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new RelayError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

function reclaimToken(request: IncomingMessage, url: URL): string | undefined {
  const queryToken = url.searchParams.get("reclaim_token");
  if (queryToken !== null) {
    return queryToken;
  }
  const headerToken = request.headers["x-reclaim-token"];
  if (typeof headerToken === "string") {
    return headerToken;
  }
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return undefined;
}

export function createServer(dependencies: ServerDependencies = {}): Server {
  const store = new RelayStore(
    dependencies.dbPath ?? process.env.RELAY_DB ?? "./data/acommune.sqlite",
  );
  const notifier = new RoomNotifier();
  const version = dependencies.version ?? VERSION;

  const server = createHttpServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://relay.local");

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, version });
        return;
      }

      if (method === "POST" && url.pathname === "/rooms") {
        const input = roomSchema.parse(await readJson(request));
        const { created, ...room } = store.createRoom(
          input.name,
          input.pairing_code,
        );
        sendJson(response, created ? 201 : 200, room);
        return;
      }

      const joinMatch = /^\/rooms\/([^/]+)\/join$/.exec(url.pathname);
      if (method === "POST" && joinMatch !== null) {
        const roomId = store.resolveRoomId(decodeURIComponent(joinMatch[1]!));
        const input = joinSchema.parse(await readJson(request));
        const result = store.join(
          roomId,
          input.session_name,
          input.pairing_code,
          input.reclaim_token,
        );
        notifier.notify(roomId);
        sendJson(response, 200, result);
        return;
      }

      const syncMatch = /^\/rooms\/([^/]+)\/sync$/.exec(url.pathname);
      if (method === "POST" && syncMatch !== null) {
        const roomId = store.resolveRoomId(decodeURIComponent(syncMatch[1]!));
        const input = syncSchema.parse(await readJson(request));
        const outbox: OutboxItem[] = input.outbox.map((item) =>
          item.client_msg_id === undefined
            ? { kind: item.kind, body: item.body }
            : {
                kind: item.kind,
                body: item.body,
                client_msg_id: item.client_msg_id,
              },
        );
        let result = store.sync(
          roomId,
          input.session_name,
          input.reclaim_token,
          outbox,
          input.max_items,
        );
        if (result.inserted) {
          notifier.notify(roomId);
        }

        const sent = result.sent;
        let timedOut = false;
        if (result.received.length === 0 && input.wait_seconds > 0) {
          const notified = await notifier.wait(roomId, input.wait_seconds * 1_000);
          timedOut = !notified;
          result = store.sync(
            roomId,
            input.session_name,
            input.reclaim_token,
            [],
            input.max_items,
          );
        }

        const payload: SyncResult = {
          received: result.received,
          sent,
          cursor: result.cursor,
          status:
            result.received.length > 0
              ? "ready"
              : timedOut
                ? "timeout"
                : "empty",
        };
        sendJson(response, 200, payload);
        return;
      }

      const presenceMatch = /^\/rooms\/([^/]+)\/presence$/.exec(url.pathname);
      if (method === "GET" && presenceMatch !== null) {
        const token = reclaimToken(request, url);
        if (token === undefined) {
          throw new RelayError(401, "MISSING_RECLAIM_TOKEN", "Reclaim token required");
        }
        const roomId = store.resolveRoomId(
          decodeURIComponent(presenceMatch[1]!),
        );
        sendJson(response, 200, { sessions: store.presence(roomId, token) });
        return;
      }

      const verifyMatch = /^\/rooms\/([^/]+)\/verify$/.exec(url.pathname);
      if (method === "GET" && verifyMatch !== null) {
        const roomId = store.resolveRoomId(decodeURIComponent(verifyMatch[1]!));
        sendJson(response, 200, store.verify(roomId));
        return;
      }

      throw new RelayError(404, "NOT_FOUND", "Endpoint not found");
    } catch (error: unknown) {
      if (error instanceof RelayError) {
        sendJson(response, error.status, {
          error: { code: error.code, message: error.message },
        });
        return;
      }
      if (error instanceof ZodError) {
        sendJson(response, 400, {
          error: {
            code: "VALIDATION_ERROR",
            message: "Invalid request",
            issues: error.issues,
          },
        });
        return;
      }
      console.error(error);
      sendJson(response, 500, {
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    }
  });

  server.once("close", () => {
    notifier.close();
    store.close();
  });
  return server;
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isEntryPoint) {
  const host = process.env.RELAY_HOST ?? "127.0.0.1";
  const portValue = Number.parseInt(process.env.RELAY_PORT ?? "4477", 10);
  if (!Number.isInteger(portValue) || portValue < 0 || portValue > 65_535) {
    throw new Error("RELAY_PORT must be an integer between 0 and 65535");
  }
  const server = createServer();
  server.listen(portValue, host, () => {
    console.log(`acommune relay listening on http://${host}:${portValue}`);
  });
}
