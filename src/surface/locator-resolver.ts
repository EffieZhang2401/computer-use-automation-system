import type { Locator, LocatorVerify, Strategy } from "../core/schema.js";

export type VerifyFields = {
  role?: string;
  name?: string;
  text?: string;
};

export type LocatorResolveBackend<T> = {
  resolveStrategy(strategy: Strategy, frame?: string[]): Promise<T | null>;
  readVerifyFields(candidate: T): Promise<VerifyFields>;
};

export type LocatorResolution<T> =
  | { status: "resolved"; tier: number; candidate: T }
  | { status: "unresolved"; attemptedTiers: number };

export function passesVerify(fields: VerifyFields, verify: LocatorVerify): boolean {
  if (verify.role !== undefined) {
    const actual = (fields.role ?? "").toLowerCase();
    const expected = verify.role.toLowerCase();
    if (actual !== expected) return false;
  }
  if (verify.nameContains !== undefined) {
    const haystack = (fields.name ?? fields.text ?? "").toLowerCase();
    if (!haystack.includes(verify.nameContains.toLowerCase())) return false;
  }
  if (verify.textMatches !== undefined) {
    const haystack = fields.text ?? fields.name ?? "";
    let pattern: RegExp;
    try {
      pattern = new RegExp(verify.textMatches);
    } catch {
      return false;
    }
    if (!pattern.test(haystack)) return false;
  }
  return true;
}

export function strategiesForLocator(locator: Locator): Strategy[] {
  return [locator.primary, ...locator.fallbacks];
}

/**
 * Try primary, then each fallback in order. After resolving a candidate,
 * run verify — a failed verify counts as unresolved and moves to the next tier.
 */
export async function resolveLocator<T>(
  locator: Locator,
  backend: LocatorResolveBackend<T>,
): Promise<LocatorResolution<T>> {
  const strategies = strategiesForLocator(locator);
  for (let tier = 0; tier < strategies.length; tier++) {
    const strategy = strategies[tier];
    if (strategy === undefined) continue;

    const candidate = await backend.resolveStrategy(strategy, locator.frame);
    if (candidate === null) continue;

    if (locator.verify !== undefined) {
      const fields = await backend.readVerifyFields(candidate);
      if (!passesVerify(fields, locator.verify)) continue;
    }

    return { status: "resolved", tier, candidate };
  }

  return { status: "unresolved", attemptedTiers: strategies.length };
}
