/**
 * Deterministic replay executor — no LLM imports, no model in the loop.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CapabilityArtifactSchema,
  ReplayResultSchema,
  type CapabilityArtifact,
  type RecoveryAction,
  type ReplayFailure,
  type ReplayResult,
  type Step,
  type StepResult,
  type StepValue,
} from "../core/schema.js";
import { redactForLog, type SensitivitySpec } from "../core/redactor.js";
import { PolicyGate } from "../policy/gate.js";
import type { AssertionEnv } from "../surface/assertions.js";
import { WebSurface } from "../surface/web-surface.js";
import {
  classifyAfterStep,
  classifyPrecondition,
  classifySuccessCheckpoint,
  type ObservationSnapshot,
} from "./state-classifier.js";

export type ReplayOptions = {
  artifact: CapabilityArtifact;
  params: Record<string, string>;
  runId?: string;
  headless?: boolean;
  authCookies?: Array<{ name: string; value: string; url: string }>;
  /** Demo-app fault inject consumed on the next applicable request (e.g. search POST). */
  injectMode?: string;
};

export type ReplaySurface = WebSurface;

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runReplay(
  opts: ReplayOptions,
  surface?: ReplaySurface,
): Promise<ReplayResult> {
  const artifact = CapabilityArtifactSchema.parse(opts.artifact);
  const runId = opts.runId ?? randomUUID();
  const startedAt = Date.now();
  const evidenceDir = path.resolve("evidence", runId);
  await mkdir(evidenceDir, { recursive: true });

  const ownsSurface = surface === undefined;
  const replaySurface =
    surface ??
    (await WebSurface.launch({
      headless: opts.headless ?? true,
      cookies: opts.authCookies,
    }));

  const gate = new PolicyGate(artifact.policy, {
    mode: "replay",
    artifactStatus: artifact.status,
  });

  const stepResults: StepResult[] = [];
  const driftSignals: Array<{ stepId: string; primaryFailed: boolean; hitTier: number }> = [];
  const outputs: Record<string, unknown> = {};
  const sensitivitySpecs: SensitivitySpec[] = [
    ...artifact.inputs.map((input) => ({ name: input.name, sensitivity: input.sensitivity })),
    ...artifact.outputs.map((output) => ({ name: output.name, sensitivity: output.sensitivity })),
  ];

  let terminalResult: ReplayResult | null = null;

  try {
    await logReplayEvent(evidenceDir, {
      type: "replay_started",
      runId,
      artifactId: artifact.id,
      artifactVersion: artifact.version,
      params: redactForLog(opts.params, sensitivitySpecs),
      timestamp: new Date().toISOString(),
    });

    const entryUrl = substituteTemplate(artifact.target.entryPoint, opts.params);
    await replaySurface.act({ kind: "navigate", url: entryUrl });
    await replaySurface.observe();

    for (let stepIndex = 0; stepIndex < artifact.steps.length; stepIndex++) {
      const step = artifact.steps[stepIndex]!;
      const stepStarted = Date.now();
      let retries = 0;
      let resolvedTier: number | undefined;
      let completed = false;

      while (!completed) {
        if (opts.injectMode !== undefined && step.id === "s02" && retries === 0) {
          await applyDemoInject(opts.params.baseUrl ?? "", opts.injectMode);
        }

        const snapshot = await observeSnapshot(replaySurface);
        const env = buildAssertionEnv(replaySurface, snapshot);

        if (step.precondition !== undefined) {
          const preconditionFailure = await classifyPrecondition(
            step.precondition,
            env,
            snapshot,
          );
          if (preconditionFailure !== null) {
            terminalResult = await finishFailed(
              replaySurface,
              evidenceDir,
              artifact,
              runId,
              startedAt,
              step,
              preconditionFailure.failureKind,
              preconditionFailure.expected,
              preconditionFailure.observed,
              resolvedTier,
              stepResults,
              driftSignals,
            );
            completed = true;
            break;
          }
        }

        const policyDecision = gate.check(step, {
          currentUrl: snapshot.url,
          stepIndex,
          intent: step.intent,
        });
        if (!policyDecision.allowed) {
          terminalResult = await finishFailed(
            replaySurface,
            evidenceDir,
            artifact,
            runId,
            startedAt,
            step,
            "policy_violation",
            "policy allows this action",
            policyDecision.reason ?? "policy rejected",
            resolvedTier,
            stepResults,
            driftSignals,
          );
          completed = true;
          break;
        }

        const actionOutcome = await executeStepAction(replaySurface, step, opts.params);
        if (actionOutcome.kind === "locator_unresolved") {
          terminalResult = await finishFailed(
            replaySurface,
            evidenceDir,
            artifact,
            runId,
            startedAt,
            step,
            "locator_unresolved",
            `resolved locator for ${step.action}`,
            actionOutcome.detail,
            undefined,
            stepResults,
            driftSignals,
          );
          completed = true;
          break;
        }
        if (actionOutcome.kind === "action_error") {
          terminalResult = await finishFailed(
            replaySurface,
            evidenceDir,
            artifact,
            runId,
            startedAt,
            step,
            "app_error",
            `${step.action} succeeds`,
            actionOutcome.detail,
            actionOutcome.tier,
            stepResults,
            driftSignals,
          );
          completed = true;
          break;
        }

        resolvedTier = actionOutcome.tier;
        if (actionOutcome.extracted !== undefined && step.extractAs !== undefined) {
          outputs[step.extractAs] = actionOutcome.extracted;
        }

        if (step.wait?.until === "assertion" && step.postcondition !== undefined) {
          const waited = await replaySurface.waitForAssertion(
            step.postcondition,
            step.wait.timeoutMs,
          );
          if (!waited) {
            const afterWait = await observeSnapshot(replaySurface);
            const waitEnv = buildAssertionEnv(replaySurface, afterWait);
            const classification = await classifyAfterStep(
              artifact,
              step,
              waitEnv,
              afterWait,
            );
            if (classification.kind === "business_outcome") {
              terminalResult = await finishBusinessOutcome(
                evidenceDir,
                artifact,
                runId,
                startedAt,
                classification.rule,
                recordStep(stepResults, driftSignals, step, stepStarted, resolvedTier, retries),
              );
              completed = true;
              break;
            }
            if (classification.kind === "recovery") {
              const recovered = await applyRecovery(
                replaySurface,
                classification.rule,
                retries,
              );
              if (recovered) {
                retries += 1;
                continue;
              }
            }
            if (classification.kind === "failed") {
              terminalResult = await finishFailed(
                replaySurface,
                evidenceDir,
                artifact,
                runId,
                startedAt,
                step,
                classification.failureKind,
                classification.expected,
                classification.observed,
                resolvedTier,
                stepResults,
                driftSignals,
                retries,
              );
              completed = true;
              break;
            }
          }
        }

        const afterAction = await observeSnapshot(replaySurface);
        const afterEnv = buildAssertionEnv(replaySurface, afterAction);
        const classification = await classifyAfterStep(artifact, step, afterEnv, afterAction);

        if (classification.kind === "business_outcome") {
          terminalResult = await finishBusinessOutcome(
            evidenceDir,
            artifact,
            runId,
            startedAt,
            classification.rule,
            recordStep(stepResults, driftSignals, step, stepStarted, resolvedTier, retries),
          );
          completed = true;
          break;
        }

        if (classification.kind === "recovery") {
          const recovered = await applyRecovery(replaySurface, classification.rule, retries);
          if (recovered) {
            retries += 1;
            continue;
          }
          terminalResult = await finishFailed(
            replaySurface,
            evidenceDir,
            artifact,
            runId,
            startedAt,
            step,
            "checkpoint_failed",
            `recovery "${classification.rule.id}" succeeds`,
            `recovery exhausted after ${classification.rule.maxAttempts} attempts`,
            resolvedTier,
            stepResults,
            driftSignals,
            retries,
          );
          completed = true;
          break;
        }

        if (classification.kind === "failed") {
          terminalResult = await finishFailed(
            replaySurface,
            evidenceDir,
            artifact,
            runId,
            startedAt,
            step,
            classification.failureKind,
            classification.expected,
            classification.observed,
            resolvedTier,
            stepResults,
            driftSignals,
            retries,
          );
          completed = true;
          break;
        }

        recordStep(stepResults, driftSignals, step, stepStarted, resolvedTier, retries);
        completed = true;
      }

      if (terminalResult !== null) break;
    }

    if (terminalResult === null) {
      const snapshot = await observeSnapshot(replaySurface);
      const env = buildAssertionEnv(replaySurface, snapshot);
      const checkpointFailure = await classifySuccessCheckpoint(
        artifact.successCheckpoint,
        env,
        snapshot,
      );
      if (checkpointFailure !== null) {
        const lastStep = artifact.steps[artifact.steps.length - 1];
        terminalResult = await finishFailed(
          replaySurface,
          evidenceDir,
          artifact,
          runId,
          startedAt,
          lastStep ?? {
            id: "checkpoint",
            intent: "Verify success checkpoint",
            action: "assert",
            risk: "safe",
          },
          checkpointFailure.failureKind,
          checkpointFailure.expected,
          checkpointFailure.observed,
          undefined,
          stepResults,
          driftSignals,
        );
      } else {
        const collected = collectDeclaredOutputs(artifact, outputs);
        terminalResult = {
          status: "success",
          runId,
          artifactId: artifact.id,
          artifactVersion: artifact.version,
          durationMs: Date.now() - startedAt,
          evidenceDir,
          outputs: collected,
          steps: stepResults,
          driftSignals,
        };
      }
    }

    const parsed = ReplayResultSchema.parse(terminalResult);
    await writeFile(
      path.join(evidenceDir, "result.json"),
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    await logReplayEvent(evidenceDir, {
      type: "replay_finished",
      status: parsed.status,
      timestamp: new Date().toISOString(),
    });
    return parsed;
  } finally {
    if (ownsSurface) {
      await replaySurface.close();
    }
  }
}

type ActionExecution =
  | { kind: "ok"; tier?: number; extracted?: string }
  | { kind: "locator_unresolved"; detail: string }
  | { kind: "action_error"; detail: string; tier?: number };

async function executeStepAction(
  surface: ReplaySurface,
  step: Step,
  params: Record<string, string>,
): Promise<ActionExecution> {
  switch (step.action) {
    case "navigate": {
      const url = resolveStepValue(step.value, params);
      if (typeof url !== "string") {
        return { kind: "action_error", detail: "navigate requires a string URL" };
      }
      const result = await surface.act({ kind: "navigate", url });
      return result.ok
        ? { kind: "ok" }
        : { kind: "action_error", detail: result.error ?? "navigate failed" };
    }
    case "click": {
      if (step.target === undefined) {
        return { kind: "locator_unresolved", detail: "click step missing target locator" };
      }
      const clicked = await surface.clickSchemaLocator(step.target);
      if ("error" in clicked) {
        return clicked.error.includes("unresolved")
          ? { kind: "locator_unresolved", detail: clicked.error }
          : { kind: "action_error", detail: clicked.error };
      }
      return { kind: "ok", tier: clicked.tier };
    }
    case "fill": {
      if (step.target === undefined) {
        return { kind: "locator_unresolved", detail: "fill step missing target locator" };
      }
      const value = resolveStepValue(step.value, params);
      if (typeof value !== "string") {
        return { kind: "action_error", detail: "fill requires a string value" };
      }
      const filled = await surface.fillSchemaLocator(step.target, value);
      if ("error" in filled) {
        return filled.error.includes("unresolved")
          ? { kind: "locator_unresolved", detail: filled.error }
          : { kind: "action_error", detail: filled.error };
      }
      return { kind: "ok", tier: filled.tier };
    }
    case "extract": {
      if (step.target === undefined) {
        return { kind: "locator_unresolved", detail: "extract step missing target locator" };
      }
      const extracted = await surface.extractSchemaLocatorText(step.target);
      if ("error" in extracted) {
        return extracted.error.includes("unresolved")
          ? { kind: "locator_unresolved", detail: extracted.error }
          : { kind: "action_error", detail: extracted.error };
      }
      return { kind: "ok", tier: extracted.tier, extracted: extracted.text };
    }
    case "waitFor": {
      if (step.postcondition === undefined) {
        return { kind: "action_error", detail: "waitFor requires a postcondition assertion" };
      }
      const timeoutMs = step.wait?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const waited = await surface.waitForAssertion(step.postcondition, timeoutMs);
      return waited
        ? { kind: "ok" }
        : { kind: "action_error", detail: `assertion not met within ${timeoutMs}ms` };
    }
    case "assert": {
      if (step.postcondition === undefined) {
        return { kind: "action_error", detail: "assert step missing postcondition" };
      }
      const met = await surface.checkAssertion(step.postcondition);
      return met ? { kind: "ok" } : { kind: "action_error", detail: "assertion failed" };
    }
    case "select":
    case "press":
      return { kind: "action_error", detail: `${step.action} not implemented for replay` };
    default: {
      const _exhaustive: never = step.action;
      return { kind: "action_error", detail: `unknown action: ${String(_exhaustive)}` };
    }
  }
}

async function applyRecovery(
  surface: ReplaySurface,
  rule: { id: string; action: RecoveryAction; maxAttempts: number },
  attemptsSoFar: number,
): Promise<boolean> {
  if (attemptsSoFar >= rule.maxAttempts) return false;

  switch (rule.action.kind) {
    case "click": {
      const clicked = await surface.clickSchemaLocator(rule.action.target);
      return !("error" in clicked);
    }
    case "wait": {
      const before = (await surface.observe()).hash;
      const deadline = Date.now() + rule.action.timeoutMs;
      while (Date.now() < deadline) {
        const after = await surface.observe();
        if (after.hash !== before) return true;
        await surface.getPage().waitForLoadState("domcontentloaded").catch(() => undefined);
      }
      return false;
    }
    case "reload":
      await surface.reload();
      return true;
    case "reauth":
      await surface.act({ kind: "navigate", url: new URL("/login", surface.getCurrentUrl()).href });
      return true;
    default: {
      const _exhaustive: never = rule.action;
      return _exhaustive;
    }
  }
}

function resolveStepValue(
  value: StepValue | undefined,
  params: Record<string, string>,
): string | number | boolean | undefined {
  if (value === undefined) return undefined;
  if (value.kind === "literal") return value.value;
  return params[value.name];
}

function substituteTemplate(template: string, params: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => params[name] ?? "");
}

