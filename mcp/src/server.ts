#!/usr/bin/env node
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";

import { KINDS, type Kind } from "acommune-shared";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const relayUrl = (process.env.RELAY_URL ?? "http://127.0.0.1:4477").replace(
  /\/$/,
  "",
);
const sessionDirectory = join(homedir(), ".acommune");
const configFilePath = join(sessionDirectory, "config.json");

const acommuneConfigSchema = z.object({
  relay: z.string().optional(),
  room: z.string().trim().min(1),
  code: z.string().min(1),
});

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

let activeSession: StoredSession | undefined;

function safeFilePart(value: string): string {
  return value !== "" &&
    value !== "." &&
    value !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(value)
    ? value
    : createHash("sha256").update(value).digest("hex");
}

function sessionPath(room: string, sessionName: string): string {
  return join(
    sessionDirectory,
    `${safeFilePart(room)}.${safeFilePart(sessionName)}.session.json`,
  );
}

function legacySessionPath(room: string): string {
  return join(sessionDirectory, `${safeFilePart(room)}.session.json`);
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function readStoredSession(path: string, room: string): Promise<StoredSession> {
  const raw = await readFile(path, "utf8");
  const parsed = storedSessionSchema.parse(JSON.parse(raw) as unknown);
  if (parsed.room !== room) {
    throw new Error("Stored session does not match this room");
  }
  return parsed;
}

async function loadJoinSession(
  room: string,
  sessionName: string,
): Promise<StoredSession | undefined> {
  try {
    const session = await readStoredSession(sessionPath(room, sessionName), room);
    if (session.session_name !== sessionName) {
      throw new Error("Stored session does not match this session name");
    }
    return session;
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
  }

  try {
    const legacySession = await readStoredSession(legacySessionPath(room), room);
    return legacySession.session_name === sessionName ? legacySession : undefined;
  } catch (error: unknown) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

async function loadSession(room: string): Promise<StoredSession> {
  if (activeSession?.room === room) {
    return activeSession;
  }

  const safeRoom = safeFilePart(room);
  const legacyFilename = `${safeRoom}.session.json`;
  let filenames: string[];
  try {
    filenames = await readdir(sessionDirectory);
  } catch (error: unknown) {
    if (!isMissingFile(error)) throw error;
    filenames = [];
  }
  const sessionFilenames = filenames.filter(
    (filename) =>
      filename !== legacyFilename &&
      filename.startsWith(`${safeRoom}.`) &&
      filename.endsWith(".session.json"),
  );
  if (sessionFilenames.length > 1) {
    throw new Error(
      `Multiple local sessions found for room ${room}; call bus_join again with an explicit session_name`,
    );
  }
  const sessionFilename = sessionFilenames[0];
  if (sessionFilename !== undefined) {
    return await readStoredSession(join(sessionDirectory, sessionFilename), room);
  }

  try {
    return await readStoredSession(legacySessionPath(room), room);
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      throw new Error(`No local session for room ${room}; call bus_join first`);
    }
    throw error;
  }
}

async function saveSession(session: StoredSession): Promise<void> {
  const destination = sessionPath(session.room, session.session_name);
  const temporary = `${destination}.${process.pid}.tmp`;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, destination);
}

async function loadAcommuneConfig(): Promise<z.infer<typeof acommuneConfigSchema>> {
  let raw: string;
  try {
    raw = await readFile(configFilePath, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      throw new Error(
        `No acommune config found at ${configFilePath}; pass room and pairing_code explicitly`,
      );
    }
    throw new Error(`Could not read acommune config at ${configFilePath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`Acommune config at ${configFilePath} is not valid JSON`);
  }
  const result = acommuneConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Acommune config at ${configFilePath} must contain non-empty room and code fields`,
    );
  }
  return result.data;
}

async function resolveJoinCredentials(
  room: string | undefined,
  pairingCode: string | undefined,
): Promise<{ room: string; pairingCode: string }> {
  if (room !== undefined && pairingCode !== undefined) {
    return { room, pairingCode };
  }
  const config = await loadAcommuneConfig();
  const resolvedRoom = room ?? config.room;
  if (pairingCode !== undefined) {
    return { room: resolvedRoom, pairingCode };
  }
  if (room !== undefined && room !== config.room) {
    throw new Error(
      `Acommune config is for room ${config.room}; pass pairing_code explicitly for room ${room}`,
    );
  }
  return { room: resolvedRoom, pairingCode: config.code };
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
    description:
      "Create or join a named acommune room and reserve a session name; pairing_code optional — read from ~/.acommune/config.json when omitted",
    inputSchema: {
      room: roomShape.room.optional(),
      session_name: z.string().trim().min(1).max(200),
      pairing_code: z.string().min(6).optional(),
    },
  },
  async ({ room, session_name, pairing_code }) => {
    try {
      const credentials = await resolveJoinCredentials(room, pairing_code);
      const existing = await loadJoinSession(credentials.room, session_name);
      const reclaimToken = existing?.reclaim_token;
      const requestBody = {
        session_name,
        pairing_code: credentials.pairingCode,
        ...(reclaimToken === undefined ? {} : { reclaim_token: reclaimToken }),
      };
      const roomPayload = await relayFetch("/rooms", {
        method: "POST",
        body: JSON.stringify({
          name: credentials.room,
          pairing_code: credentials.pairingCode,
        }),
      });
      roomResponseSchema.parse(roomPayload);
      const payload = await relayFetch(
        `/rooms/${encodeURIComponent(credentials.room)}/join`,
        { method: "POST", body: JSON.stringify(requestBody) },
      );
      const joined = joinResponseSchema.parse(payload);
      const session = {
        room: credentials.room,
        session_name,
        reclaim_token: joined.reclaim_token,
      };
      await saveSession(session);
      activeSession = session;
      return {
        content: [
          {
            type: "text" as const,
            text: `Joined ${credentials.room} as ${session_name}; identity saved locally.`,
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
