import { appendFileSync, readFileSync } from "node:fs";

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const messagesPath = process.env.ACOMMUNE_HARVEST_TEST_MESSAGES;
const requestLogPath = process.env.ACOMMUNE_HARVEST_TEST_REQUEST_LOG;

if (messagesPath !== undefined && requestLogPath !== undefined) {
  const value: unknown = JSON.parse(readFileSync(messagesPath, "utf8"));
  if (!Array.isArray(value) || !value.every(isJsonObject)) {
    throw new Error("Invalid harvest mock messages");
  }
  const messages: JsonObject[] = value;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((headerValue, key) => headers.set(key, headerValue));
    appendFileSync(
      requestLogPath,
      `${JSON.stringify({ url: `${url.pathname}${url.search}`, headers: Object.fromEntries(headers.entries()) })}\n`,
      "utf8",
    );

    const afterSeq = Number(url.searchParams.get("after_seq"));
    const limit = Number(url.searchParams.get("limit"));
    const kinds = new Set((url.searchParams.get("kinds") ?? "").split(","));
    const selected = messages.filter((message) =>
      typeof message.seq === "number" &&
      message.seq > afterSeq &&
      typeof message.kind === "string" &&
      kinds.has(message.kind)
    ).slice(0, limit);
    const lastMessage = selected.at(-1);
    const lastKnown = messages.at(-1);
    const selectedSequence = isJsonObject(lastMessage) && typeof lastMessage.seq === "number"
      ? lastMessage.seq
      : undefined;
    const knownSequence = isJsonObject(lastKnown) && typeof lastKnown.seq === "number"
      ? lastKnown.seq
      : 0;
    return new Response(JSON.stringify({
      messages: selected,
      last_seq: selectedSequence ?? Math.max(afterSeq, knownSequence),
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