async function observeSnapshot(surface: ReplaySurface): Promise<ObservationSnapshot> {
  const observation = await surface.observe();
  const pageText = await surface.getFullPageText();
  return { url: observation.url, pageText };
}

function buildAssertionEnv(
  surface: ReplaySurface,
  snapshot: ObservationSnapshot,
): AssertionEnv {
  return {
    url: snapshot.url,
    pageText: snapshot.pageText,
    isLocatorVisible: (locator) => surface.isSchemaLocatorVisible(locator),
    readLocatorText: async (locator) => {
      const extracted = await surface.extractSchemaLocatorText(locator);
      return "text" in extracted ? extracted.text : null;
    },
  };
}

function recordStep(
  stepResults: StepResult[],
  driftSignals: Array<{ stepId: string; primaryFailed: boolean; hitTier: number }>,
  step: Step,
  startedAt: number,
  resolvedTier: number | undefined,
  retries: number,
): StepResult[] {
  const result: StepResult = {
    stepId: step.id,
    durationMs: Date.now() - startedAt,
    resolvedTier,
    retries,
  };
  stepResults.push(result);
  if (resolvedTier !== undefined && resolvedTier > 0) {
    driftSignals.push({ stepId: step.id, primaryFailed: true, hitTier: resolvedTier });
  }
  return stepResults;
}

