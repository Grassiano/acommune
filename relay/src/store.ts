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

export interface BoardPresenceEntry {
  session_name: string;
  last_seen: string;
  current_claim?: unknown;
}

export interface BoardMessage {
  seq: number;
  sender: string;
  kind: Kind;
  body: unknown;
  ts: string;
}

export interface BoardState {
  room: string;
  presence: BoardPresenceEntry[];
  messages: BoardMessage[];
  verified: boolean;
}

export const BOARD_MESSAGE_BYTES_LIMIT = 256 * 1_024;
export const LIST_RESPONSE_BYTES_LIMIT = BOARD_MESSAGE_BYTES_LIMIT;
export const CLAIM_TTL_MS = 15 * 60 * 1_000;

export interface StatelessMessagesState {
  messages: Message[];
  last_seq: number;
}

export type TaskState = "open" | "claimed" | "done" | "dropped";

export interface DigestSession {
  name: string;
  last_seen: string;
  active_claims: string[];
}

export interface DigestTask {
  id: number;
  summary: string;
  to: string | null;
  state: TaskState;
  age_seconds: number;
}

export interface RoomDigest {
  room: string;
  verified: boolean;
  last_seq: number;
  sessions: DigestSession[];
  open_tasks: DigestTask[];
}

export interface ActiveClaim {
  session_name: string;
  path: string;
  claim_seq: number;
  refreshed_at: string;
  expires_at: string;
}

export interface ClaimLookupState {
  claims: ActiveClaim[];
}

