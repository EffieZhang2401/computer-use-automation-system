/**
 * Standalone operator console server.
 * Discovery/replay also call ensureOperatorServer() in-process; this entry
 * point is for opening the console before a run.
 */
import { ensureOperatorServer } from "../operator/server.js";

async function main(): Promise<void> {
  const server = await ensureOperatorServer();
  console.log(`Open ${server.url} in a browser.`);
  console.log("Waiting for discovery/replay sessions in this process…");
  console.log("(Prefer starting the console via `npm run discover -- --headed` so it shares the session registry.)");
  // Keep process alive.
  await new Promise(() => undefined);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
