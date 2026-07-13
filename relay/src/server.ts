#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, extname, resolve, sep } from "node:path";

import { KINDS, type SyncResult } from "acommune-shared";
import { z, ZodError } from "zod";

import { RoomNotifier, WaiterLimitError } from "./notifier.js";
import { RelayError, RelayStore, type OutboxItem } from "./store.js";

export const VERSION = "0.1.0";

const PUBLIC_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../public",
);

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

export interface ServerDependencies {
  dbPath?: string;
  version?: string;
  notifier?: RoomNotifier;
  roomCreateLimitPerMinute?: number;
  roomLimit?: number;
  failedPairingLimitPerMinute?: number;
}

export const MAX_MESSAGE_BODY_BYTES = 16 * 1_024;
const RATE_WINDOW_MS = 60_000;

const roomSchema = z.object({
  name: z.string().trim().min(1).max(200),
  pairing_code: z.string().min(6).max(1_024),
});

const joinSchema = z.object({
  session_name: z.string().trim().min(1).max(200),
  pairing_code: z.string().min(1).max(1_024),
  reclaim_token: z.string().length(48).optional(),
});

const outboxItemSchema = z.object({
  kind: z.enum(KINDS),
  body: z
    .custom<{} | null>((value) => value !== undefined, {
      message: "Message body is required",
    })
    .refine(
      (value) =>
        Buffer.byteLength(JSON.stringify(value), "utf8") <=
        MAX_MESSAGE_BODY_BYTES,
      { message: `Message body must be at most ${MAX_MESSAGE_BODY_BYTES} bytes` },
    ),
  client_msg_id: z.string().min(1).max(500).optional(),
});

const presenceSchema = z.object({
  reclaim_token: z.string().length(48),
});

const boardCodeSchema = z.object({
  code: z.string().min(1).max(1_024),
});

class SlidingWindowLimiter {
  readonly #attempts = new Map<string, number[]>();

  constructor(readonly limit: number) {}

  allow(key: string, now = Date.now()): boolean {
    const recent = this.#recent(key, now);
    if (recent.length >= this.limit) {
      return false;
    }
    recent.push(now);
    this.#attempts.set(key, recent);
    return true;
  }

  blocked(key: string, now = Date.now()): boolean {
    return this.#recent(key, now).length >= this.limit;
  }

  record(key: string, now = Date.now()): void {
    const recent = this.#recent(key, now);
    recent.push(now);
    this.#attempts.set(key, recent);
  }

  #recent(key: string, now: number): number[] {
    const recent = (this.#attempts.get(key) ?? []).filter(
      (timestamp) => now - timestamp < RATE_WINDOW_MS,
    );
    if (recent.length === 0) {
      this.#attempts.delete(key);
    } else {
      this.#attempts.set(key, recent);
    }
    return recent;
  }
}

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

function staticFilePath(pathname: string): string | undefined {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  const relativePath =
    decodedPath === "/" || decodedPath === "/board"
      ? "board.html"
      : decodedPath.replace(/^\/+/, "");
  if (relativePath.length === 0 || relativePath.includes("\0")) {
    return undefined;
  }
  const candidate = resolve(PUBLIC_DIRECTORY, relativePath);
  if (!candidate.startsWith(`${PUBLIC_DIRECTORY}${sep}`)) {
    return undefined;
  }
  return candidate;
}

async function trySendStatic(
  response: import("node:http").ServerResponse,
  pathname: string,
): Promise<boolean> {
  const path = staticFilePath(pathname);
  if (path === undefined) {
    return false;
  }
  try {
    const body = await readFile(path);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream",
      "content-length": body.length,
      // Known CSP landmine: board.html still uses inline event handlers and script.
      "content-security-policy":
        "default-src 'self'; connect-src 'self'; img-src 'self' data:; " +
        "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
        "font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    response.end(body);
    return true;
  } catch (error: unknown) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "ENOENT" || code === "EISDIR") {
      return false;
    }
    throw error;
  }
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

function bearerToken(request: IncomingMessage): string | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return authorization.slice("Bearer ".length);
  }
  return undefined;
}

function clientIp(request: IncomingMessage): string {
  return request.socket?.remoteAddress ?? "unknown";
}

async function boardPairingCode(request: IncomingMessage): Promise<string> {
  const codeHeader = request.headers["x-acommune-code"];
  if (typeof codeHeader === "string" && codeHeader.length > 0) {
    return boardCodeSchema.shape.code.parse(codeHeader);
  }
  const authorization = bearerToken(request);
  if (authorization !== undefined && authorization.length > 0) {
    return boardCodeSchema.shape.code.parse(authorization);
  }
  try {
    return boardCodeSchema.parse(await readJson(request)).code;
  } catch (error: unknown) {
    if (error instanceof RelayError && error.code === "INVALID_JSON") {
      throw new RelayError(401, "INVALID_PAIRING_CODE", "Pairing code required");
    }
    throw error;
  }
}

