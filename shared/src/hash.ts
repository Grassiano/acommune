import { createHash } from "node:crypto";

import type { Kind, Message } from "./types.js";

export const GENESIS_HASH = "genesis";

export function messageHash(
  prevHash: string,
  seq: number,
  sender: string,
  kind: Kind,
  body: unknown,
): string {
  return createHash("sha256")
    .update(prevHash + String(seq) + sender + kind + JSON.stringify(body))
    .digest("hex");
}

export type ChainVerification =
  | { ok: true }
  | { ok: false; badSeq: number };

export function verifyChain(messages: readonly Message[]): ChainVerification {
  let previousHash = GENESIS_HASH;
  let expectedSequence = 1;

  for (const message of messages) {
    const expected = messageHash(
      previousHash,
      message.seq,
      message.sender,
      message.kind,
      message.body,
    );
    if (
      message.seq !== expectedSequence ||
      message.prev_hash !== previousHash ||
      message.hash !== expected
    ) {
      return { ok: false, badSeq: message.seq };
    }
    previousHash = message.hash;
    expectedSequence += 1;
  }

  return { ok: true };
}
