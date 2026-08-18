import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTH_COOKIE, AUTH_COOKIE_VALUE, EXISTING_MEMBER_ID, LOGIN } from "../../demo-app/seed.js";
import { WebSurface } from "../surface/web-surface.js";

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3100";

async function main(): Promise<void> {
  const surface = await WebSurface.launch({
    headless: true,
    cookies: [{ name: AUTH_COOKIE, value: AUTH_COOKIE_VALUE, url: baseUrl }],
  });

  try {
    await surface.act({ kind: "navigate", url: `${baseUrl}/members/search` });
    const observation = await surface.observe();
    console.log(observation.text);
    console.log("");

    const memberField = observation.nodes.find(
      (n) => n.role === "textbox" && n.name.toLowerCase().includes("member id"),
    );
    const searchButton = observation.nodes.find(
      (n) => n.role === "button" && n.name.toLowerCase() === "search",
    );

    if (memberField === undefined || searchButton === undefined) {
      throw new Error("Could not find Member ID field or Search button in observation");
    }

    console.log(`Using ref=${memberField.ref} for Member ID, ref=${searchButton.ref} for Search`);

    const fillResult = await surface.act({
      kind: "fill",
      ref: memberField.ref,
      text: EXISTING_MEMBER_ID,
    });
    if (!fillResult.ok) throw new Error(fillResult.error ?? "fill failed");

    const clickResult = await surface.act({ kind: "click", ref: searchButton.ref });
    if (!clickResult.ok) throw new Error(clickResult.error ?? "click failed");

    await surface.getPage().waitForURL(/\/members\/12345/, { timeout: 10_000 });
    const after = await surface.observe();
    console.log("");
    console.log("After search:");
    console.log(after.text);

    const screenshot = await surface.screenshot();
    const outDir = path.resolve("artifacts");
    await mkdir(outDir, { recursive: true });
    const screenshotPath = path.join(outDir, "probe-screenshot.png");
    await writeFile(screenshotPath, screenshot);
    console.log("");
    console.log(`Screenshot written to ${screenshotPath}`);
    console.log(`Logged in as ${LOGIN.username}, searched member ${EXISTING_MEMBER_ID}`);
  } finally {
    await surface.close();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
