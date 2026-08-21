/**
 * Classify step outcomes in priority order — outcomes, recoveries, postcondition.
 * Each path is explicit; nothing is funneled through a generic try/catch.
 */
import type {
  CapabilityArtifact,
  FailureKind,
  OutcomeRule,
  RecoveryRule,
  Step,
} from "../core/schema.js";
import {
  describeAssertion,
  evaluateAssertion,
  isAppErrorPage,
  summarizeObservation,
  type AssertionEnv,
} from "./assertions.js";

export type ObservationSnapshot = {
  url: string;
  pageText: string;
};

export type StepClassification =
  | { kind: "continue" }
  | { kind: "business_outcome"; rule: OutcomeRule }
  | { kind: "recovery"; rule: RecoveryRule }
  | {
      kind: "failed";
      failureKind: FailureKind;
      expected: string;
      observed: string;
    };

export async function classifyAfterStep(
  artifact: CapabilityArtifact,
  step: Step,
  env: AssertionEnv,
  snapshot: ObservationSnapshot,
): Promise<StepClassification> {
  const outcome = await matchOutcome(artifact.outcomes, env);
  if (outcome !== null) {
    return { kind: "business_outcome", rule: outcome };
  }

  const recovery = await matchRecovery(artifact.recoveries, env);
  if (recovery !== null) {
    return { kind: "recovery", rule: recovery };
  }

  if (step.postcondition !== undefined) {
    const met = await evaluateAssertion(step.postcondition, env);
    if (!met) {
      return buildPostconditionFailure(step, snapshot);
    }
  }

  return { kind: "continue" };
}

async function matchOutcome(
  rules: readonly OutcomeRule[],
  env: AssertionEnv,
): Promise<OutcomeRule | null> {
  for (const rule of rules) {
    if (await evaluateAssertion(rule.detect, env)) return rule;
  }
  return null;
}

async function matchRecovery(
  rules: readonly RecoveryRule[],
  env: AssertionEnv,
): Promise<RecoveryRule | null> {
  for (const rule of rules) {
    if (await evaluateAssertion(rule.detect, env)) return rule;
  }
  return null;
}

function buildPostconditionFailure(
  step: Step,
  snapshot: ObservationSnapshot,
): Extract<StepClassification, { kind: "failed" }> {
  const expected = describeAssertion(step.postcondition!);
  const observed = summarizeObservation(snapshot.url, snapshot.pageText);
  const failureKind: FailureKind = isAppErrorPage(snapshot.pageText)
    ? "app_error"
    : "checkpoint_failed";
  return { kind: "failed", failureKind, expected, observed };
}

export async function classifySuccessCheckpoint(
  checkpoint: CapabilityArtifact["successCheckpoint"],
  env: AssertionEnv,
  snapshot: ObservationSnapshot,
): Promise<Extract<StepClassification, { kind: "failed" }> | null> {
  const met = await evaluateAssertion(checkpoint, env);
  if (met) return null;
  return {
    kind: "failed",
    failureKind: isAppErrorPage(snapshot.pageText) ? "app_error" : "checkpoint_failed",
    expected: describeAssertion(checkpoint),
    observed: summarizeObservation(snapshot.url, snapshot.pageText),
  };
}

export async function classifyPrecondition(
  precondition: NonNullable<Step["precondition"]>,
  env: AssertionEnv,
  snapshot: ObservationSnapshot,
): Promise<Extract<StepClassification, { kind: "failed" }> | null> {
  const met = await evaluateAssertion(precondition, env);
  if (met) return null;
  return {
    kind: "failed",
    failureKind: "checkpoint_failed",
    expected: describeAssertion(precondition),
    observed: summarizeObservation(snapshot.url, snapshot.pageText),
  };
}
