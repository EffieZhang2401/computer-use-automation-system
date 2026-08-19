/**
 * Discovery agent tool definitions — the model's constrained action space.
 * Every tool call is Zod-validated before execution.
 */
import { z } from "zod";

export const PROMPT_VERSION = "discovery-v1" as const;

export const NavigateToolSchema = z
  .object({ tool: z.literal("navigate"), url: z.string().min(1) })
  .strict();
export const ClickToolSchema = z
  .object({ tool: z.literal("click"), ref: z.number().int().nonnegative() })
  .strict();
export const FillToolSchema = z
  .object({
    tool: z.literal("fill"),
    ref: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict();
export const SelectToolSchema = z
  .object({
    tool: z.literal("select"),
    ref: z.number().int().nonnegative(),
    option: z.string().min(1),
  })
  .strict();
export const PressToolSchema = z
  .object({ tool: z.literal("press"), key: z.string().min(1) })
  .strict();
export const ExtractToolSchema = z
  .object({
    tool: z.literal("extract"),
    ref: z.number().int().nonnegative(),
    outputName: z.string().min(1),
  })
  .strict();
export const WaitForToolSchema = z
  .object({
    tool: z.literal("wait_for"),
    text: z.string().min(1).optional(),
    ref: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((v) => v.text !== undefined || v.ref !== undefined, {
    message: "wait_for requires text or ref",
  });
export const ReportBusinessOutcomeToolSchema = z
  .object({
    tool: z.literal("report_business_outcome"),
    code: z.string().min(1),
    evidence: z.string().min(1),
  })
  .strict();
export const EscalateToolSchema = z
  .object({
    tool: z.literal("escalate"),
    reason: z.string().min(1),
    whatHumanShouldDo: z.string().min(1),
  })
  .strict();
export const DoneToolSchema = z
  .object({
    tool: z.literal("done"),
    summary: z.string().min(1),
    checkpointDescription: z.string().min(1),
    outputs: z.record(z.string(), z.string()),
  })
  .strict();

export const AgentToolCallSchema = z.discriminatedUnion("tool", [
  NavigateToolSchema,
  ClickToolSchema,
  FillToolSchema,
  SelectToolSchema,
  PressToolSchema,
  ExtractToolSchema,
  WaitForToolSchema,
  ReportBusinessOutcomeToolSchema,
  EscalateToolSchema,
  DoneToolSchema,
]);
export type AgentToolCall = z.infer<typeof AgentToolCallSchema>;

export function parseAgentToolCall(raw: unknown): AgentToolCall {
  return AgentToolCallSchema.parse(raw);
}

const TOOL_NAME_ALIASES: Record<string, AgentToolCall["tool"]> = {
  navigate: "navigate",
  click: "click",
  fill: "fill",
  select: "select",
  press: "press",
  extract: "extract",
  wait_for: "wait_for",
  waitFor: "wait_for",
  report_business_outcome: "report_business_outcome",
  reportBusinessOutcome: "report_business_outcome",
  escalate: "escalate",
  done: "done",
};

/** Build a validated tool call from a Gemini/Anthropic function name + args. */
export function toolCallFromFunction(
  functionName: string,
  args: Record<string, unknown>,
): AgentToolCall {
  if (functionName === "agent_action") {
    const tool = normalizeToolName(String(args.tool ?? ""));
    const { tool: _ignored, ...rest } = args;
    return parseAgentToolCall({ tool, ...coerceToolArgs(rest) });
  }

  const tool = normalizeToolName(functionName);
  const coerced = coerceToolArgs(args);
  if (tool === "done" && coerced.outputs === undefined) {
    coerced.outputs = {};
  }
  return parseAgentToolCall({ tool, ...coerced });
}

function normalizeToolName(name: string): AgentToolCall["tool"] {
  const mapped = TOOL_NAME_ALIASES[name] ?? TOOL_NAME_ALIASES[name.toLowerCase()];
  if (mapped === undefined) {
    throw new Error(`Unknown tool name from model: ${name}`);
  }
  return mapped;
}

function coerceToolArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out = { ...args };
  if (out.ref !== undefined && typeof out.ref === "string") {
    out.ref = Number.parseInt(out.ref, 10);
  }
  if (out.outputs !== undefined && typeof out.outputs === "string") {
    try {
      out.outputs = JSON.parse(out.outputs) as unknown;
    } catch {
      out.outputs = {};
    }
  }
  return out;
}

export function isTerminalTool(call: AgentToolCall): boolean {
  return (
    call.tool === "done" ||
    call.tool === "escalate" ||
    call.tool === "report_business_outcome"
  );
}

/** JSON-schema-like tool definitions sent to the LLM provider. */
export const TOOL_DEFINITIONS = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL",
    parameters: {
      type: "object",
      properties: { url: { type: "string", description: "Absolute or relative URL" } },
      required: ["url"],
    },
  },
  {
    name: "click",
    description: "Click an interactive element by ref",
    parameters: {
      type: "object",
      properties: { ref: { type: "integer", description: "Element ref from observation" } },
      required: ["ref"],
    },
  },
  {
    name: "fill",
    description: "Type text into an input by ref",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        text: { type: "string" },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "select",
    description: "Select an option in a dropdown by ref",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        option: { type: "string" },
      },
      required: ["ref", "option"],
    },
  },
  {
    name: "press",
    description: "Press a keyboard key",
    parameters: {
      type: "object",
      properties: { key: { type: "string", description: "Key name, e.g. Enter" } },
      required: ["key"],
    },
  },
  {
    name: "extract",
    description: "Read text from an element and store it as an output",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "integer" },
        outputName: { type: "string" },
      },
      required: ["ref", "outputName"],
    },
  },
  {
    name: "wait_for",
    description: "Wait until text appears or a ref is visible",
    parameters: {
      type: "object",
      properties: {
        text: { type: "string" },
        ref: { type: "integer" },
      },
    },
  },
  {
    name: "report_business_outcome",
    description: "Report a terminal business outcome such as member not found",
    parameters: {
      type: "object",
      properties: {
        code: { type: "string" },
        evidence: { type: "string" },
      },
      required: ["code", "evidence"],
    },
  },
  {
    name: "escalate",
    description: "Request human intervention",
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" },
        whatHumanShouldDo: { type: "string" },
      },
      required: ["reason", "whatHumanShouldDo"],
    },
  },
  {
    name: "done",
    description: "Goal achieved — summarize and list extracted outputs",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string" },
        checkpointDescription: { type: "string" },
        outputs: {
          type: "object",
          additionalProperties: { type: "string" },
        },
      },
      required: ["summary", "checkpointDescription", "outputs"],
    },
  },
] as const;

export const SYSTEM_PROMPT = `You are a computer-use discovery agent. You automate web UIs by choosing exactly one tool per turn.

Rules:
- Act only by ref numbers from the accessibility observation — never invent CSS selectors or DOM paths.
- Prefer fill + click over navigate when already on the right page.
- When the goal is achieved, call done with all extracted outputs.
- If the app shows a business error (member not found, permission denied), call report_business_outcome.
- If stuck or unsure, call escalate with a clear reason.
- One tool call per response.`;

export function formatUserPrompt(goal: string, observationText: string, history: string): string {
  const parts = [`Goal: ${goal}`, "", "Current observation:", observationText];
  if (history !== "") {
    parts.push("", "Previous steps:", history);
  }
  parts.push("", "Choose the next tool to execute.");
  return parts.join("\n");
}

export function formatHistoryEntry(
  step: number,
  toolCall: AgentToolCall,
  result: string,
): string {
  return `Step ${step}: ${JSON.stringify(toolCall)} → ${result}`;
}
