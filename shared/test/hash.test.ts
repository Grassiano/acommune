import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GENESIS_HASH,
  messageHash,
  verifyChain,
  type Message,
} from "../src/index.js";

describe("message hash chain", () => {
  it("uses the protocol concatenation and detects tampering", () => {
    const firstHash = messageHash(GENESIS_HASH, 1, "alice", "progress", {
      step: 1,
    });
    assert.equal(
      firstHash,
      "f379c0cb6968db52e29e5102e507d4a88ca3b40d57c414db3fa4034422b8d3b9",
    );

    const secondHash = messageHash(firstHash, 2, "bob", "answer", "done");
    const messages: Message[] = [
      {
        seq: 1,
        prev_hash: GENESIS_HASH,
        hash: firstHash,
        sender: "alice",
        kind: "progress",
        body: { step: 1 },
        ts: "2026-01-01T00:00:00.000Z",
      },
      {
        seq: 2,
        prev_hash: firstHash,
        hash: secondHash,
        sender: "bob",
        kind: "answer",
        body: "done",
        ts: "2026-01-01T00:00:01.000Z",
      },
    ];

    assert.deepEqual(verifyChain(messages), { ok: true });
    messages[1] = { ...messages[1]!, body: "tampered" };
    assert.deepEqual(verifyChain(messages), { ok: false, badSeq: 2 });
  });
});
