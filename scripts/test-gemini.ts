import { loadDotEnv } from "../src/core/env.js";
import { GoogleGenAI } from "@google/genai";

loadDotEnv();

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.MODEL ?? "gemini-3.5-flash-lite";
  console.log("Model:", model);
  console.log("Key prefix:", apiKey?.slice(0, 8) ?? "(missing)");

  if (!apiKey) {
    console.error("GEMINI_API_KEY not set");
    process.exit(1);
  }

  const ai = new GoogleGenAI({ apiKey });
  try {
    const r = await ai.models.generateContent({
      model,
      contents: "Reply with exactly one word: hello",
    });
    console.log("OK:", r.text);
  } catch (err) {
    const e = err as Error & { cause?: unknown };
    console.error("ERR:", e.message);
    if (e.cause !== undefined) console.error("CAUSE:", e.cause);
    if ("status" in (err as object)) console.error("STATUS:", (err as { status?: unknown }).status);
  }
}

main();
