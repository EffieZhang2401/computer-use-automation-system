/**
 * Unified LLM client — the only entry point for model calls in discovery.
 *
 * Modes:
 * - replay: read cassette only, throw on miss (zero network, zero cost)
 * - live: call provider, write cassette
 * - auto: try cassette first, fall back to live on miss
 */
import { PROMPT_VERSION } from "../agent/tools.js";
import { annotateRecordingJson } from "./annotate.js";
import { callAnthropic } from "./anthropic.js";
import { TokenBudget } from "./budget.js";
import { CassetteStore } from "./cassette.js";
import { callGemini } from "./gemini.js";
import type { LLMMode, LLMProvider, LLMRequest, LLMResponse } from "./types.js";

export type LLMClientOptions = {
  mode?: LLMMode;
  provider?: LLMProvider;
  model?: string;
  budget?: TokenBudget;
  cassettes?: CassetteStore;
};

export interface LLMClient {
  readonly mode: LLMMode;
  readonly model: string;
  readonly provider: LLMProvider;
  readonly budget: TokenBudget;
  act(request: Omit<LLMRequest, "model" | "promptVersion">): Promise<LLMResponse>;
  annotate(recordingSummary: string): Promise<{ json: unknown; usage: import("./types.js").TokenUsage }>;
}

export function resolveLLMMode(): LLMMode {
  const raw = process.env.LLM_MODE ?? "auto";
  if (raw === "auto" || raw === "replay" || raw === "live") return raw;
  throw new Error(`Invalid LLM_MODE: ${raw}`);
}

export function resolveLLMProvider(): LLMProvider {
  const raw = process.env.LLM_PROVIDER ?? "gemini";
  if (raw === "anthropic" || raw === "gemini") return raw;
  throw new Error(`Invalid LLM_PROVIDER: ${raw}`);
}

export function resolveModel(provider: LLMProvider): string {
  if (process.env.MODEL !== undefined && process.env.MODEL !== "") {
    return process.env.MODEL;
  }
  return provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gemini-3.5-flash-lite";
}

export function createLLMClient(opts: LLMClientOptions = {}): LLMClient {
  const provider = opts.provider ?? resolveLLMProvider();
  const mode = opts.mode ?? resolveLLMMode();
  const model = opts.model ?? resolveModel(provider);
  const budget = opts.budget ?? TokenBudget.fromEnv();
  const cassettes = opts.cassettes ?? new CassetteStore();

  async function callLive(request: LLMRequest): Promise<LLMResponse> {
    if (provider === "anthropic") return callAnthropic(request);
    return callGemini(request);
  }

  return {
    mode,
    model,
    provider,
    budget,

    async act(partial): Promise<LLMResponse> {
      const request: LLMRequest = {
        ...partial,
        model,
        promptVersion: PROMPT_VERSION,
      };

      let response: LLMResponse | null = null;

      if (mode === "replay") {
        response = await cassettes.readOrThrow(request);
      } else if (mode === "auto") {
        response = await cassettes.read(request);
        if (response === null) {
          response = await callLive(request);
          await cassettes.write(request, response);
        }
      } else {
        response = await callLive(request);
        await cassettes.write(request, response);
      }

      budget.charge(response.usage);
      return response;
    },

    async annotate(recordingSummary: string) {
      if (mode === "replay") {
        const request: LLMRequest = {
          goal: "annotate recording",
          observation: { url: "compile", text: recordingSummary, hash: "compile-annotation" },
          history: [],
          model,
          promptVersion: "compile-v1",
        };
        const cached = await cassettes.readOrThrow(request);
        return { json: JSON.parse(cached.rawText ?? "{}") as unknown, usage: cached.usage };
      }

      const { json, usage } = await annotateRecordingJson(provider, model, recordingSummary);
      if (mode === "live" || mode === "auto") {
        const request: LLMRequest = {
          goal: "annotate recording",
          observation: { url: "compile", text: recordingSummary, hash: "compile-annotation" },
          history: [],
          model,
          promptVersion: "compile-v1",
        };
        await cassettes.write(request, {
          toolCall: { tool: "done", summary: "annotation", checkpointDescription: "", outputs: {} },
          usage,
          rawText: JSON.stringify(json),
        });
      }
      budget.charge(usage);
      return { json, usage };
    },
  };
}

export { CassetteMissError } from "./cassette.js";
export { TokenBudgetExceededError } from "./budget.js";
