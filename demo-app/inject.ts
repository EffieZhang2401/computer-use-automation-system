import { SLOW_DELAY_DEFAULT_MS } from "./seed";

export const INJECT_MODES = [
  "not_found",
  "validation",
  "permission_denied",
  "interstitial",
  "slow",
  "session_expired",
  "app_error",
  "locator_drift",
] as const;

export type InjectMode = (typeof INJECT_MODES)[number];

export function isInjectMode(value: string): value is InjectMode {
  return (INJECT_MODES as readonly string[]).includes(value);
}

export type PendingInject = {
  mode: InjectMode;
  once: boolean;
};

let pending: PendingInject | null = null;

export function setInject(mode: InjectMode, once: boolean): void {
  pending = { mode, once };
}

export function clearInject(): void {
  pending = null;
}

export function getInject(): PendingInject | null {
  return pending;
}

/**
 * Consume the pending inject if it is one of `applicable`.
 * `once=true` clears after a single successful take.
 */
export function takeInject(...applicable: InjectMode[]): InjectMode | null {
  if (!pending) return null;
  if (!applicable.includes(pending.mode)) return null;
  const { mode, once } = pending;
  if (once) pending = null;
  return mode;
}

export function clearIf(mode: InjectMode): void {
  if (pending?.mode === mode) pending = null;
}

export function slowDelayMs(): number {
  const raw = process.env.DEMO_SLOW_MS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return SLOW_DELAY_DEFAULT_MS;
}
