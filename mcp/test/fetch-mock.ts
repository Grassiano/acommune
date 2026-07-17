interface MockResponse {
  status?: number;
  body?: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const responsesValue = process.env.ACOMMUNE_TEST_FETCH_RESPONSES;
const expectedPairingCode = process.env.ACOMMUNE_TEST_PAIRING_CODE;

if (responsesValue !== undefined) {
  const parsed: unknown = JSON.parse(responsesValue);
  if (!Array.isArray(parsed) || !parsed.every(isJsonObject)) {
    throw new Error("Invalid test fetch responses");
  }
  const responses = parsed as MockResponse[];
  let responseIndex = 0;

  globalThis.fetch = (async (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body) as unknown;
    }
    if (
      expectedPairingCode !== undefined &&
      (!isJsonObject(body) || body.pairing_code !== expectedPairingCode)
    ) {
      return new Response(
        JSON.stringify({ error: { message: "Unexpected pairing credential" } }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }

    const response = responses[responseIndex];
    responseIndex += 1;
    if (response === undefined) {
      throw new TypeError("No test fetch response available");
    }
    return new Response(JSON.stringify(response.body ?? {}), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}
