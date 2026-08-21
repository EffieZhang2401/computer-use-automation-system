import type { Assertion, Locator } from "../core/schema.js";

export type AssertionEnv = {
  url: string;
  pageText: string;
  isLocatorVisible: (locator: Locator) => Promise<boolean>;
  readLocatorText?: (locator: Locator) => Promise<string | null>;
};

export async function evaluateAssertion(
  assertion: Assertion,
  env: AssertionEnv,
): Promise<boolean> {
  switch (assertion.kind) {
    case "visible":
      return env.isLocatorVisible(assertion.locator);
    case "textPresent": {
      const haystack =
        assertion.scope !== undefined
          ? await readScopedText(assertion.scope, env)
          : env.pageText;
      if ("text" in assertion) return haystack.includes(assertion.text);
      return new RegExp(assertion.pattern).test(haystack);
    }
    case "textAbsent": {
      if ("text" in assertion) return !env.pageText.includes(assertion.text);
      return !new RegExp(assertion.pattern).test(env.pageText);
    }
    case "urlMatches":
      return new RegExp(assertion.pattern).test(env.url);
    case "all": {
      for (const child of assertion.of) {
        if (!(await evaluateAssertion(child, env))) return false;
      }
      return true;
    }
    case "any": {
      for (const child of assertion.of) {
        if (await evaluateAssertion(child, env)) return true;
      }
      return false;
    }
    default: {
      const _exhaustive: never = assertion;
      return _exhaustive;
    }
  }
}

async function readScopedText(locator: Locator, env: AssertionEnv): Promise<string> {
  if (env.readLocatorText !== undefined) {
    const text = await env.readLocatorText(locator);
    if (text !== null) return text;
  }
  if (await env.isLocatorVisible(locator)) return env.pageText;
  return "";
}

/** Human-readable expected state for failure payloads. */
export function describeAssertion(assertion: Assertion): string {
  switch (assertion.kind) {
    case "visible":
      return `locator visible (${strategySummary(assertion.locator.primary)})`;
    case "textPresent":
      return "text" in assertion
        ? `text present: "${assertion.text}"`
        : `text matches: /${assertion.pattern}/`;
    case "textAbsent":
      return "text" in assertion
        ? `text absent: "${assertion.text}"`
        : `text absent matching: /${assertion.pattern}/`;
    case "urlMatches":
      return `url matches: /${assertion.pattern}/`;
    case "all":
      return `all of: ${assertion.of.map(describeAssertion).join("; ")}`;
    case "any":
      return `any of: ${assertion.of.map(describeAssertion).join("; ")}`;
    default: {
      const _exhaustive: never = assertion;
      return _exhaustive;
    }
  }
}

function strategySummary(strategy: Locator["primary"]): string {
  switch (strategy.by) {
    case "role":
      return `${strategy.role} "${strategy.name}"`;
    case "label":
      return `label "${strategy.text}"`;
    case "css":
      return `css ${strategy.selector}`;
    case "domPath":
      return `domPath ${strategy.path}`;
    case "textAnchor":
      return `anchor "${strategy.anchorText}"`;
    case "coordinates":
      return `coordinates (${strategy.x}, ${strategy.y})`;
    default: {
      const _exhaustive: never = strategy;
      return _exhaustive;
    }
  }
}

/** Snippet of page state for failure payloads. */
export function summarizeObservation(url: string, pageText: string, maxLen = 400): string {
  const snippet = pageText.replace(/\s+/g, " ").trim().slice(0, maxLen);
  return `url=${url} text="${snippet}"`;
}

export const APP_ERROR_MARKERS = ["Application error", "ERR-CORE-0001"] as const;

export function isAppErrorPage(pageText: string): boolean {
  return APP_ERROR_MARKERS.some((marker) => pageText.includes(marker));
}
