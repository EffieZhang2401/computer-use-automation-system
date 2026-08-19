import { describe, expect, it } from "vitest";
import {
  CassetteStore,
  hashRequest,
  normalizeForCacheKey,
  VOLATILE_CACHE_KEYS,
} from "../src/llm/cassette";
import type { LLMRequest } from "../src/llm/types";

function baseRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    goal: "look up member 12345",
    observation: {
      url: "http://localhost:3100/members/search",
      text: "url: http://localhost:3100/members/search\n\n[ref=12] textbox \"Member ID\"",
      hash: "abc123deadbeef",
    },
    history: [],
    model: "gemini-2.5-flash-lite",
    promptVersion: "discovery-v1",
    ...overrides,
  };
}

describe("normalizeForCacheKey", () => {
  it("strips runId and timestamp from the request", () => {
    const a = baseRequest({ runId: "run-aaa", timestamp: "2026-01-01T00:00:00.000Z" });
    const b = baseRequest({ runId: "run-bbb", timestamp: "2026-08-19T12:00:00.000Z" });

    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it("strips volatile keys recursively in history entries", () => {
    const a = baseRequest({
      history: [
        {
          step: 0,
          toolCall: { tool: "fill", ref: 12, text: "12345" },
          result: "filled",
          observationHashAfter: "hash1",
        },
      ],
      runId: "run-1",
    });
    const b = baseRequest({
      history: [
        {
          step: 0,
          toolCall: { tool: "fill", ref: 12, text: "12345" },
          result: "filled",
          observationHashAfter: "hash1",
        },
      ],
      runId: "run-2",
    });

    expect(hashRequest(a)).toBe(hashRequest(b));
  });

  it("changes hash when observation content differs", () => {
    const a = baseRequest();
    const b = baseRequest({
      observation: {
        ...a.observation,
        hash: "different-hash",
        text: a.observation.text + "\n[ref=99] button \"Search\"",
      },
    });

    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it("documents every stripped volatile key", () => {
    const payload: Record<string, unknown> = {};
    for (const key of VOLATILE_CACHE_KEYS) {
      payload[key] = "volatile-value";
    }
    payload.goal = "stable";
    const normalized = normalizeForCacheKey(payload) as Record<string, unknown>;
    for (const key of VOLATILE_CACHE_KEYS) {
      expect(normalized[key]).toBeUndefined();
    }
    expect(normalized.goal).toBe("stable");
  });
});

describe("CassetteStore replay mode", () => {
  it("reads a written cassette without network", async () => {
    const dir = `.cassettes/test-${Date.now()}`;
    const store = new CassetteStore(dir);
    const request = baseRequest({ runId: "ephemeral-run" });
    const response = {
      toolCall: { tool: "click" as const, ref: 12 },
      usage: { inputTokens: 100, outputTokens: 20 },
    };

    await store.write(request, response);

    const cached = await store.readOrThrow(
      baseRequest({ runId: "different-run", timestamp: new Date().toISOString() }),
    );
    expect(cached.toolCall).toEqual(response.toolCall);
    expect(cached.usage).toEqual(response.usage);
  });

  it("throws CassetteMissError on miss in replay mode", async () => {
    const store = new CassetteStore(`.cassettes/miss-${Date.now()}`);
    const request = baseRequest({ observation: { ...baseRequest().observation, hash: "never-written" } });

    await expect(store.readOrThrow(request)).rejects.toMatchObject({
      name: "CassetteMissError",
    });
  });
});

describe("LLM_MODE=replay has no API dependency", () => {
  it("works with no API keys when cassette exists", async () => {
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      const dir = `.cassettes/no-key-${Date.now()}`;
      const store = new CassetteStore(dir);
      const request = baseRequest();
      await store.write(request, {
        toolCall: { tool: "press", key: "Enter" },
        usage: { inputTokens: 50, outputTokens: 10 },
      });

      const hit = await store.readOrThrow(request);
      expect(hit.toolCall.tool).toBe("press");
    } finally {
      if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });
});
