/**
 * Anthropic Claude adapter — real API calls only through src/llm/client.ts.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  formatHistoryEntry,
  formatUserPrompt,
  toolCallFromFunction,
  SYSTEM_PROMPT,
} from "../agent/tools.js";
import type { LLMHistoryEntry, LLMRequest, LLMResponse } from "./types.js";

function toAnthropicTools() {
  return [
    {
      name: "agent_action",
      description: "Execute one discovery agent action",
      input_schema: {
        type: "object" as const,
        properties: {
          tool: { type: "string", enum: ["navigate", "click", "fill", "select", "press", "extract", "wait_for", "report_business_outcome", "escalate", "done"] },
          url: { type: "string" },
          ref: { type: "integer" },
          text: { type: "string" },
          option: { type: "string" },
          key: { type: "string" },
          outputName: { type: "string" },
          code: { type: "string" },
          evidence: { type: "string" },
          reason: { type: "string" },
          whatHumanShouldDo: { type: "string" },
          summary: { type: "string" },
          checkpointDescription: { type: "string" },
          outputs: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["tool"],
      },
    },
  ];
}

function historyText(history: LLMHistoryEntry[]): string {
  return history
    .map((entry) => formatHistoryEntry(entry.step, entry.toolCall, entry.result))
    .join("\n");
}

function parseToolInput(input: Record<string, unknown>) {
  return toolCallFromFunction("agent_action", input);
}

export async function callAnthropic(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY is required for live Anthropic calls");
  }

  const client = new Anthropic({ apiKey });
  const userPrompt = formatUserPrompt(
    request.goal,
    request.observation.text,
    historyText(request.history),
  );

  const message = await client.messages.create({
    model: request.model,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: toAnthropicTools(),
    tool_choice: { type: "tool", name: "agent_action" },
    messages: [{ role: "user", content: userPrompt }],
  });

  const toolBlock = message.content.find((block) => block.type === "tool_use");
  if (toolBlock === undefined || toolBlock.type !== "tool_use") {
    throw new Error("Anthropic response did not include a tool_use block");
  }

  const toolCall = parseToolInput(toolBlock.input as Record<string, unknown>);
  const inputTokens = message.usage.input_tokens;
  const outputTokens = message.usage.output_tokens;

  return {
    toolCall,
    usage: { inputTokens, outputTokens },
    rawText: message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(""),
  };
}