function collectDeclaredOutputs(
  artifact: CapabilityArtifact,
  runtimeOutputs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of artifact.outputs) {
    if (runtimeOutputs[spec.name] !== undefined) {
      out[spec.name] = runtimeOutputs[spec.name];
    }
  }
  return out;
}

async function captureFailureEvidence(
  surface: ReplaySurface,
  evidenceDir: string,
): Promise<ReplayFailure["evidence"]> {
  const observation = await surface.observe();
  const screenshotPath = path.join(evidenceDir, "failure-screenshot.png");
  await writeFile(screenshotPath, await surface.screenshot());
  const a11yPath = path.join(evidenceDir, "failure-a11y.txt");
  await writeFile(a11yPath, observation.text, "utf8");
  return {
    screenshot: path.relative(process.cwd(), screenshotPath),
    a11ySnapshot: path.relative(process.cwd(), a11yPath),
    url: observation.url,
  };
}

async function finishFailed(
  surface: ReplaySurface,
  evidenceDir: string,
  artifact: CapabilityArtifact,
  runId: string,
  startedAt: number,
  step: Step,
  kind: ReplayFailure["kind"],
  expected: string,
  observed: string,
  resolvedTier: number | undefined,
  stepResults: StepResult[],
  driftSignals: ReplayResult["driftSignals"],
  retries = 0,
): Promise<ReplayResult> {
  if (stepResults[stepResults.length - 1]?.stepId !== step.id) {
    stepResults.push({
      stepId: step.id,
      durationMs: 0,
      resolvedTier,
      retries,
    });
  }
  const failure: ReplayFailure = {
    stepId: step.id,
    stepIntent: step.intent,
    kind,
    expected,
    observed,
    resolvedTier,
    evidence: await captureFailureEvidence(surface, evidenceDir),
  };
  return {
    status: "failed",
    runId,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    durationMs: Date.now() - startedAt,
    evidenceDir,
    failure,
    steps: stepResults,
    driftSignals,
  };
}

