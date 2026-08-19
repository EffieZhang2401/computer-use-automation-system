/**
 * Google Gemini adapter — real API calls only through src/llm/client.ts.
 */
import { GoogleGenAI, Type } from "@google/genai";
import {
  formatHistoryEntry,
  formatUserPrompt,
  SYSTEM_PROMPT,
  TOOL_DEFINITIONS,
  toolCallFromFunction,
} from "../agent/tools.js";
import type { LLMHistoryEntry, LLMRequest, LLMResponse } from "./types.js";

function historyText(history: LLMHistoryEntry[]): string {
  return history
    .map((entry) => formatHistoryEntry(entry.step, entry.toolCall, entry.result))
    .join("\n");
}

function toGeminiType(jsonType: string) {
  switch (jsonType) {
    case "integer":
      return Type.INTEGER;
    case "object":
      return Type.OBJECT;
    default:
      return Type.STRING;
  }
}

/** One function declaration per tool — Gemini 3.x calls these directly by name. */
function geminiFunctionDeclarations() {
  return TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: Type.OBJECT,
      properties: Object.fromEntries(
        Object.entries(tool.parameters.properties).map(([key, spec]) => [
          key,
          { type: toGeminiType(spec.type), description: "description" in spec ? spec.description : undefined },
        ]),
      ),
      required: "required" in tool.parameters ? [...tool.parameters.required] : [],
    },
  }));
}

const ALLOWED_FUNCTION_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

export async function callGemini(request: LLMRequest): Promise<LLMResponse> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("GEMINI_API_KEY is required for live Gemini calls");
  }

  const ai = new GoogleGenAI({ apiKey });
  const userPrompt = formatUserPrompt(
    request.goal,
    request.observation.text,
    historyText(request.history),
  );

  const response = await ai.models.generateContent({
    model: request.model,
    contents: [{ role: "user", parts: [{ text: `${SYSTEM_PROMPT}\n\n${userPrompt}` }] }],
    config: {
      tools: [{ functionDeclarations: geminiFunctionDeclarations() }],
      toolConfig: {
        functionCallingConfig: {
          mode: "ANY" as never,
          allowedFunctionNames: ALLOWED_FUNCTION_NAMES,
        },
      },
    },
  });

  const candidate = response.candidates?.[0];
  const part = candidate?.content?.parts?.find((p) => p.functionCall !== undefined);
  const fn = part?.functionCall;
  if (fn?.name === undefined || fn.name === "") {
    throw new Error("Gemini response did not include a function call");
  }

  const args = (fn.args ?? {}) as Record<string, unknown>;
  const toolCall = toolCallFromFunction(fn.name, args);

  const usageMeta = response.usageMetadata;
  const inputTokens = usageMeta?.promptTokenCount ?? 0;
  const outputTokens = usageMeta?.candidatesTokenCount ?? 0;

  return {
    toolCall,
    usage: { inputTokens, outputTokens },
    rawText: candidate?.content?.parts
      ?.filter((p) => p.text !== undefined)
      .map((p) => p.text ?? "")
      .join(""),
  };
}
