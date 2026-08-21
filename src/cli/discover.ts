import { loadDotEnv } from "../core/env.js";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from "../../demo-app/seed.js";
import { newRunId, runDiscovery } from "../agent/loop.js";
import { ensureOperatorServer } from "../operator/server.js";

function parseArgs(argv: string[]): {
  goal: string;
  target: string;
  headless: boolean;
  operator: boolean;
} {
  let goal = "";
  let target = "";
  let headless: boolean | undefined;
  let operator = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--goal" && argv[i + 1] !== undefined) {
      goal = argv[i + 1]!;
      i += 1;
    } else if (arg === "--target" && argv[i + 1] !== undefined) {
      target = argv[i + 1]!;
      i += 1;
    } else if (arg === "--headed") {
      headless = false;
    } else if (arg === "--headless") {
      headless = true;
    } else if (arg === "--no-operator") {
      operator = false;
    }
  }
  if (goal === "" || target === "") {
    throw new Error(
      'Usage: npm run discover -- --goal "..." --target http://localhost:3100/... [--headed]',
    );
  }
  // Operator handoff only makes sense with a visible browser (--headed).
  const resolvedHeadless = headless ?? true;
  return { goal, target, headless: resolvedHeadless, operator };
}

async function main(): Promise<void> {
  loadDotEnv();
  const { goal, target, headless, operator } = parseArgs(process.argv.slice(2));
  const baseUrl = new URL(target).origin;
  const runId = newRunId();

  console.log(`Discovery run ${runId}`);
  console.log(`Goal: ${goal}`);
  console.log(`Target: ${target}`);
  console.log(`Headless: ${headless}`);
  console.log(`LLM_MODE=${process.env.LLM_MODE ?? "auto"}`);
  console.log(`LLM_PROVIDER=${process.env.LLM_PROVIDER ?? "gemini"}`);
  console.log(`MODEL=${process.env.MODEL ?? "(default)"}`);

  if (operator) {
    const server = await ensureOperatorServer();
    console.log(`Operator console: ${server.url}`);
    if (headless) {
      console.log("Note: pass --headed to pause for human intervention on stuck/irreversible steps.");
    }
  }

  const { result, artifact, evidenceDir } = await runDiscovery({
    goal,
    targetUrl: target,
    runId,
    baseUrl,
    annotate: true,
    headless,
    enableInterventionHandoff: operator && !headless,
    authCookies: [{ name: AUTH_COOKIE, value: AUTH_COOKIE_VALUE, url: baseUrl }],
  });

  console.log("");
  console.log(`Evidence: ${evidenceDir}/events.ndjson`);
  console.log(`Artifact: artifacts/${artifact.id}.draft.json`);
  console.log(`Status: ${result.status}`);

  if (result.status === "intervention") {
    console.log(`Intervention: ${result.intervention.reason} — ${result.intervention.message}`);
    process.exitCode = 2;
  } else {
    console.log(`Terminal: ${result.terminalTool.tool}`);
    if (Object.keys(result.outputs).length > 0) {
      console.log("Outputs:", result.outputs);
    }
  }
}

main().catch((err) => {
  const e = err as Error & { cause?: Error };
  console.error(e.message);
  if (e.cause !== undefined) {
    console.error("Cause:", e.cause.message ?? e.cause);
  }
  if (e.message.includes("fetch failed")) {
    console.error("");
    console.error("Hints:");
    console.error("  1. Is the demo app running?  npm run demo-app");
    console.error("  2. Is your internet connection working?");
    console.error("  3. Test Gemini alone:  npx tsx scripts/test-gemini.ts");
  }
  process.exitCode = 1;
});
