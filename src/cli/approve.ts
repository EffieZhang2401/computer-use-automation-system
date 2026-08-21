import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { CapabilityArtifactSchema } from "../core/schema.js";
import { defaultDraftPath, prepareApprovedArtifact } from "../replay/prepare-artifact.js";

function parseArgs(argv: string[]): { artifactPath: string; draftPath?: string } {
  let artifactPath = "";
  let draftPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact" && argv[i + 1] !== undefined) {
      artifactPath = argv[i + 1]!;
      i += 1;
    } else if (arg === "--draft" && argv[i + 1] !== undefined) {
      draftPath = argv[i + 1]!;
      i += 1;
    }
  }
  if (artifactPath === "") {
    throw new Error(
      "Usage: npm run approve -- --artifact artifacts/member.read_savings_balance/1.0.0.json",
    );
  }
  return { artifactPath, draftPath };
}

async function main(): Promise<void> {
  const { artifactPath, draftPath } = parseArgs(process.argv.slice(2));
  const resolvedOut = path.resolve(artifactPath);
  const inferredId = path.basename(path.dirname(resolvedOut));
  const sourcePath = path.resolve(draftPath ?? defaultDraftPath(inferredId));

  const raw = JSON.parse(await readFile(sourcePath, "utf8")) as unknown;
  const draft = CapabilityArtifactSchema.parse(raw);
  const approved = prepareApprovedArtifact(draft);

  await mkdir(path.dirname(resolvedOut), { recursive: true });
  await writeFile(resolvedOut, `${JSON.stringify(approved, null, 2)}\n`, "utf8");

  console.log(`Approved artifact written to ${resolvedOut}`);
  console.log(`Status: ${approved.status}`);
  console.log(`Version: ${approved.version}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