interface RoomRow {
  room_id: string;
  name: string;
  pairing_hash: string;
  pairing_salt: string | null;
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

interface BoardPresenceRow {
  session_name: string;
  last_seen: string;
  current_claim_json: string | null;
}

interface LastSequenceRow {
  last_seq: number;
}

interface SessionDigestRow {
  session_name: string;
  last_seen: string;
}

interface ClaimRow {
  session_name: string;
  path: string;
  claim_seq: number;
  refreshed_at: string;
  expires_at: string;
}

interface TaskRow {
  task_seq: number;
  summary: string;
  to_name: string | null;
  state: TaskState;
  created_at: string;
}

interface CountRow {
  count: number;
}

interface TableColumnRow {
  name: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claimPaths(body: unknown): string[] {
  if (typeof body === "string") {
    return body.length === 0 ? [] : [body];
  }
  if (!isRecord(body)) {
    return [];
  }
  const files = body.files;
  if (Array.isArray(files)) {
    return [
      ...new Set(
        files.filter(
          (file): file is string => typeof file === "string" && file.length > 0,
        ),
      ),
    ];
  }
  return typeof body.file === "string" && body.file.length > 0
    ? [body.file]
    : [];
}

function handoffDetails(body: unknown): { summary: string; to: string | null } {
  if (typeof body === "string") {
    return { summary: body, to: null };
  }
  if (!isRecord(body)) {
    return { summary: "", to: null };
  }
  return {
    summary: typeof body.summary === "string" ? body.summary : "",
    to: typeof body.to === "string" ? body.to : null,
  };
}

function taskUpdate(
  body: unknown,
): { taskSequence: number; status: Exclude<TaskState, "open"> } | undefined {
  if (!isRecord(body) || !Number.isInteger(body.task_seq)) {
    return undefined;
  }
  if (
    body.status !== "claimed" &&
    body.status !== "done" &&
    body.status !== "dropped"
  ) {
    return undefined;
  }
  return {
    taskSequence: body.task_seq as number,
    status: body.status,
  };
}

export class RelayStore {
  readonly #database: DatabaseConnection;
  readonly #verificationCache = new Map<string, ChainVerification>();

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
        pairing_salt TEXT,
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
      CREATE TABLE IF NOT EXISTS derived_tasks (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        task_seq INTEGER NOT NULL,
        summary TEXT NOT NULL,
        to_name TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(room_id, task_seq)
      );
      CREATE INDEX IF NOT EXISTS derived_tasks_room_state
        ON derived_tasks(room_id, state, task_seq);
      CREATE TABLE IF NOT EXISTS derived_claims (
        room_id TEXT NOT NULL REFERENCES rooms(room_id) ON DELETE CASCADE,
        session_name TEXT NOT NULL,
        path TEXT NOT NULL,
        claim_seq INTEGER NOT NULL,
        refreshed_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY(room_id, session_name, path)
      );
      CREATE INDEX IF NOT EXISTS derived_claims_path
        ON derived_claims(room_id, path, expires_at);
      CREATE INDEX IF NOT EXISTS derived_claims_session
        ON derived_claims(room_id, session_name, expires_at, claim_seq);
    `);
    const roomColumns = this.#database
      .prepare("PRAGMA table_info(rooms)")
      .all() as TableColumnRow[];
    if (!roomColumns.some((column) => column.name === "pairing_salt")) {
      this.#database.exec("ALTER TABLE rooms ADD COLUMN pairing_salt TEXT");
    }
    this.#database.transaction(() => {
      const rooms = this.#database
        .prepare("SELECT room_id FROM rooms")
        .all() as RoomIdRow[];
      for (const room of rooms) {
        this.#rebuildDerivedState(room.room_id);
      }
    })();
  }

  close(): void {
    this.#database.close();
  }

  createRoom(
    name: string,
    pairingCode: string,
    maxRooms = Number.POSITIVE_INFINITY,
  ): CreateRoomResult {
    return this.#database.transaction(() => {
      const existing = this.#database
        .prepare("SELECT * FROM rooms WHERE name = ?")
        .get(name) as RoomRow | undefined;
      if (existing !== undefined) {
        if (!this.#pairingCodeMatches(existing, pairingCode)) {
          throw new RelayError(
            409,
            "ROOM_NAME_TAKEN",
            "Room name is already in use",
          );
        }
        this.#migratePairingHash(existing, pairingCode);
        return { room_id: existing.room_id, name: existing.name, created: false };
      }

      const roomCount = this.#database
        .prepare("SELECT COUNT(*) AS count FROM rooms")
        .get() as CountRow;
      if (roomCount.count >= maxRooms) {
        throw new RelayError(
          507,
          "ROOM_LIMIT_REACHED",
          "Relay room capacity has been reached",
        );
      }

      const roomId = randomUUID();
      const createdAt = new Date().toISOString();
      const pairingSalt = randomBytes(16).toString("hex");
      const pairingHash = sha256(pairingSalt + pairingCode);
      this.#database
        .prepare(
          `INSERT INTO rooms(
             room_id, name, pairing_hash, pairing_salt, created_at
           ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(roomId, name, pairingHash, pairingSalt, createdAt);
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
      this.#authenticatePairingCode(roomId, pairingCode);

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
    const result = verifyChain(rows.map(rowToMessage));
    this.#verificationCache.set(roomId, result);
    return result;
  }

  readMessages(
    roomId: string,
    pairingCode: string,
    afterSequence: number,
    kinds: readonly Kind[] | undefined,
    limit: number,
  ): StatelessMessagesState {
    this.#authenticatePairingCode(roomId, pairingCode);
    const kindClause =
      kinds === undefined
        ? ""
        : kinds.length === 0
          ? " AND 0"
          : ` AND kind IN (${kinds.map(() => "?").join(", ")})`;
    const rows = this.#database
      .prepare(
        `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                client_msg_id
           FROM messages
          WHERE room_id = ? AND seq > ?${kindClause}
          ORDER BY seq ASC
          LIMIT ?`,
      )
      .all(roomId, afterSequence, ...(kinds ?? []), limit) as MessageRow[];
    const messages: Message[] = [];
    let aggregateBytes = 0;
    for (const row of rows) {
      const nextBytes = Buffer.byteLength(row.body_json, "utf8");
      if (aggregateBytes + nextBytes > LIST_RESPONSE_BYTES_LIMIT) {
        break;
      }
      messages.push(rowToMessage(row));
      aggregateBytes += nextBytes;
    }
    if (messages.length > 0) {
      return { messages, last_seq: messages.at(-1)?.seq ?? afterSequence };
    }
    const latest = this.#database
      .prepare(
        "SELECT next_seq - 1 AS last_seq FROM room_seq WHERE room_id = ?",
      )
      .get(roomId) as LastSequenceRow;
    return { messages, last_seq: Math.max(afterSequence, latest.last_seq) };
  }

