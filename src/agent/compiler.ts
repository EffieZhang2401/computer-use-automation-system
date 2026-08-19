/**
 * Two-phase compilation: mechanical steps from recordings, then optional
 * LLM annotation (Zod-validated) for intents, parameters, and outcomes.
 */
import { z } from "zod";
import {
  AssertionSchema,
  CapabilityArtifactSchema,
  OutcomeRuleSchema,
  ParamSpecSchema,
  OutputSpecSchema,
  SCHEMA_VERSION,
  type CapabilityArtifact,
  type Locator,
  type Step,
  type StepValue,
} from "../core/schema.js";
import { classifyRisk } from "../policy/gate.js";
import type { LLMClient } from "../llm/client.js";
import { PROMPT_VERSION } from "./tools.js";
import type { RecordedAction } from "./types.js";

const AnnotationOutputSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().min(1),
    inputs: z.array(ParamSpecSchema),
    outputs: z.array(OutputSpecSchema),
    stepIntents: z.record(z.string(), z.string()),
    successCheckpoint: AssertionSchema,
    outcomes: z.array(OutcomeRuleSchema),
  })
  .strict();
type AnnotationOutput = z.infer<typeof AnnotationOutputSchema>;

export type CompileContext = {
  discoveryRunId: string;
  model: string;
  recordedBy: string;
  targetUrl: string;
  baseUrl: string;
  artifactId?: string;
};

export function compileMechanical(
  recordings: readonly RecordedAction[],
  ctx: CompileContext,
): CapabilityArtifact {
  const steps: Step[] = [];
  let stepNum = 0;

  for (const entry of recordings) {
    const step = mechanicalStep(entry, ++stepNum);
    if (step !== null) steps.push(step);
  }

  const artifactId = ctx.artifactId ?? "member.read_savings_balance";

  return {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId,
    version: "0.1.0",
    status: "draft",
    name: "Discovered capability (mechanical draft)",
    description: "Auto-compiled from discovery recording — pending annotation review.",
    target: {
      appId: "corebank-lite",
      appVersionRange: ">=2.1 <3.0",
      entryPoint: "{{baseUrl}}/members/search",
    },
    surface: {
      kind: "web",
      capabilities: ["iframe"],
    },
    inputs: [
      {
        name: "baseUrl",
        type: "string",
        required: true,
        description: "Tenant base URL",
        sensitivity: "public",
        example: ctx.baseUrl,
      },
    ],
    outputs: [],
    steps,
    successCheckpoint: {
      kind: "urlMatches",
      pattern: ".*/members/.*",
    },
    outcomes: [],
    recoveries: [],
    policy: {
      allowedOrigins: [ctx.baseUrl, new URL(ctx.targetUrl).origin],
      allowedActions: ["navigate", "click", "fill", "select", "press", "extract", "waitFor", "assert"],
      maxSteps: 50,
      highestRisk: "reversible",
    },
    provenance: {
      discoveryRunId: ctx.discoveryRunId,
      model: ctx.model,
      promptVersion: PROMPT_VERSION,
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.recordedBy,
    },
  };
}

function mechanicalStep(entry: RecordedAction, index: number): Step | null {
  const id = `s${String(index).padStart(2, "0")}`;
  const call = entry.toolCall;

  switch (call.tool) {
    case "navigate":
      return {
        id,
        intent: `Navigate to ${call.url}`,
        action: "navigate",
        value: literalValue(call.url),
        risk: classifyRisk({ action: "navigate", url: call.url }),
      };
    case "click":
      return {
        id,
        intent: `Click ref ${call.ref}`,
        action: "click",
        target: entry.locator,
        risk: classifyRisk({ action: "click", targetName: locatorName(entry.locator) }),
      };
    case "fill":
      return {
        id,
        intent: `Fill ref ${call.ref}`,
        action: "fill",
        target: entry.locator,
        value: literalValue(call.text),
        risk: classifyRisk({ action: "fill", targetName: locatorName(entry.locator) }),
      };
    case "select":
      return {
        id,
        intent: `Select option in ref ${call.ref}`,
        action: "select",
        target: entry.locator,
        value: literalValue(call.option),
        risk: classifyRisk({ action: "select", targetName: locatorName(entry.locator) }),
      };
    case "press":
      return {
        id,
        intent: `Press ${call.key}`,
        action: "press",
        value: literalValue(call.key),
        risk: classifyRisk({ action: "press" }),
      };
    case "extract":
      return {
        id,
        intent: `Extract ${call.outputName} from ref ${call.ref}`,
        action: "extract",
        target: entry.locator,
        extractAs: call.outputName,
        risk: classifyRisk({ action: "extract", targetName: locatorName(entry.locator) }),
      };
    case "wait_for":
      return {
        id,
        intent: call.text !== undefined ? `Wait for text "${call.text}"` : `Wait for ref ${call.ref}`,
        action: "waitFor",
        risk: classifyRisk({ action: "waitFor" }),
      };
    default:
      return null;
  }
}

function literalValue(value: string): StepValue {
  return { kind: "literal", value };
}

function locatorName(locator: Locator | undefined): string | undefined {
  if (locator === undefined) return undefined;
  const primary = locator.primary;
  if (primary.by === "role") return primary.name;
  if (primary.by === "label") return primary.text;
  return undefined;
}

export async function compileWithAnnotation(
  recordings: readonly RecordedAction[],
  ctx: CompileContext,
  llm: LLMClient,
  goal: string,
): Promise<CapabilityArtifact> {
  const mechanical = compileMechanical(recordings, ctx);
  const summary = JSON.stringify(
    {
      goal,
      steps: mechanical.steps.map((s) => ({
        id: s.id,
        action: s.action,
        value: s.value,
        extractAs: s.extractAs,
        target: s.target?.primary,
      })),
    },
    null,
    2,
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { json } = await llm.annotate(summary);
      const annotation = AnnotationOutputSchema.parse(json);
      return mergeAnnotation(mechanical, annotation);
    } catch {
      if (attempt === 1) break;
    }
  }

  return mechanical;
}

function mergeAnnotation(
  mechanical: CapabilityArtifact,
  annotation: AnnotationOutput,
): CapabilityArtifact {
  const steps = mechanical.steps.map((step) => ({
    ...step,
    intent: annotation.stepIntents[step.id] ?? step.intent,
  }));

  const merged: CapabilityArtifact = {
    ...mechanical,
    id: annotation.id,
    name: annotation.name,
    description: annotation.description,
    inputs: annotation.inputs,
    outputs: annotation.outputs,
    steps,
    successCheckpoint: annotation.successCheckpoint,
    outcomes: annotation.outcomes,
  };

  return CapabilityArtifactSchema.parse(merged);
}
