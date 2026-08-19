/**
 * Stuck detection — real stopping conditions, not TODOs.
 */
import type { AgentToolCall } from "./tools.js";
import type { InterventionRequest, StuckReason } from "./types.js";

export type StuckState = {
  observationHashes: string[];
  actionPairs: Array<{ action: string; ref?: number }>;
  consecutivePolicyRejections: number;
};

export function createStuckState(): StuckState {
  return {
    observationHashes: [],
    actionPairs: [],
    consecutivePolicyRejections: 0,
  };
}

export function recordObservationHash(state: StuckState, hash: string): void {
  state.observationHashes.push(hash);
  if (state.observationHashes.length > 10) {
    state.observationHashes.shift();
  }
}

export function recordAction(state: StuckState, call: AgentToolCall): void {
  const pair = actionPairKey(call);
  state.actionPairs.push(pair);
  if (state.actionPairs.length > 10) {
    state.actionPairs.shift();
  }
}

export function recordPolicyRejection(state: StuckState, rejected: boolean): void {
  if (rejected) {
    state.consecutivePolicyRejections += 1;
  } else {
    state.consecutivePolicyRejections = 0;
  }
}

/** No progress: 3 consecutive identical observation hashes. */
export function detectNoProgress(state: StuckState): boolean {
  const hashes = state.observationHashes;
  if (hashes.length < 3) return false;
  const last = hashes.slice(-3);
  return last[0] === last[1] && last[1] === last[2];
}

/** Action loop: same (action, ref) pair repeats ≥2 times in a row. */
export function detectActionLoop(state: StuckState): boolean {
  const pairs = state.actionPairs;
  if (pairs.length < 2) return false;
  const prev = pairs[pairs.length - 2];
  const curr = pairs[pairs.length - 1];
  if (prev === undefined || curr === undefined) return false;
  return pairEquals(prev, curr);
}

export function detectPolicyStuck(state: StuckState, threshold = 2): boolean {
  return state.consecutivePolicyRejections >= threshold;
}

export function checkStuck(
  state: StuckState,
  ctx: { runId: string; stepIndex: number; url?: string; observationHash?: string },
): InterventionRequest | null {
  if (detectNoProgress(state)) {
    return intervention(ctx, "no_progress", "Observation unchanged for 3 consecutive steps");
  }
  if (detectActionLoop(state)) {
    return intervention(
      ctx,
      "action_loop",
      "The same action and ref were repeated without progress",
    );
  }
  if (detectPolicyStuck(state)) {
    return intervention(
      ctx,
      "policy_rejection",
      "PolicyGate rejected consecutive actions",
    );
  }
  return null;
}

function intervention(
  ctx: { runId: string; stepIndex: number; url?: string; observationHash?: string },
  reason: StuckReason,
  message: string,
): InterventionRequest {
  return {
    runId: ctx.runId,
    reason,
    message,
    stepIndex: ctx.stepIndex,
    url: ctx.url,
    observationHash: ctx.observationHash,
    whatHumanShouldDo: defaultHumanGuidance(reason),
  };
}

function defaultHumanGuidance(reason: StuckReason): string {
  switch (reason) {
    case "no_progress":
      return "Review the current page state and either take control to unblock the UI or adjust the goal.";
    case "action_loop":
      return "Inspect why the repeated action is not changing the page, then resume or abort.";
    case "policy_rejection":
      return "Review policy settings or complete the blocked action manually, then hand back.";
    case "token_budget":
      return "Discovery exceeded the token budget — review partial recordings and continue manually if needed.";
    default:
      return "Review the run evidence and decide whether to resume or abort.";
  }
}

function actionPairKey(call: AgentToolCall): { action: string; ref?: number } {
  switch (call.tool) {
    case "click":
    case "fill":
    case "select":
    case "extract":
      return { action: call.tool, ref: call.ref };
    case "wait_for":
      return { action: call.tool, ref: call.ref };
    case "navigate":
      return { action: call.tool };
    case "press":
      return { action: call.tool };
    default:
      return { action: call.tool };
  }
}

function pairEquals(
  a: { action: string; ref?: number },
  b: { action: string; ref?: number },
): boolean {
  return a.action === b.action && a.ref === b.ref;
}

export function interventionForReason(
  ctx: { runId: string; stepIndex: number; url?: string; observationHash?: string },
  reason: StuckReason,
  message: string,
  whatHumanShouldDo?: string,
): InterventionRequest {
  return {
    runId: ctx.runId,
    reason,
    message,
    stepIndex: ctx.stepIndex,
    url: ctx.url,
    observationHash: ctx.observationHash,
    whatHumanShouldDo: whatHumanShouldDo ?? defaultHumanGuidance(reason),
  };
}