  digest(
    roomId: string,
    pairingCode: string,
    now = Date.now(),
  ): RoomDigest {
    const room = this.#authenticatePairingCode(roomId, pairingCode);
    const nowIso = new Date(now).toISOString();
    const sessionCutoffIso = new Date(now - 60 * 60 * 1_000).toISOString();
    const sessionRows = this.#database
      .prepare(
        `SELECT session_name, last_seen
           FROM sessions
          WHERE room_id = ? AND last_seen >= ?
          ORDER BY session_name
          LIMIT 5000`,
      )
      .all(roomId, sessionCutoffIso) as SessionDigestRow[];
    const claimRows = this.#database
      .prepare(
        `SELECT session_name, path, claim_seq, refreshed_at, expires_at
           FROM derived_claims
          WHERE room_id = ? AND expires_at > ?
          ORDER BY session_name, claim_seq DESC, path
          LIMIT 5000`,
      )
      .all(roomId, nowIso) as ClaimRow[];
    const claimsBySession = new Map<string, string[]>();
    for (const claim of claimRows) {
      const paths = claimsBySession.get(claim.session_name) ?? [];
      paths.push(claim.path);
      claimsBySession.set(claim.session_name, paths);
    }

    const sessions: DigestSession[] = [];
    let aggregateBytes = 0;
    for (const session of sessionRows) {
      const entry: DigestSession = {
        name: session.session_name,
        last_seen: session.last_seen,
        active_claims: claimsBySession.get(session.session_name) ?? [],
      };
      const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (aggregateBytes + nextBytes > LIST_RESPONSE_BYTES_LIMIT) {
        break;
      }
      sessions.push(entry);
      aggregateBytes += nextBytes;
    }

    const taskRows = this.#database
      .prepare(
        `SELECT task_seq, summary, to_name, state, created_at
           FROM derived_tasks
          WHERE room_id = ? AND state IN ('open', 'claimed')
          ORDER BY task_seq
          LIMIT 5000`,
      )
      .all(roomId) as TaskRow[];
    const openTasks: DigestTask[] = [];
    for (const task of taskRows) {
      const createdAt = Date.parse(task.created_at);
      const entry: DigestTask = {
        id: task.task_seq,
        summary: task.summary,
        to: task.to_name,
        state: task.state,
        age_seconds: Number.isNaN(createdAt)
          ? 0
          : Math.max(0, Math.floor((now - createdAt) / 1_000)),
      };
      const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (aggregateBytes + nextBytes > LIST_RESPONSE_BYTES_LIMIT) {
        break;
      }
      openTasks.push(entry);
      aggregateBytes += nextBytes;
    }
    const latest = this.#database
      .prepare(
        "SELECT next_seq - 1 AS last_seq FROM room_seq WHERE room_id = ?",
      )
      .get(roomId) as LastSequenceRow;
    return {
      room: room.name,
      verified: this.#cachedVerification(roomId).ok,
      last_seq: latest.last_seq,
      sessions,
      open_tasks: openTasks,
    };
  }

  claims(
    roomId: string,
    pairingCode: string,
    file: string,
    now = Date.now(),
  ): ClaimLookupState {
    this.#authenticatePairingCode(roomId, pairingCode);
    const candidates = new Set<string>([file]);
    for (let index = file.indexOf("/"); index >= 0; index = file.indexOf("/", index + 1)) {
      candidates.add(file.slice(0, index + 1));
    }
    const exactPaths = [...candidates];
    const descendantClause = file.endsWith("/")
      ? " OR (path >= ? AND path < ?)"
      : "";
    const upperBound = `${file}\uffff`;
    const rows = this.#database
      .prepare(
        `SELECT session_name, path, claim_seq, refreshed_at, expires_at
           FROM derived_claims
          WHERE room_id = ?
            AND expires_at > ?
            AND (path IN (${exactPaths.map(() => "?").join(", ")})${descendantClause})
          ORDER BY claim_seq DESC, session_name, path
          LIMIT 500`,
      )
      .all(
        roomId,
        new Date(now).toISOString(),
        ...exactPaths,
        ...(file.endsWith("/") ? [file, upperBound] : []),
      ) as ClaimRow[];
    const claims: ActiveClaim[] = [];
    let aggregateBytes = 0;
    for (const row of rows) {
      const entry: ActiveClaim = { ...row };
      const nextBytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (aggregateBytes + nextBytes > LIST_RESPONSE_BYTES_LIMIT) {
        break;
      }
      claims.push(entry);
      aggregateBytes += nextBytes;
    }
    return { claims };
  }

