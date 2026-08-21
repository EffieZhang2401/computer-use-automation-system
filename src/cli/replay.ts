import { loadDotEnv } from "../core/env.js";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE } from "../../demo-app/seed.js";
import { loadArtifactFromFile, runReplay } from "../replay/executor.js";

function parseArgs(argv: string[]): {
  artifactPath: string;
  params: Record<string, string>;
  inject?: string;
} {
  let artifactPath = "";
  const params: Record<string, string> = {};
  let inject: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact" && argv[i + 1] !== undefined) {
      artifactPath = argv[i + 1]!;
      i += 1;
    } else if (arg === "--input" && argv[i + 1] !== undefined) {
      const pair = argv[i + 1]!;
      const eq = pair.indexOf("=");
      if (eq <= 0) throw new Error(`Invalid --input value: ${pair}`);
      params[pair.slice(0, eq)] = pair.slice(eq + 1);
      i += 1;
    } else if (arg === "--inject" && argv[i + 1] !== undefined) {
      inject = argv[i + 1]!;
      i += 1;
    }
  }

  if (artifactPath === "") {
    throw new Error(
      "Usage: npm run replay -- --artifact artifacts/.../1.0.0.json --input memberId=12345",
    );
  }

  return { artifactPath, params, inject };
}

async function main(): Promise<void> {
  loadDotEnv();
  const { artifactPath, params, inject } = parseArgs(process.argv.slice(2));
  const artifact = await loadArtifactFromFile(artifactPath);

  const baseUrl =
    params.baseUrl ??
    artifact.inputs.find((input) => input.name === "baseUrl")?.example?.toString() ??
    "http://localhost:3100";

  const replayParams = { ...params, baseUrl };

  const result = await runReplay({
    artifact,
    params: replayParams,
    injectMode: inject,
    authCookies: [{ name: AUTH_COOKIE, value: AUTH_COOKIE_VALUE, url: baseUrl }],
  });

  console.log(`Replay ${result.runId}`);
  console.log(`Status: ${result.status}`);
  console.log(`Evidence: ${result.evidenceDir}`);

  if (result.status === "success") {
    console.log("Outputs:", result.outputs);
  } else if (result.status === "business_outcome") {
    console.log(`Outcome: ${result.outcome?.code} — ${result.outcome?.message}`);
  } else if (result.status === "failed") {
    console.log(`Failure at ${result.failure?.stepId}: ${result.failure?.kind}`);
    console.log(`Expected: ${result.failure?.expected}`);
    console.log(`Observed: ${result.failure?.observed}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
