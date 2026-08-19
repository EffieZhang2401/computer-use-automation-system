/**
 * LLM annotation pass for compiler phase 2 — structured JSON output,
 * routed through the same provider selection as discovery.
 */
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { LLMProvider } from "./types.js";

const ANNOTATION_PROMPT = `You annotate a discovery recording into capability artifact metadata.
Return JSON with: id, name, description, inputs (ParamSpec[]), outputs (OutputSpec[]),
stepIntents (map stepId→intent string), successCheckpoint (Assertion), outcomes (OutcomeRule[]).
Parameterize member IDs and other PII as inputs with sensitivity "pii".
Never invent locators — only annotate metadata.`;

export type AnnotateUsage = { inputTokens: number; outputTokens: number };

export async function annotateRecordingJson(
  provider: LLMProvider,
  model: string,
  recordingSummary: string,
): Promise<{ json: unknown; usage: AnnotateUsage }> {
  const prompt = `${ANNOTATION_PROMPT}\n\nRecording:\n${recordingSummary}`;
  if (provider === "gemini") return annotateWithGemini(model, prompt);
  return annotateWithAnthropic(model, prompt);
}

async function annotateWithGemini(
  model: string,
  prompt: string,
): Promise<{ json: unknown; usage: AnnotateUsage }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("GEMINI_API_KEY is required for annotation");
  }
  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: { responseMimeType: "application/json" },
  });
  const text = response.text ?? "";
  const usageMeta = response.usageMetadata;
  return {
    json: JSON.parse(text) as unknown,
    usage: {
      inputTokens: usageMeta?.promptTokenCount ?? 0,
      outputTokens: usageMeta?.candidatesTokenCount ?? 0,
    },
  };
}

async function annotateWithAnthropic(
  model: string,
  prompt: string,
): Promise<{ json: unknown; usage: AnnotateUsage }> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey === undefined || apiKey === "") {
    throw new Error("ANTHROPIC_API_KEY is required for annotation");
  }
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `${prompt}\n\nRespond with JSON only, no markdown fences.`,
      },
    ],
  });
  const text = message.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
  const cleaned = text.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  return {
    json: JSON.parse(cleaned) as unknown,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}
