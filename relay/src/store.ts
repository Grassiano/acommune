import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import {
  GENESIS_HASH,
  messageHash,
  verifyChain,
  type ChainVerification,
  type Kind,
  type Message,
} from "acommune-shared";
import { openDatabase, type DatabaseConnection } from "./sqlite.js";

export interface OutboxItem {
  kind: Kind;
  body: unknown;
  client_msg_id?: string;
}

export interface JoinResult {
  reclaim_token: string;
  cursor: number;
}

export interface StoreSyncResult {
  received: Message[];
  sent: Message[];
  cursor: number;
  inserted: boolean;
}

export interface PresenceEntry {
  session_name: string;
  created_at: string;
  last_seen: string;
}

interface RoomRow {
  room_id: string;
  name: string;
  pairing_hash: string;
  created_at: string;
}

interface RoomIdRow {
  room_id: string;
}

export interface CreateRoomResult {
  room_id: string;
  name: string;
  created: boolean;
}

interface SessionRow {
  reclaim_token: string;
}

interface CursorRow {
  last_seq: number;
}

interface SequenceRow {
  next_seq: number;
}

interface HashRow {
  hash: string;
}

interface MessageRow {
  seq: number;
  prev_hash: string;
  hash: string;
  sender: string;
  kind: Kind;
  body_json: string;
  created_at: string;
  client_msg_id: string | null;
}

export class RelayError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RelayError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function rowToMessage(row: MessageRow): Message {
  const base: Message = {
    seq: row.seq,
    prev_hash: row.prev_hash,
    hash: row.hash,
    sender: row.sender,
    kind: row.kind,
    body: JSON.parse(row.body_json) as unknown,
    ts: row.created_at,
  };
  return row.client_msg_id === null
    ? base
    : { ...base, client_msg_id: row.client_msg_id };
}

