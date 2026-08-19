/**
 * Per-run token budget guard. Discovery aborts when cumulative usage
 * exceeds MAX_RUN_TOKENS — this is a real stopping condition, not a soft warning.
 */
import type { TokenUsage } from "./types.js";

export class TokenBudgetExceededError extends Error {
  readonly kind = "token_budget_exceeded" as const;

  constructor(
    readonly used: number,
    readonly limit: number,
  ) {
    super(`Token budget exceeded: used ${used}, limit ${limit}`);
    this.name = "TokenBudgetExceededError";
  }
}

export class TokenBudget {
  private used = 0;

  constructor(readonly limit: number) {}

  static fromEnv(): TokenBudget {
    const raw = process.env.MAX_RUN_TOKENS ?? "50000";
    const limit = Number.parseInt(raw, 10);
    if (Number.isNaN(limit) || limit <= 0) {
      throw new Error(`Invalid MAX_RUN_TOKENS: ${raw}`);
    }
    return new TokenBudget(limit);
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.used);
  }

  get totalUsed(): number {
    return this.used;
  }

  /** Record usage from one LLM call; throws when the budget is exhausted. */
  charge(usage: TokenUsage): void {
    const delta = usage.inputTokens + usage.outputTokens;
    this.used += delta;
    if (this.used > this.limit) {
      throw new TokenBudgetExceededError(this.used, this.limit);
    }
  }

  /** True when the next call of `estimatedTokens` would exceed the budget. */
  wouldExceed(estimatedTokens: number): boolean {
    return this.used + estimatedTokens > this.limit;
  }
}
