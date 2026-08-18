/**
 * Redact sensitivity-tagged values before they hit logs or on-disk artifacts.
 *
 * `public` values pass through. `pii` and `secret` are replaced by a
 * placeholder so the original never appears in the output string.
 * Partial masks (e.g. last-4) are intentionally not used — they would
 * still leak a substring of the source value.
 */
import type { Sensitivity } from "./schema.js";

const PLACEHOLDER: Record<Exclude<Sensitivity, "public">, string> = {
  pii: "[REDACTED:pii]",
  secret: "[REDACTED:secret]",
};

export type SensitivitySpec = {
  name: string;
  sensitivity: Sensitivity;
};

export type SensitiveLiteral = {
  value: string;
  sensitivity: Sensitivity;
};

/** Replace a single value according to its sensitivity. */
export function redactValue(value: unknown, sensitivity: Sensitivity): string {
  if (sensitivity === "public") {
    if (value === undefined || value === null) return "";
    return String(value);
  }
  return PLACEHOLDER[sensitivity];
}

/**
 * Shallow-redact a parameter map using input/output specs. Public fields
 * are copied as-is; non-public fields become placeholders.
 */
export function redactParams(
  record: Record<string, unknown>,
  specs: ReadonlyArray<SensitivitySpec>,
): Record<string, unknown> {
  const byName = new Map(specs.map((spec) => [spec.name, spec.sensitivity]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const sensitivity = byName.get(key);
    out[key] = sensitivity === undefined || sensitivity === "public" ? value : redactValue(value, sensitivity);
  }
  return out;
}

/**
 * Scrub known sensitive literals out of a log/artifact string, longest
 * first so a short token cannot punch a hole in a longer secret.
 */
export function redactText(text: string, literals: ReadonlyArray<SensitiveLiteral>): string {
  const replacements = literals
    .filter((item) => item.sensitivity !== "public" && item.value !== "")
    .slice()
    .sort((a, b) => b.value.length - a.value.length);

  let out = text;
  for (const item of replacements) {
    out = out.split(item.value).join(redactValue(item.value, item.sensitivity));
  }
  return out;
}

/** Serialize a payload for logs with sensitive fields already redacted. */
export function redactForLog(
  payload: Record<string, unknown>,
  specs: ReadonlyArray<SensitivitySpec>,
): string {
  return JSON.stringify(redactParams(payload, specs));
}