async function finishBusinessOutcome(
  evidenceDir: string,
  artifact: CapabilityArtifact,
  runId: string,
  startedAt: number,
  rule: { code: string; message: string },
  stepResults: StepResult[],
): Promise<ReplayResult> {
  return {
    status: "business_outcome",
    runId,
    artifactId: artifact.id,
    artifactVersion: artifact.version,
    durationMs: Date.now() - startedAt,
    evidenceDir,
    outcome: { code: rule.code, message: rule.message },
    steps: stepResults,
    driftSignals: [],
  };
}

async function logReplayEvent(
  evidenceDir: string,
  event: Record<string, unknown>,
): Promise<void> {
  await appendFile(path.join(evidenceDir, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

export async function loadArtifactFromFile(filePath: string): Promise<CapabilityArtifact> {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  return CapabilityArtifactSchema.parse(raw);
}

async function applyDemoInject(baseUrl: string, mode: string): Promise<void> {
  if (baseUrl === "") return;
  const origin = baseUrl.includes("localhost")
    ? baseUrl.replace("//localhost", "//127.0.0.1")
    : baseUrl;
  const url = `${origin.replace(/\/$/, "")}/__test/inject?mode=${encodeURIComponent(mode)}&once=true&format=json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to set inject mode ${mode}: HTTP ${res.status}`);
  }
}
