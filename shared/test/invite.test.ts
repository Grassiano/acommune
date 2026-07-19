import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { decodeInvite, encodeInvite } from "../src/index.js";

function tokenFor(value: unknown): string {
  return `acm1_${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}`;
}

describe("invite tokens", () => {
  it("round-trips relay, room, and code", () => {
    const invite = {
      relay: "https://relay.example.com",
      room: "my-room",
      code: "abcdef123456",
    };
    assert.deepEqual(decodeInvite(encodeInvite(invite)), invite);
  });

  it("rejects a missing version prefix", () => {
    assert.throws(() => decodeInvite("not-an-invite"), /acm1_ prefix/);
  });

  it("rejects non-base64url garbage", () => {
    assert.throws(() => decodeInvite("acm1_%%%"), /base64url/);
  });

  it("rejects a truncated token", () => {
    const token = encodeInvite({
      relay: "https://relay.example.com",
      room: "my-room",
      code: "abcdef123456",
    });
    assert.throws(() => decodeInvite(token.slice(0, -5)), /JSON|base64url|UTF-8/);
  });

  it("rejects a payload missing a required field", () => {
    assert.throws(
      () => decodeInvite(tokenFor({ r: "https://relay.example.com", o: "my-room" })),
      /exactly the r, o, and c fields/,
    );
  });

  it("rejects an invalid relay URL", () => {
    assert.throws(
      () => decodeInvite(tokenFor({ r: "not a url", o: "my-room", c: "abcdef" })),
      /invalid relay URL/,
    );
  });

  it("rejects non-HTTP relay URL schemes", () => {
    assert.throws(
      () => decodeInvite(tokenFor({ r: "javascript:alert(1)", o: "my-room", c: "abcdef" })),
      /javascript:.*not allowed/,
    );
  });

  it("rejects a code shorter than the relay minimum", () => {
    assert.throws(
      () => decodeInvite(tokenFor({ r: "https://relay.example.com", o: "my-room", c: "short" })),
      /too short/,
    );
  });
});