  rotateCode(roomId: string, currentCode: string, newCode: string): void {
    this.#database.transaction(() => {
      this.#authenticatePairingCode(roomId, currentCode);
      const salt = randomBytes(16).toString("hex");
      this.#database
        .prepare(
          "UPDATE rooms SET pairing_hash = ?, pairing_salt = ? WHERE room_id = ?",
        )
        .run(sha256(salt + newCode), salt, roomId);
    })();
  }

  rebuildDerivedState(roomId: string): void {
    this.#database.transaction(() => this.#rebuildDerivedState(roomId))();
  }

  board(roomId: string, pairingCode: string): BoardState {
    const room = this.#authenticatePairingCode(roomId, pairingCode);
    const cutoff = new Date(Date.now() - 30 * 60 * 1_000).toISOString();
    // A claim is current only while it is the session's latest
    // claim/progress/handoff event; later progress or handoff supersedes it.
    const presenceRows = this.#database
      .prepare(
        `SELECT s.session_name, s.last_seen,
                (
                  SELECT CASE
                           WHEN m.kind = 'claim' AND EXISTS (
                             SELECT 1
                               FROM derived_claims AS c
                              WHERE c.room_id = m.room_id
                                AND c.session_name = m.sender
                                AND c.claim_seq = m.seq
                                AND c.expires_at > ?
                           )
                           THEN m.body_json
                           ELSE NULL
                         END
                    FROM messages AS m
                   WHERE m.room_id = s.room_id
                     AND m.sender = s.session_name
                     AND m.kind IN ('claim', 'progress', 'handoff')
                   ORDER BY m.seq DESC
                   LIMIT 1
                ) AS current_claim_json
           FROM sessions AS s
          WHERE s.room_id = ? AND s.last_seen >= ?
          ORDER BY s.session_name`,
      )
      .all(new Date().toISOString(), roomId, cutoff) as BoardPresenceRow[];
    const presence = presenceRows.map((entry): BoardPresenceEntry => {
      const base = {
        session_name: entry.session_name,
        last_seen: entry.last_seen,
      };
      return entry.current_claim_json === null
        ? base
        : {
            ...base,
            current_claim: JSON.parse(entry.current_claim_json) as unknown,
          };
    });

    const rows = this.#database
      .prepare(
        `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                client_msg_id
           FROM messages
          WHERE room_id = ?
          ORDER BY seq DESC
          LIMIT 200`,
      )
      .all(roomId) as MessageRow[];
    const boundedRows: MessageRow[] = [];
    let messageBytes = 0;
    for (const row of rows) {
      const nextBytes = Buffer.byteLength(row.body_json, "utf8");
      if (messageBytes + nextBytes > BOARD_MESSAGE_BYTES_LIMIT) {
        break;
      }
      boundedRows.push(row);
      messageBytes += nextBytes;
    }
    const messages = boundedRows.reverse().map((row): BoardMessage => {
      const message = rowToMessage(row);
      return {
        seq: message.seq,
        sender: message.sender,
        kind: message.kind,
        body: message.body,
        ts: message.ts,
      };
    });

    return {
      room: room.name,
      presence,
      messages,
      verified: this.#cachedVerification(roomId).ok,
    };
  }