export class RelayStore {
  readonly #database: DatabaseConnection;

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }
    this.#database = openDatabase(databasePath);
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("foreign_keys = ON");
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        pairing_hash TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS rooms_name ON rooms(name);
      CREATE TABLE IF NOT EXISTS room_seq (
        room_id TEXT PRIMARY KEY REFERENCES rooms(room_id) ON DELETE CASCADE,
        next_seq INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        sender TEXT NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL,
        client_msg_id TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(room_id, seq)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id
        ON messages(room_id, sender, client_msg_id)
        WHERE client_msg_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS cursors (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        session_name TEXT NOT NULL,
        last_seq INTEGER NOT NULL,
        PRIMARY KEY(room_id, session_name)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        session_name TEXT NOT NULL,
        reclaim_token TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY(room_id, session_name)
      );
    `);
  }

  close(): void {
    this.#database.close();
  }

  createRoom(name: string, pairingCode: string): CreateRoomResult {
    return this.#database.transaction(() => {
      const pairingHash = sha256(pairingCode);
      const existing = this.#database
        .prepare("SELECT * FROM rooms WHERE name = ?")
        .get(name) as RoomRow | undefined;
      if (existing !== undefined) {
        if (!secureEqual(existing.pairing_hash, pairingHash)) {
          throw new RelayError(
            409,
            "ROOM_NAME_TAKEN",
            "Room name is already in use",
          );
        }
        return { room_id: existing.room_id, name: existing.name, created: false };
      }

      const roomId = randomUUID();
      const createdAt = new Date().toISOString();
      this.#database
        .prepare(
          "INSERT INTO rooms(room_id, name, pairing_hash, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(roomId, name, pairingHash, createdAt);
      this.#database
        .prepare("INSERT INTO room_seq(room_id, next_seq) VALUES (?, 1)")
        .run(roomId);
      return { room_id: roomId, name, created: true };
    })();
  }

  resolveRoomId(name: string): string {
    const room = this.#database
      .prepare("SELECT room_id FROM rooms WHERE name = ?")
      .get(name) as RoomIdRow | undefined;
    if (room === undefined) {
      throw new RelayError(404, "ROOM_NOT_FOUND", "Room not found");
    }
    return room.room_id;
  }

  join(
    roomId: string,
    sessionName: string,
    pairingCode: string,
    suppliedReclaimToken?: string,
  ): JoinResult {
    return this.#database.transaction(() => {
      const room = this.#database
        .prepare("SELECT * FROM rooms WHERE room_id = ?")
        .get(roomId) as RoomRow | undefined;
      if (room === undefined) {
        throw new RelayError(404, "ROOM_NOT_FOUND", "Room not found");
      }
      if (!secureEqual(room.pairing_hash, sha256(pairingCode))) {
        throw new RelayError(401, "INVALID_PAIRING_CODE", "Invalid pairing code");
      }

      const existing = this.#database
        .prepare(
          "SELECT reclaim_token FROM sessions WHERE room_id = ? AND session_name = ?",
        )
        .get(roomId, sessionName) as SessionRow | undefined;
      const now = new Date().toISOString();
      let reclaimToken: string;

      if (existing !== undefined) {
        if (
          suppliedReclaimToken === undefined ||
          !secureEqual(existing.reclaim_token, suppliedReclaimToken)
        ) {
          throw new RelayError(
            409,
            "AGENT_NAME_IN_USE",
            "Session name is already reserved",
          );
        }
        reclaimToken = existing.reclaim_token;
        this.#database
          .prepare(
            "UPDATE sessions SET last_seen = ? WHERE room_id = ? AND session_name = ?",
          )
          .run(now, roomId, sessionName);
      } else {
        reclaimToken = randomBytes(24).toString("hex");
        this.#database
          .prepare(
            `INSERT INTO sessions(
              room_id, session_name, reclaim_token, created_at, last_seen
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(roomId, sessionName, reclaimToken, now, now);
        this.#database
          .prepare(
            "INSERT INTO cursors(room_id, session_name, last_seq) VALUES (?, ?, 0)",
          )
          .run(roomId, sessionName);
      }

      this.#appendMessage(roomId, sessionName, "join", {
        session_name: sessionName,
        reclaimed: existing !== undefined,
      });

      const cursor = this.#database
        .prepare(
          "SELECT last_seq FROM cursors WHERE room_id = ? AND session_name = ?",
        )
        .get(roomId, sessionName) as CursorRow;
      return { reclaim_token: reclaimToken, cursor: cursor.last_seq };
    })();
  }

  sync(
    roomId: string,
    sessionName: string,
    reclaimToken: string,
    outbox: readonly OutboxItem[],
    maxItems: number,
  ): StoreSyncResult {
    return this.#database.transaction(() => {
      this.#authenticate(roomId, sessionName, reclaimToken);
      const sent: Message[] = [];
      let inserted = false;

      for (const item of outbox) {
        if (item.client_msg_id !== undefined) {
          const duplicate = this.#database
            .prepare(
              `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                      client_msg_id
                 FROM messages
                WHERE room_id = ? AND sender = ? AND client_msg_id = ?`,
            )
            .get(roomId, sessionName, item.client_msg_id) as
            | MessageRow
            | undefined;
          if (duplicate !== undefined) {
            sent.push(rowToMessage(duplicate));
            continue;
          }
        }
        sent.push(
          this.#appendMessage(
            roomId,
            sessionName,
            item.kind,
            item.body,
            item.client_msg_id,
          ),
        );
        inserted = true;
      }

      const cursorRow = this.#database
        .prepare(
          "SELECT last_seq FROM cursors WHERE room_id = ? AND session_name = ?",
        )
        .get(roomId, sessionName) as CursorRow;
      const rows = this.#database
        .prepare(
          `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                  client_msg_id
             FROM messages
            WHERE room_id = ? AND seq > ?
            ORDER BY seq ASC
            LIMIT ?`,
        )
        .all(roomId, cursorRow.last_seq, maxItems) as MessageRow[];
      const received = rows.map(rowToMessage);
      const cursor = received.at(-1)?.seq ?? cursorRow.last_seq;
      const now = new Date().toISOString();
      this.#database
        .prepare(
          "UPDATE cursors SET last_seq = ? WHERE room_id = ? AND session_name = ?",
        )
        .run(cursor, roomId, sessionName);
      this.#database
        .prepare(
          "UPDATE sessions SET last_seen = ? WHERE room_id = ? AND session_name = ?",
        )
        .run(now, roomId, sessionName);

      return { received, sent, cursor, inserted };
    })();
  }

  presence(roomId: string, reclaimToken: string): PresenceEntry[] {
    const authenticated = this.#database
      .prepare(
        "SELECT 1 FROM sessions WHERE room_id = ? AND reclaim_token = ? LIMIT 1",
      )
      .get(roomId, reclaimToken);
    if (authenticated === undefined) {
      throw new RelayError(401, "INVALID_RECLAIM_TOKEN", "Invalid reclaim token");
    }
    const cutoff = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
    return this.#database
      .prepare(
        `SELECT session_name, created_at, last_seen
           FROM sessions
          WHERE room_id = ? AND last_seen >= ?
          ORDER BY session_name`,
      )
      .all(roomId, cutoff) as PresenceEntry[];
  }

  verify(roomId: string): ChainVerification {
    const room = this.#database
      .prepare("SELECT 1 FROM rooms WHERE room_id = ?")
      .get(roomId);
    if (room === undefined) {
      throw new RelayError(404, "ROOM_NOT_FOUND", "Room not found");
    }
    const rows = this.#database
      .prepare(
        `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                client_msg_id
           FROM messages
          WHERE room_id = ?
          ORDER BY seq ASC`,
      )
      .all(roomId) as MessageRow[];
    return verifyChain(rows.map(rowToMessage));
  }

  #authenticate(
    roomId: string,
    sessionName: string,
    reclaimToken: string,
  ): void {
    const session = this.#database
      .prepare(
        "SELECT reclaim_token FROM sessions WHERE room_id = ? AND session_name = ?",
      )
      .get(roomId, sessionName) as SessionRow | undefined;
    if (
      session === undefined ||
      !secureEqual(session.reclaim_token, reclaimToken)
    ) {
      throw new RelayError(401, "INVALID_RECLAIM_TOKEN", "Invalid reclaim token");
    }
  }

  #appendMessage(
    roomId: string,
    sender: string,
    kind: Kind,
    body: unknown,
    clientMsgId?: string,
  ): Message {
    const sequence = this.#database
      .prepare("SELECT next_seq FROM room_seq WHERE room_id = ?")
      .get(roomId) as SequenceRow;
    const previous = this.#database
      .prepare(
        "SELECT hash FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT 1",
      )
      .get(roomId) as HashRow | undefined;
    const previousHash = previous?.hash ?? GENESIS_HASH;
    const bodyJson = JSON.stringify(body);
    if (bodyJson === undefined) {
      throw new RelayError(400, "INVALID_BODY", "Message body must be JSON serializable");
    }
    const hash = messageHash(previousHash, sequence.next_seq, sender, kind, body);
    const createdAt = new Date().toISOString();
    this.#database
      .prepare(
        `INSERT INTO messages(
          room_id, seq, sender, kind, body_json, prev_hash, hash,
          client_msg_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roomId,
        sequence.next_seq,
        sender,
        kind,
        bodyJson,
        previousHash,
        hash,
        clientMsgId ?? null,
        createdAt,
      );
    this.#database
      .prepare("UPDATE room_seq SET next_seq = next_seq + 1 WHERE room_id = ?")
      .run(roomId);

    const base: Message = {
      seq: sequence.next_seq,
      prev_hash: previousHash,
      hash,
      sender,
      kind,
      body,
      ts: createdAt,
    };
    return clientMsgId === undefined
      ? base
      : { ...base, client_msg_id: clientMsgId };
  }
}
