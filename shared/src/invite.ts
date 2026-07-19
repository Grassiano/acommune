export interface Invite {
  relay: string;
  room: string;
  code: string;
}

const INVITE_PREFIX = "acm1_";

function inviteError(message: string): Error {
  return new Error(`Invalid invite token: ${message}`);
}

export function encodeInvite(input: Invite): string {
  const payload = JSON.stringify({ r: input.relay, o: input.room, c: input.code });
  return `${INVITE_PREFIX}${Buffer.from(payload, "utf8").toString("base64url")}`;
}

export function decodeInvite(token: string): Invite {
  if (!token.startsWith(INVITE_PREFIX)) {
    throw inviteError("unrecognized format; expected the acm1_ prefix");
  }

  const encoded = token.slice(INVITE_PREFIX.length);
  if (
    encoded.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    throw inviteError("invalid base64url payload");
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw inviteError("invalid base64url or UTF-8 payload");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw inviteError("payload is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw inviteError("payload must be an object with r, o, and c fields");
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 3 ||
    !keys.includes("r") ||
    !keys.includes("o") ||
    !keys.includes("c")
  ) {
    throw inviteError("payload must contain exactly the r, o, and c fields");
  }
  if (typeof record.r !== "string" || record.r.trim().length === 0) {
    throw inviteError("relay field r must be a non-empty string");
  }
  if (typeof record.o !== "string" || record.o.trim().length === 0) {
    throw inviteError("room field o must be a non-empty string");
  }
  if (typeof record.c !== "string" || record.c.trim().length === 0) {
    throw inviteError("code field c must be a non-empty string");
  }

  let relayUrl: URL;
  try {
    relayUrl = new URL(record.r);
  } catch {
    throw inviteError("invalid relay URL");
  }
  if (relayUrl.protocol !== "http:" && relayUrl.protocol !== "https:") {
    throw inviteError(`relay URL scheme ${relayUrl.protocol} is not allowed; use http or https`);
  }
  if (record.c.length < 6) {
    throw inviteError("code is too short; expected at least 6 characters");
  }

  return {
    relay: record.r.replace(/\/+$/, ""),
    room: record.o,
    code: record.c,
  };
}
