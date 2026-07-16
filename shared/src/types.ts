export const KINDS = [
  "progress",
  "claim",
  "question",
  "answer",
  "knowledge",
  "handoff",
  "task_update",
  "join",
  "heartbeat",
] as const;

export type Kind = (typeof KINDS)[number];

export interface TaskUpdateBody {
  task_seq: number;
  status: "claimed" | "done" | "dropped";
}

export interface Room {
  room_id: string;
  name: string;
  pairing_hash: string;
  created_at: string;
}

export interface SessionInfo {
  session_name: string;
  room_id: string;
  reclaim_token: string;
}

export interface Message {
  seq: number;
  prev_hash: string;
  hash: string;
  sender: string;
  kind: Kind;
  body: unknown;
  ts: string;
  client_msg_id?: string;
}

export interface SyncResult {
  received: Message[];
  sent: Message[];
  cursor: number;
  status: "ready" | "timeout" | "empty";
}
