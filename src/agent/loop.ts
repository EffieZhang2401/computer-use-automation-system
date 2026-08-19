/**
 * Discovery agent loop — observe → decide → act, with policy gate and recording.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CapabilityArtifact } from "../core/schema.js";
import { createLLMClient, TokenBudgetExceededError, type LLMClient } from "../llm/client.js";
import type { LLMHistoryEntry } from "../llm/types.js";
import { PolicyGate } from "../policy/gate.js";
import type { ActionCall, Observation, Surface } from "../surface/surface.js";
import { WebSurface } from "../surface/web-surface.js";
import { compileMechanical, compileWithAnnotation } from "./compiler.js";
import { captureLocatorForCall, Recorder } from "./recorder.js";
import {
  checkStuck,
  createStuckState,
  interventionForReason,
  recordAction,
  recordObservationHash,
  recordPolicyRejection,
} from "./stuck.js";
import {
  isTerminalTool,
  type AgentToolCall,
} from "./tools.js";
import type { DiscoveryOptions, DiscoveryResult, InterventionRequest } from "./types.js";

export type RunDiscoveryOptions = DiscoveryOptions & {
  llm?: LLMClient;
  surface?: Surface & { captureLocator(ref: number): Promise<import("../core/schema.js").Locator | null>; extractText(ref: number): Promise<string> };
  headless?: boolean;
  authCookies?: Array<{ name: string; value: string; url: string }>;
  annotate?: boolean;
};

const DEFAULT_POLICY = {
  allowedOrigins: ["http://127.0.0.1:3100", "http://localhost:3100"],
  allowedActions: ["navigate", "click", "fill", "select", "press", "extract", "waitFor", "assert"] as const,
  maxSteps: 50,
  highestRisk: "irreversible" as const,
};

export async function runDiscovery(opts: RunDiscoveryOptions): Promise<{
  result: DiscoveryResult;
  artifact: CapabilityArtifact;
  evidenceDir: string;
}> {
  const runId = opts.runId;
  const maxSteps = opts.maxSteps ?? 25;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const baseUrl = opts.baseUrl ?? new URL(opts.targetUrl).origin;
  const startedAt = Date.now();

  const llm = opts.llm ?? createLLMClient();
  const surface =
    opts.surface ??
    (await WebSurface.launch({
      headless: opts.headless ?? true,
      cookies: opts.authCookies,
    }));

  const ownsSurface = opts.surface === undefined;
  const evidenceDir = path.resolve("evidence", runId);
  await mkdir(evidenceDir, { recursive: true });

  const recorder = new Recorder();
  const stuckState = createStuckState();
  const history: LLMHistoryEntry[] = [];
  const outputs: Record<string, string> = {};
  let stepIndex = 0;
  let terminalTool: AgentToolCall | null = null;
  let intervention: InterventionRequest | null = null;

  const gate = new PolicyGate(
    { ...DEFAULT_POLICY, allowedActions: [...DEFAULT_POLICY.allowedActions] },
    { mode: "discovery" },
  );

  try {
    await logEvent(evidenceDir, {
      type: "run_started",
      runId,
      goal: opts.goal,
      targetUrl: opts.targetUrl,
      timestamp: new Date().toISOString(),
    });

    await surface.act({ kind: "navigate", url: opts.targetUrl });
    let observation = await surface.observe();

    while (stepIndex < maxSteps && Date.now() - startedAt < timeoutMs) {
      recordObservationHash(stuckState, observation.hash);

      const stuck = checkStuck(stuckState, {
        runId,
        stepIndex,
        url: observation.url,
        observationHash: observation.hash,
      });
      if (stuck !== null) {
        intervention = stuck;
        break;
      }

      let llmResponse;
      try {
        llmResponse = await llm.act({
          goal: opts.goal,
          observation: {
            url: observation.url,
            text: observation.text,
            hash: observation.hash,
          },
          history,
          runId,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof TokenBudgetExceededError) {
          intervention = interventionForReason(
            { runId, stepIndex, url: observation.url, observationHash: observation.hash },
            "token_budget",
            err.message,
          );
          break;
        }
        throw err;
      }

      const toolCall = llmResponse.toolCall;
      recordAction(stuckState, toolCall);

      await logEvent(evidenceDir, {
        type: "llm_decision",
        step: stepIndex,
        toolCall,
        usage: llmResponse.usage,
        timestamp: new Date().toISOString(),
      });

      if (isTerminalTool(toolCall)) {
        terminalTool = toolCall;
        if (toolCall.tool === "done") {
          Object.assign(outputs, toolCall.outputs);
        }
        if (toolCall.tool === "escalate") {
          intervention = interventionForReason(
            { runId, stepIndex, url: observation.url, observationHash: observation.hash },
            "model_escalate",
            toolCall.reason,
            toolCall.whatHumanShouldDo,
          );
        }
        break;
      }

      const obsHashBefore = observation.hash;
      const policyDecision = gate.check(toGatedCall(toolCall, observation), {
        currentUrl: observation.url,
        stepIndex,
        targetName: targetNameFromObservation(observation, toolCall),
      });

      if (!policyDecision.allowed) {
        recordPolicyRejection(stuckState, true);
        const result = `Policy rejected: ${policyDecision.reason ?? "not allowed"}`;
        history.push({ step: stepIndex, toolCall, result, observationHashAfter: observation.hash });
        await logEvent(evidenceDir, {
          type: "policy_rejection",
          step: stepIndex,
          reason: policyDecision.reason,
          timestamp: new Date().toISOString(),
        });

        const policyStuck = checkStuck(stuckState, {
          runId,
          stepIndex,
          url: observation.url,
          observationHash: observation.hash,
        });
        if (policyStuck !== null) {
          intervention = policyStuck;
          break;
        }

        stepIndex += 1;
        continue;
      }

      recordPolicyRejection(stuckState, false);

      const execResult = await executeToolCall(surface, toolCall, observation, outputs);
      const locator = await captureLocatorForCall(surface, toolCall);
      observation = await surface.observe();

      recorder.push({
        stepIndex,
        toolCall,
        locator,
        obsHashBefore,
        obsHashAfter: observation.hash,
        result: execResult,
      });

      history.push({
        step: stepIndex,
        toolCall,
        result: execResult,
        observationHashAfter: observation.hash,
      });

      await logEvent(evidenceDir, {
        type: "action_executed",
        step: stepIndex,
        toolCall,
        locator,
        result: execResult,
        obsHashAfter: observation.hash,
        timestamp: new Date().toISOString(),
      });

      stepIndex += 1;
    }

    if (intervention === null && terminalTool === null && stepIndex >= maxSteps) {
      intervention = interventionForReason(
        { runId, stepIndex, url: observation.url, observationHash: observation.hash },
        "max_steps",
        `Discovery reached maxSteps (${maxSteps})`,
      );
    }

    if (intervention === null && terminalTool === null && Date.now() - startedAt >= timeoutMs) {
      intervention = interventionForReason(
        { runId, stepIndex, url: observation.url, observationHash: observation.hash },
        "timeout",
        `Discovery timed out after ${timeoutMs}ms`,
      );
    }

    const compileCtx = {
      discoveryRunId: runId,
      model: llm.model,
      recordedBy: "discovery-agent",
      targetUrl: opts.targetUrl,
      baseUrl,
      artifactId: opts.artifactId,
    };

    const artifact =
      opts.annotate === true
        ? await compileWithAnnotation(recorder.all(), compileCtx, llm, opts.goal)
        : compileMechanical(recorder.all(), compileCtx);

    const artifactsDir = path.resolve("artifacts");
    await mkdir(artifactsDir, { recursive: true });
    const artifactPath = path.join(artifactsDir, `${artifact.id}.draft.json`);
    await writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");

    await logEvent(evidenceDir, {
      type: "run_finished",
      status: intervention !== null ? "intervention" : "completed",
      artifactPath,
      timestamp: new Date().toISOString(),
    });

    const result: DiscoveryResult =
      intervention !== null
        ? { status: "intervention", intervention, recordings: [...recorder.all()] }
        : {
            status: "completed",
            terminalTool: terminalTool ?? { tool: "done", summary: "finished", checkpointDescription: "", outputs },
            recordings: [...recorder.all()],
            outputs,
          };

    return { result, artifact, evidenceDir };
  } finally {
    if (ownsSurface && "close" in surface && typeof surface.close === "function") {
      await surface.close();
    }
  }
}

export function newRunId(): string {
  return randomUUID();
}

async function executeToolCall(
  surface: Surface & { extractText?(ref: number): Promise<string> },
  call: AgentToolCall,
  observation: Observation,
  outputs: Record<string, string>,
): Promise<string> {
  switch (call.tool) {
    case "navigate": {
      const result = await surface.act({ kind: "navigate", url: call.url });
      return result.ok ? "navigated" : (result.error ?? "navigate failed");
    }
    case "click": {
      const result = await surface.act({ kind: "click", ref: call.ref });
      return result.ok ? "clicked" : (result.error ?? "click failed");
    }
    case "fill": {
      const result = await surface.act({ kind: "fill", ref: call.ref, text: call.text });
      return result.ok ? "filled" : (result.error ?? "fill failed");
    }
    case "select": {
      const result = await surface.act({ kind: "select", ref: call.ref, value: call.option });
      return result.ok ? "selected" : (result.error ?? "select failed");
    }
    case "press": {
      const result = await surface.act({ kind: "press", key: call.key });
      return result.ok ? "pressed" : (result.error ?? "press failed");
    }
    case "extract": {
      if (surface.extractText === undefined) {
        return "extract not supported on this surface";
      }
      const text = await surface.extractText(call.ref);
      outputs[call.outputName] = text;
      return `extracted ${call.outputName}=${text}`;
    }
    case "wait_for": {
      if (call.ref !== undefined) {
        const found = observation.nodes.some((n) => n.ref === call.ref);
        return found ? "ref visible" : "ref not yet visible — retry";
      }
      if (call.text !== undefined) {
        const found = observation.text.includes(call.text);
        return found ? "text found" : "text not yet visible — retry";
      }
      return "wait_for missing target";
    }
    default:
      return "terminal tool should not execute";
  }
}

function toGatedCall(call: AgentToolCall, observation: Observation) {
  switch (call.tool) {
    case "navigate":
      return { kind: "navigate" as const, url: call.url };
    case "click":
      return { kind: "click" as const };
    case "fill":
      return { kind: "fill" as const };
    case "select":
      return { kind: "select" as const };
    case "press":
      return { kind: "press" as const };
    case "extract":
      return { kind: "extract" as const };
    case "wait_for":
      return { kind: "waitFor" as const };
    default:
      return { kind: "assert" as const };
  }
}

function targetNameFromObservation(
  observation: Observation,
  call: AgentToolCall,
): string | undefined {
  if ("ref" in call && typeof call.ref === "number") {
    return observation.nodes.find((n) => n.ref === call.ref)?.name;
  }
  return undefined;
}

async function logEvent(evidenceDir: string, event: Record<string, unknown>): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  await appendFile(path.join(evidenceDir, "events.ndjson"), line, "utf8");
}
