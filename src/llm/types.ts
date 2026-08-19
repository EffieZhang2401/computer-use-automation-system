import type { AgentToolCall } from "../agent/tools.js";

/** One turn in the discovery conversation fed back to the model. */
export type LLMHistoryEntry = {
  step: number;
  toolCall: AgentToolCall;
  result: string;
  observationHashAfter?: string;
};

/** Payload hashed for cassette lookup — volatile fields stripped by cassette.ts. */
export type LLMRequest = {
  goal: string;
  observation: {
    url: string;
    text: string;
    hash: string;
  };
  history: LLMHistoryEntry[];
  /** Included in the cache key so model swaps invalidate correctly. */
  model: string;
  promptVersion: string;
  /** Stripped before hashing — present only for logging/evidence. */
  runId?: string;
  timestamp?: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type LLMResponse = {
  toolCall: AgentToolCall;
  usage: TokenUsage;
  /** Raw assistant text when useful for debugging cassettes. */
  rawText?: string;
};

export type LLMMode = "auto" | "replay" | "live";

export type LLMProvider = "anthropic" | "gemini";
