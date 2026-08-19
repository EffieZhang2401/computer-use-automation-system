import {
  chromium,
  type Browser,
  type BrowserContext,
  type Frame,
  type Locator as PwLocator,
  type Page,
} from "playwright";
import type { Locator as SchemaLocator, Strategy } from "../core/schema.js";
import {
  buildObservation,
  collectObservationEntries,
  compressAxEntries,
  type RawAxNode,
} from "./a11y.js";
import {
  resolveLocator,
  type LocatorResolveBackend,
  type VerifyFields,
} from "./locator-resolver.js";
import type {
  ActionCall,
  ActionResult,
  FramePath,
  Observation,
  Surface,
} from "./surface.js";

type RefTarget = {
  framePath: FramePath;
  backendDOMNodeId: number;
  role: string;
  name: string;
};

type WebSurfaceOptions = {
  baseUrl?: string;
  headless?: boolean;
  cookies?: Array<{ name: string; value: string; url: string }>;
};

export class WebSurface implements Surface {
  private readonly refTargets = new Map<number, RefTarget>();

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly page: Page,
  ) {}

  static async launch(opts: WebSurfaceOptions = {}): Promise<WebSurface> {
    const browser = await chromium.launch({ headless: opts.headless ?? true });
    const context = await browser.newContext();
    if (opts.cookies !== undefined && opts.cookies.length > 0) {
      await context.addCookies(opts.cookies);
    }
    const page = await context.newPage();
    if (opts.baseUrl !== undefined) {
      await page.goto(opts.baseUrl, { waitUntil: "domcontentloaded" });
    }
    return new WebSurface(browser, context, page);
  }

  async close(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  getPage(): Page {
    return this.page;
  }

  async observe(): Promise<Observation> {
    const entries = await this.collectAllAxEntries(this.page, []);
    const nodes = compressAxEntries(entries);
    this.refTargets.clear();

    for (const node of nodes) {
      const entry = entries.find((e) => e.node.backendDOMNodeId === node.ref);
      if (entry?.node.backendDOMNodeId !== undefined) {
        this.refTargets.set(node.ref, {
          framePath: [...entry.frame],
          backendDOMNodeId: entry.node.backendDOMNodeId,
          role: node.role,
          name: node.name,
        });
      }
    }

    return buildObservation(this.page.url(), nodes);
  }

  async act(call: ActionCall): Promise<ActionResult> {
    try {
      switch (call.kind) {
        case "navigate":
          await this.page.goto(call.url, { waitUntil: "domcontentloaded" });
          return { ok: true };
        case "click":
          await this.performOnRef(call.ref, async (locator) => {
            await locator.click();
          });
          return { ok: true };
        case "fill":
          await this.performOnRef(call.ref, async (locator) => {
            await locator.fill(call.text);
          });
          return { ok: true };
        case "select":
          await this.performOnRef(call.ref, async (locator) => {
            await locator.selectOption(call.value);
          });
          return { ok: true };
        case "press":
          await this.page.keyboard.press(call.key);
          return { ok: true };
        default: {
          const _exhaustive: never = call;
          return { ok: false, error: `Unknown action: ${String(_exhaustive)}` };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async screenshot(): Promise<Buffer> {
    const bytes = await this.page.screenshot({ fullPage: true });
    return Buffer.from(bytes);
  }

  async resolveSchemaLocator(locator: SchemaLocator) {
    const backend = createPlaywrightResolveBackend(this.page);
    return resolveLocator(locator, backend);
  }

  /** Read visible text from an observed ref. */
  async extractText(ref: number): Promise<string> {
    let text = "";
    await this.performOnRef(ref, async (locator) => {
      text = (await locator.innerText()).trim();
    });
    return text;
  }

  /**
   * Capture the full locator candidate ladder from the real element at `ref`.
   * Used by the recorder — locators are never invented by the model.
   */
  async captureLocator(ref: number): Promise<SchemaLocator | null> {
    const target = this.refTargets.get(ref);
    if (target === undefined) return null;

    const frame = await resolveFramePath(this.page, target.framePath);
    const pwLocator = locatorForTarget(frame, target);
    const handle = await pwLocator.elementHandle({ timeout: 2000 }).catch(() => null);
    if (handle === null) return null;

    try {
      const meta = await handle.evaluate((el) => {
        const html = el as HTMLElement;
        const tag = html.tagName.toLowerCase();
        const roleAttr = html.getAttribute("role");
        const role =
          roleAttr ??
          (tag === "input"
            ? html.getAttribute("type") === "button"
              ? "button"
              : "textbox"
            : tag === "button"
              ? "button"
              : tag === "a"
                ? "link"
                : tag);
        const aria = html.getAttribute("aria-label") ?? "";
        const id = html.id;
        const nameAttr = html.getAttribute("name") ?? "";
        const labelEl =
          id !== "" ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
        const labelText = labelEl?.textContent?.trim() ?? "";
        const accessibleName = aria !== "" ? aria : labelText;

        const cssCandidates: string[] = [];
        if (id !== "") cssCandidates.push(`#${CSS.escape(id)}`);
        if (nameAttr !== "") cssCandidates.push(`${tag}[name="${nameAttr}"]`);

        const segments: string[] = [];
        let node: Element | null = html;
        while (node !== null && node.tagName !== "HTML") {
          const parent: Element | null = node.parentElement;
          if (parent === null) break;
          const tagName = node.tagName;
          const siblings = Array.from(parent.children).filter(
            (c: Element) => c.tagName === tagName,
          );
          const index = siblings.indexOf(node) + 1;
          segments.unshift(`${node.tagName.toLowerCase()}[${index}]`);
          node = parent;
        }
        const domPath = segments.join("/");

        const rect = html.getBoundingClientRect();
        return {
          role: role.toLowerCase(),
          accessibleName,
          labelText,
          cssCandidates,
          domPath,
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
        };
      });

      const fallbacks: Strategy[] = [];
      if (meta.labelText !== "" && meta.labelText !== meta.accessibleName) {
        fallbacks.push({ by: "label", text: meta.labelText });
      }
      for (const selector of meta.cssCandidates) {
        fallbacks.push({ by: "css", selector });
      }
      if (meta.domPath !== "") {
        fallbacks.push({ by: "domPath", path: meta.domPath });
      }
      fallbacks.push({
        by: "coordinates",
        x: meta.x,
        y: meta.y,
        relativeTo: "viewport",
      });

      const primary: Strategy =
        meta.accessibleName !== ""
          ? {
              by: "role",
              role: meta.role,
              name: meta.accessibleName,
              nameMatch: "exact",
            }
          : meta.cssCandidates[0] !== undefined
            ? { by: "css", selector: meta.cssCandidates[0] }
            : { by: "domPath", path: meta.domPath };

      const verify =
        meta.accessibleName !== ""
          ? { role: meta.role, nameContains: meta.accessibleName.slice(0, 20) }
          : { role: meta.role };

      return {
        frame: target.framePath.length > 0 ? [...target.framePath] : undefined,
        primary,
        fallbacks,
        verify,
      };
    } finally {
      await handle.dispose();
    }
  }

  private async performOnRef(
    ref: number,
    fn: (locator: PwLocator) => Promise<void>,
  ): Promise<void> {
    const target = this.refTargets.get(ref);
    if (target === undefined) {
      throw new Error(`Unknown ref ${ref} — call observe() first`);
    }
    const frame = await resolveFramePath(this.page, target.framePath);
    const locator = locatorForTarget(frame, target);
    await fn(locator);
  }

  private async collectAllAxEntries(
    pageOrFrame: Page | Frame,
    framePath: FramePath,
  ): Promise<Array<{ node: RawAxNode; frame: FramePath }>> {
    const { nodes } = await fetchAxTree(pageOrFrame);
    const index = new Map(nodes.map((n) => [n.nodeId, n]));
    const childIds = new Set(nodes.flatMap((n) => n.childIds ?? []));
    const roots = nodes.filter((n) => !childIds.has(n.nodeId));
    const out: Array<{ node: RawAxNode; frame: FramePath }> = [];
    collectObservationEntries(roots, index, framePath, out);

    const frames = "frames" in pageOrFrame ? (pageOrFrame as Page).frames() : (pageOrFrame as Frame).childFrames();
    const main = "mainFrame" in pageOrFrame ? (pageOrFrame as Page).mainFrame() : pageOrFrame;

    for (const child of frames) {
      if (child === main) continue;
      const name = child.name();
      if (name === "") continue;
      const childEntries = await this.collectAllAxEntries(child, [...framePath, name]);
      out.push(...childEntries);
    }

    return out;
  }
}

function locatorForTarget(frame: Frame, target: RefTarget): PwLocator {
  const role = target.role as Parameters<Frame["getByRole"]>[0];
  if (target.name !== "") {
    return frame.getByRole(role, { name: target.name, exact: true });
  }
  return frame.getByRole(role);
}

async function fetchAxTree(pageOrFrame: Page | Frame): Promise<{ nodes: RawAxNode[] }> {
  const session = await owningPage(pageOrFrame).context().newCDPSession(pageOrFrame);
  try {
    const tree = (await session.send("Accessibility.getFullAXTree")) as { nodes?: RawAxNode[] };
    return { nodes: tree.nodes ?? [] };
  } finally {
    await session.detach();
  }
}

async function resolveFramePath(page: Page, framePath: FramePath): Promise<Frame> {
  let current: Frame = page.mainFrame();
  for (const segment of framePath) {
    const next = current.childFrames().find((f) => f.name() === segment);
    if (next === undefined) {
      throw new Error(`Frame not found: ${segment} in [${framePath.join(" > ")}]`);
    }
    current = next;
  }
  return current;
}

function owningPage(target: Page | Frame): Page {
  return "mainFrame" in target ? target : target.page();
}

function createPlaywrightResolveBackend(page: Page): LocatorResolveBackend<RefTarget> {
  return {
    async resolveStrategy(strategy: Strategy, frame?: string[]): Promise<RefTarget | null> {
      const targetFrame = await resolveFramePath(page, frame ?? []);
      switch (strategy.by) {
        case "role": {
          const pw = targetFrame.getByRole(strategy.role as Parameters<Frame["getByRole"]>[0], {
            name: strategy.name,
            exact: strategy.nameMatch === "exact",
          });
          return metaFromLocator(targetFrame, pw, frame ?? []);
        }
        case "label": {
          const pw = targetFrame.getByLabel(strategy.text, { exact: true });
          return metaFromLocator(targetFrame, pw, frame ?? []);
        }
        case "css": {
          const pw = targetFrame.locator(strategy.selector);
          return metaFromLocator(targetFrame, pw, frame ?? []);
        }
        case "domPath":
        case "textAnchor":
        case "coordinates":
          return null;
        default: {
          const _exhaustive: never = strategy;
          return _exhaustive;
        }
      }
    },

    async readVerifyFields(candidate: RefTarget): Promise<VerifyFields> {
      return {
        role: candidate.role,
        name: candidate.name,
        text: candidate.name,
      };
    },
  };
}

async function metaFromLocator(
  frame: Frame,
  locator: PwLocator,
  framePath: FramePath,
): Promise<RefTarget | null> {
  const handle = await locator.elementHandle({ timeout: 2000 }).catch(() => null);
  if (handle === null) return null;

  const meta = await handle.evaluate((el) => {
    const html = el as HTMLElement;
    const role =
      html.getAttribute("role") ??
      (html.tagName === "INPUT"
        ? "textbox"
        : html.tagName === "BUTTON"
          ? "button"
          : html.tagName.toLowerCase());
    const aria = html.getAttribute("aria-label") ?? "";
    const id = html.id;
    const labelEl = id !== "" ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const labelText = labelEl?.textContent?.trim() ?? "";
    const name = aria !== "" ? aria : labelText;
    return { role: role.toLowerCase(), name };
  });

  const backendDOMNodeId = await readBackendNodeId(frame, handle);
  await handle.dispose();
  if (backendDOMNodeId === undefined) {
    return {
      framePath: [...framePath],
      backendDOMNodeId: -1,
      role: meta.role,
      name: meta.name,
    };
  }

  return {
    framePath: [...framePath],
    backendDOMNodeId,
    role: meta.role,
    name: meta.name,
  };
}

async function readBackendNodeId(
  frame: Frame,
  handle: NonNullable<Awaited<ReturnType<PwLocator["elementHandle"]>>>,
): Promise<number | undefined> {
  const session = await owningPage(frame).context().newCDPSession(frame);
  try {
    const objectId = (handle as unknown as { _objectId?: string })._objectId;
    if (objectId === undefined) return undefined;
    const described = (await session.send("DOM.describeNode", { objectId })) as {
      node?: { backendNodeId?: number };
    };
    return described.node?.backendNodeId;
  } finally {
    await session.detach();
  }
}
