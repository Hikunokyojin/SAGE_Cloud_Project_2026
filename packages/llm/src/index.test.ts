import { describe, it, expect, vi, beforeEach } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);
const keys: Record<string, string | undefined> = {};
vi.mock("@sage/secrets", () => ({
  resolveSecret: vi.fn(async (env: string) => {
    if (!keys[env]) throw new Error(`no ${env}`);
    return keys[env];
  }),
}));
const bedrockSend = vi.fn();
vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn(function () {
    return { send: bedrockSend };
  }),
  ConverseCommand: vi.fn(function (input: unknown) {
    return { input };
  }),
}));

function ok(text: string) {
  return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) };
}
function fail(status: number, body = "rate limited") {
  return { ok: false, status, text: async () => body };
}
const req = { system: "sys", user: "hello", maxTokens: 100, temperature: 0, seed: 42, timeoutMs: 50 };
const url = (i: number) => String(fetchMock.mock.calls[i][0]);
const body = (i: number) => JSON.parse(fetchMock.mock.calls[i][1].body);

describe("chat with fallback", () => {
  let llm: typeof import("./index");
  beforeEach(async () => {
    vi.resetModules();
    fetchMock.mockReset();
    bedrockSend.mockReset();
    keys.GROQ_API_KEY = "g";
    keys.CEREBRAS_API_KEY = "c";
    keys.OPENROUTER_API_KEY = "o";
    delete process.env.LLM_PROVIDERS;
    llm = await import("./index");
  });

  it("uses Groq first, with deterministic settings and the JSON schema", async () => {
    fetchMock.mockResolvedValue(ok("hi"));
    const out = await llm.chat({ ...req, jsonSchema: { name: "x", schema: { type: "object" } } });
    expect(out).toMatchObject({ text: "hi", provider: "groq", usage: { totalTokens: 15 } });
    expect(url(0)).toContain("api.groq.com");
    expect(body(0)).toMatchObject({ temperature: 0, seed: 42, reasoning_effort: "low", response_format: { type: "json_schema" } });
  });

  it("falls back to OpenRouter on a Groq 429 and still logs the Groq error for the quota alarm", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok("from openrouter"));
    const out = await llm.chat({ ...req, jsonSchema: { name: "x", schema: { type: "object" } } });
    expect(out).toMatchObject({ text: "from openrouter", provider: "openrouter", model: "openrouter/free", fallbackFrom: ["groq"] });
    expect(url(1)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(fetchMock.mock.calls[1][1].headers["X-Title"]).toBe("SAGE");
    expect(body(1).response_format).toEqual({ type: "json_object" });
    expect(body(1).reasoning_effort).toBeUndefined();
    expect(warn.mock.calls.flat().join(" ")).toContain("Groq API error (429)");
  });

  it("gives up on a provider that does not answer within the timeout", async () => {
    fetchMock.mockImplementationOnce((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))
    );
    fetchMock.mockResolvedValueOnce(ok("fast"));
    const out = await llm.chat(req);
    expect(out.provider).toBe("openrouter");
  });

  it("opens the circuit after 3 failures in a row and skips that provider until it cools down", async () => {
    let now = 1_000;
    llm._setClock(() => now);
    fetchMock.mockImplementation(async (u: string) => (u.includes("groq") ? fail(503, "down") : ok("c")));
    for (let i = 0; i < 3; i++) await llm.chat(req);
    fetchMock.mockClear();
    await llm.chat(req);
    expect(fetchMock.mock.calls.every(([u]) => !String(u).includes("groq"))).toBe(true);
    now += 61_000; // cooled down: Groq is tried again
    fetchMock.mockClear();
    await llm.chat(req);
    expect(url(0)).toContain("groq");
  });

  it("skips a provider with no key, and fails with every reason when nothing answers", async () => {
    keys.OPENROUTER_API_KEY = undefined;
    fetchMock.mockResolvedValue(fail(500, "boom"));
    await expect(llm.chat(req)).rejects.toThrow(/groq: .*500.*openrouter: .*no OPENROUTER_API_KEY/s);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses Bedrock (Converse) when it is listed first", async () => {
    process.env.LLM_PROVIDERS = "bedrock,groq";
    vi.resetModules();
    llm = await import("./index");
    bedrockSend.mockResolvedValue({ output: { message: { content: [{ text: "from bedrock" }] } }, usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 } });
    const out = await llm.chat(req);
    expect(out).toMatchObject({ text: "from bedrock", provider: "bedrock", usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 } });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Cerebras stays available as an opt-in provider", () => {
  it("is used when listed in LLM_PROVIDERS", async () => {
    vi.resetModules();
    fetchMock.mockReset();
    keys.CEREBRAS_API_KEY = "c";
    process.env.LLM_PROVIDERS = "cerebras";
    const llm = await import("./index");
    fetchMock.mockResolvedValue(ok("c"));
    expect((await llm.chat(req)).provider).toBe("cerebras");
    expect(url(0)).toContain("api.cerebras.ai");
    delete process.env.LLM_PROVIDERS;
  });
});

describe("fallback time limit", () => {
  it("gives the fallback provider its own, longer time limit (free models answer slowly)", async () => {
    vi.resetModules();
    fetchMock.mockReset();
    keys.GROQ_API_KEY = "g";
    keys.OPENROUTER_API_KEY = "o";
    const llm = await import("./index");
    fetchMock.mockResolvedValueOnce(fail(503, "down"));
    // OpenRouter answers after 80 ms: beyond the 50 ms primary limit, inside the 200 ms fallback limit.
    fetchMock.mockImplementationOnce(
      (_u: string, init: RequestInit) =>
        new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve(ok("slow but fine")), 80);
          init.signal!.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        })
    );
    const out = await llm.chat({ ...req, timeoutMs: 50, fallbackTimeoutMs: 200 });
    expect(out).toMatchObject({ provider: "openrouter", text: "slow but fine" });
  });
});
