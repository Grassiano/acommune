#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { KINDS, type Kind } from "acommune-shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const relayUrl = (process.env.RELAY_URL ?? "http://127.0.0.1:4477").replace(
  /\/$/,
  "",
);
const sessionDirectory = join(homedir(), ".acommune");

const storedSessionSchema = z.object({
  room: z.string(),
  session_name: z.string(),
  reclaim_token: z.string(),
});

type StoredSession = z.infer<typeof storedSessionSchema>;

const joinResponseSchema = z.object({
  reclaim_token: z.string(),
  cursor: z.number(),
});

const roomResponseSchema = z.object({
  room_id: z.string(),
  name: z.string(),
});

const roomShape = {
  room: z.string().trim().min(1).max(200).describe("Human room name"),
};

const outboxItemSchema = z.object({
  kind: z.enum(KINDS),
  body: z.unknown(),
  reply_to: z.number().int().positive().optional(),
  client_msg_id: z.string().min(1).max(500).optional(),
});

function sessionPath(room: string): string {
  const safeRoom = /^[A-Za-z0-9._-]+$/.test(room)
    ? room
    : createHash("sha256").update(room).digest("hex");
  return join(sessionDirectory, `${safeRoom}.session.json`);
}

async function loadSession(room: string): Promise<StoredSession> {
  try {
    const raw = await readFile(sessionPath(room), "utf8");
    const parsed = storedSessionSchema.parse(JSON.parse(raw) as unknown);
    if (parsed.room !== room) {
      throw new Error("Stored session does not match this room");
    }
    return parsed;
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      throw new Error(`No local session for room ${room}; call bus_join first`);
    }
    throw error;
  }
}

async function saveSession(session: StoredSession): Promise<void> {
  const destination = sessionPath(session.room);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

function errorMessage(payload: unknown, status: number): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof payload.error === "object" &&
    payload.error !== null &&
    "message" in payload.error &&
    typeof payload.error.message === "string"
  ) {
    return payload.error.message;
  }
  return `Relay request failed with HTTP ${status}`;
}

async function relayFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${relayUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });
  const text = await response.text();
  let payload: unknown;
  try {
    payload = text === "" ? null : (JSON.parse(text) as unknown);
  } catch {
    throw new Error(`Relay returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(errorMessage(payload, response.status));
  }
  return payload;
}

function textResult(summary: string, payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: `${summary}\n${JSON.stringify(payload)}`,
      },
    ],
  };
}

function toolError(error: unknown) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}

function bodyWithReply(body: unknown, replyTo?: number): unknown {
  if (replyTo === undefined) {
    return body;
  }
  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    return { ...body, reply_to: replyTo };
  }
  return { value: body, reply_to: replyTo };
}

const server = new McpServer({ name: "acommune", version: "0.1.0" });

server.registerTool(
  "bus_join",
  {
    description: "Create or join a named acommune room and reserve a session name",
    inputSchema: {
      ...roomShape,
      session_name: z.string().trim().min(1).max(200),
      pairing_code: z.string().min(6),
    },
  },
  async ({ room, session_name, pairing_code }) => {
    try {
      let reclaimToken: string | undefined;
      try {
        const existing = await loadSession(room);
        if (existing.session_name === session_name) {
          reclaimToken = existing.reclaim_token;
        }
      } catch {
        // A missing or unreadable local credential means this is a fresh join.
      }
      const requestBody = {
        session_name,
        pairing_code,
        ...(reclaimToken === undefined ? {} : { reclaim_token: reclaimToken }),
      };
      const roomPayload = await relayFetch("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: room, pairing_code }),
      });
      roomResponseSchema.parse(roomPayload);
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(room)}/join`,
        { method: "POST", body: JSON.stringify(requestBody) },
      );
      const joined = joinResponseSchema.parse(payload);
      await saveSession({
        room,
        session_name,
        reclaim_token: joined.reclaim_token,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `Joined ${room} as ${session_name}; identity saved locally.`,
          },
        ],
      };
    } catch (error: unknown) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "bus_sync",
  {
    description: "Post queued messages and receive new room messages by long-poll",
    inputSchema: {
      ...roomShape,
      outbox: z.array(outboxItemSchema).max(1_000).optional(),
      wait_seconds: z.number().min(0).max(120).optional(),
    },
  },
  async ({ room, outbox = [], wait_seconds }) => {
    try {
      const session = await loadSession(room);
      const forwardedOutbox = outbox.map((item) => ({
        kind: item.kind,
        body: bodyWithReply(item.body, item.reply_to),
        ...(item.client_msg_id === undefined
          ? {}
          : { client_msg_id: item.client_msg_id }),
      }));
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(room)}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            session_name: session.session_name,
            reclaim_token: session.reclaim_token,
            outbox: forwardedOutbox,
            ...(wait_seconds === undefined ? {} : { wait_seconds }),
          }),
        },
      );
      return textResult(`Synced ${room}.`, payload);
    } catch (error: unknown) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "bus_post",
  {
    description: "Post one message to an acommune room without waiting",
    inputSchema: {
      ...roomShape,
      kind: z.enum(KINDS),
      body: z.unknown(),
    },
  },
  async ({ room, kind, body }: { room: string; kind: Kind; body: unknown }) => {
    try {
      const session = await loadSession(room);
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(room)}/sync`,
        {
          method: "POST",
          body: JSON.stringify({
            session_name: session.session_name,
            reclaim_token: session.reclaim_token,
            outbox: [{ kind, body }],
            wait_seconds: 0,
          }),
        },
      );
      return textResult(`Posted ${kind} to ${room}.`, payload);
    } catch (error: unknown) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "bus_who",
  {
    description: "List sessions active in an acommune room during the last 30 minutes",
    inputSchema: roomShape,
  },
  async ({ room }) => {
    try {
      const session = await loadSession(room);
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(room)}/presence`,
        {
          method: "POST",
          body: JSON.stringify({ reclaim_token: session.reclaim_token }),
        },
      );
      return textResult(`Presence for ${room}.`, payload);
    } catch (error: unknown) {
      return toolError(error);
    }
  },
);

server.registerTool(
  "bus_verify",
  {
    description: "Verify the tamper-evident hash chain for an acommune room",
    inputSchema: roomShape,
  },
  async ({ room }) => {
    try {
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(room)}/verify`,
      );
      return textResult(`Verified ${room}.`, payload);
    } catch (error: unknown) {
      return toolError(error);
    }
  },
);

await server.connect(new StdioServerTransport());