  #authenticatePairingCode(roomId: string, pairingCode: string): RoomRow {
    const room = this.#database
      .prepare("SELECT * FROM rooms WHERE room_id = ?")
      .get(roomId) as RoomRow | undefined;
    if (room === undefined) {
      throw new RelayError(404, "ROOM_NOT_FOUND", "Room not found");
    }
    if (!this.#pairingCodeMatches(room, pairingCode)) {
      throw new RelayError(401, "INVALID_PAIRING_CODE", "Invalid pairing code");
    }
    this.#migratePairingHash(room, pairingCode);
    return room;
  }

  #pairingCodeMatches(room: RoomRow, pairingCode: string): boolean {
    const candidate =
      room.pairing_salt === null
        ? sha256(pairingCode)
        : sha256(room.pairing_salt + pairingCode);
    return secureEqual(room.pairing_hash, candidate);
  }

  #migratePairingHash(room: RoomRow, pairingCode: string): void {
    if (room.pairing_salt !== null) {
      return;
    }
    const salt = randomBytes(16).toString("hex");
    this.#database
      .prepare(
        "UPDATE rooms SET pairing_hash = ?, pairing_salt = ? WHERE room_id = ?",
      )
      .run(sha256(salt + pairingCode), salt, room.room_id);
    room.pairing_salt = salt;
    room.pairing_hash = sha256(salt + pairingCode);
  }

  #cachedVerification(roomId: string): ChainVerification {
    return this.#verificationCache.get(roomId) ?? this.verify(roomId);
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
    this.#verificationCache.delete(roomId);

    const base: Message = {
      seq: sequence.next_seq,
      prev_hash: previousHash,
      hash,
      sender,
      kind,
      body,
      ts: createdAt,
    };
    const message = clientMsgId === undefined
      ? base
      : { ...base, client_msg_id: clientMsgId };
    this.#applyDerivedMessage(roomId, message);
    return message;
  }

  #rebuildDerivedState(roomId: string): void {
    const room = this.#database
      .prepare("SELECT 1 FROM rooms WHERE room_id = ?")
      .get(roomId);
    if (room === undefined) {
      throw new RelayError(404, "ROOM_NOT_FOUND", "Room not found");
    }
    this.#database
      .prepare("DELETE FROM derived_claims WHERE room_id = ?")
      .run(roomId);
    this.#database
      .prepare("DELETE FROM derived_tasks WHERE room_id = ?")
      .run(roomId);
    const rows = this.#database
      .prepare(
        `SELECT seq, prev_hash, hash, sender, kind, body_json, created_at,
                client_msg_id
           FROM messages
          WHERE room_id = ?
          ORDER BY seq`,
      )
      .all(roomId) as MessageRow[];
    for (const row of rows) {
      this.#applyDerivedMessage(roomId, rowToMessage(row));
    }
  }

  #applyDerivedMessage(roomId: string, message: Message): void {
    if (message.kind === "handoff") {
      const details = handoffDetails(message.body);
      this.#database
        .prepare(
          `INSERT OR IGNORE INTO derived_tasks(
             room_id, task_seq, summary, to_name, state, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'open', ?, ?)`,
        )
        .run(
          roomId,
          message.seq,
          details.summary,
          details.to,
          message.ts,
          message.ts,
        );
      return;
    }

    if (message.kind === "task_update") {
      const update = taskUpdate(message.body);
      if (update === undefined) {
        return;
      }
      const validPriorState =
        update.status === "claimed" ? "open" : "claimed";
      this.#database
        .prepare(
          `UPDATE derived_tasks
              SET state = ?, updated_at = ?
            WHERE room_id = ? AND task_seq = ? AND state = ?`,
        )
        .run(
          update.status,
          message.ts,
          roomId,
          update.taskSequence,
          validPriorState,
        );
      return;
    }

    if (message.kind !== "claim") {
      return;
    }
    const refreshedAt = message.ts;
    const timestamp = Date.parse(refreshedAt);
    const expiresAt = new Date(
      (Number.isNaN(timestamp) ? 0 : timestamp) + CLAIM_TTL_MS,
    ).toISOString();
    for (const path of claimPaths(message.body)) {
      this.#database
        .prepare(
          `INSERT INTO derived_claims(
             room_id, session_name, path, claim_seq, refreshed_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(room_id, session_name, path) DO UPDATE SET
             claim_seq = excluded.claim_seq,
             refreshed_at = excluded.refreshed_at,
             expires_at = excluded.expires_at`,
        )
        .run(
          roomId,
          message.sender,
          path,
          message.seq,
          refreshedAt,
          expiresAt,
        );
    }
  }
}
