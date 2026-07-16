import { appendFileSync } from "node:fs";

interface MockResponse {
  status?: number;
  body?: unknown;
  error?: boolean;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const responsesValue = process.env.ACOMMUNE_TEST_FETCH_RESPONSES;
const logPath = process.env.ACOMMUNE_TEST_FETCH_LOG;

if (responsesValue !== undefined && logPath !== undefined) {
  const parsed: unknown = JSON.parse(responsesValue);
  if (!Array.isArray(parsed) || !parsed.every(isJsonObject)) {
    throw new Error("Invalid test fetch responses");
  }
  const responses = parsed as MockResponse[];
  let responseIndex = 0;

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    appendFileSync(
      logPath,
      `${JSON.stringify({ method: init?.method ?? "GET", url, headers, body })}\n`,
      "utf8",
    );

    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined || response.error === true) {
      throw new TypeError("fetch failed");
    }
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