export function createServer(dependencies: ServerDependencies = {}): Server {
  const store = new RelayStore(
    dependencies.dbPath ?? process.env.RELAY_DB ?? "./data/acommune.sqlite",
  );
  const notifier = dependencies.notifier ?? new RoomNotifier();
  const version = dependencies.version ?? VERSION;
  const roomCreateLimiter = new SlidingWindowLimiter(
    dependencies.roomCreateLimitPerMinute ?? 10,
  );
  const failedPairingLimiter = new SlidingWindowLimiter(
    dependencies.failedPairingLimitPerMinute ?? 5,
  );
  const roomLimit = dependencies.roomLimit ?? 10_000;

  const server = createHttpServer(async (request, response) => {
    try {
      const method = request.method ?? "GET";
      const url = new URL(request.url ?? "/", "http://relay.local");

      if (method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, version });
        return;
      }

      if (method === "POST" && url.pathname === "/rooms") {
        if (!roomCreateLimiter.allow(clientIp(request))) {
          throw new RelayError(
            429,
            "ROOM_CREATE_RATE_LIMITED",
            "Too many room creation attempts; try again later",
          );
        }
        const input = roomSchema.parse(await readJson(request));
        const { created, ...room } = store.createRoom(
          input.name,
          input.pairing_code,
          roomLimit,
        );
        sendJson(response, created ? 201 : 200, room);
        return;
      }

      const joinMatch = /^\/rooms\/([^/]+)\/join$/.exec(url.pathname);
      if (method === "POST" && joinMatch !== null) {
        const ip = clientIp(request);
        if (failedPairingLimiter.blocked(ip)) {
          throw new RelayError(
            429,
            "PAIRING_RATE_LIMITED",
            "Too many failed pairing attempts; try again later",
          );
        }
        const roomId = store.resolveRoomId(decodeURIComponent(joinMatch[1]!));
        const input = joinSchema.parse(await readJson(request));
        let result;
        try {
          result = store.join(
            roomId,
            input.session_name,
            input.pairing_code,
            input.reclaim_token,
          );
        } catch (error: unknown) {
          if (error instanceof RelayError && error.code === "INVALID_PAIRING_CODE") {
            failedPairingLimiter.record(ip);
          }
          throw error;
        }
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
          let waitHandle;
          try {
            waitHandle = notifier.wait(roomId, input.wait_seconds * 1_000);
          } catch (error: unknown) {
            if (error instanceof WaiterLimitError) {
              throw new RelayError(
                503,
                "LONG_POLL_LIMIT_REACHED",
                "Too many concurrent long polls",
              );
            }
            throw error;
          }
          const cancelWait = (): void => waitHandle.cancel();
          request.once("aborted", cancelWait);
          response.once("close", cancelWait);
          if (request.aborted || response.destroyed) {
            waitHandle.cancel();
          }
          const outcome = await waitHandle.promise;
          request.off("aborted", cancelWait);
          response.off("close", cancelWait);
          if (outcome === "cancelled" || response.destroyed) {
            return;
          }
          timedOut = outcome === "timeout";
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
      if (method === "POST" && presenceMatch !== null) {
        const headerToken = request.headers["x-reclaim-token"];
        const token =
          typeof headerToken === "string"
            ? presenceSchema.shape.reclaim_token.parse(headerToken)
            : bearerToken(request) ??
              presenceSchema.parse(await readJson(request)).reclaim_token;
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

      const boardMatch = /^\/rooms\/([^/]+)\/board$/.exec(url.pathname);
      if (method === "POST" && boardMatch !== null) {
        const ip = clientIp(request);
        if (failedPairingLimiter.blocked(ip)) {
          throw new RelayError(
            429,
            "PAIRING_RATE_LIMITED",
            "Too many failed pairing attempts; try again later",
          );
        }
        const roomId = store.resolveRoomId(decodeURIComponent(boardMatch[1]!));
        const pairingCode = await boardPairingCode(request);
        try {
          sendJson(response, 200, store.board(roomId, pairingCode));
        } catch (error: unknown) {
          if (error instanceof RelayError && error.code === "INVALID_PAIRING_CODE") {
            failedPairingLimiter.record(ip);
          }
          throw error;
        }
        return;
      }

      if (method === "GET" && (await trySendStatic(response, url.pathname))) {
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
