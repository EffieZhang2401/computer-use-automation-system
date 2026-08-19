import { loadDotEnv } from "../src/core/env.js";
import { callGemini } from "../src/llm/gemini.js";
import type { LLMRequest } from "../src/llm/types.js";

loadDotEnv();

const request: LLMRequest = {
  goal: "look up member 12345 and read their current savings balance",
  observation: {
    url: "http://localhost:3100/members/search",
    text: 'url: http://localhost:3100/members/search\n\n[ref=26] textbox "Member ID"\n[ref=31] button "Search"',
    hash: "testhash",
  },
  history: [],
  model: process.env.MODEL ?? "gemini-3.5-flash-lite",
  promptVersion: "discovery-v1",
};

callGemini(request)
  .then((r) => {
    console.log("OK:", JSON.stringify(r.toolCall, null, 2));
    console.log("Usage:", r.usage);
  })
  .catch((err: Error & { cause?: unknown }) => {
    console.error("ERR:", err.message);
    if (err.cause !== undefined) console.error("CAUSE:", err.cause);
    console.error(err);
  });
