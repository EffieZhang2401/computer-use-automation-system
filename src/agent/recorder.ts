/**
 * Append-only discovery recording — locators come only from real elements
 * at the moment each action executes (invariant #2).
 */
import type { Locator } from "../core/schema.js";
import type { AgentToolCall } from "./tools.js";
import type { RecordedAction } from "./types.js";

export class Recorder {
  private readonly entries: RecordedAction[] = [];

  push(entry: RecordedAction): void {
    this.entries.push(entry);
  }

  all(): readonly RecordedAction[] {
    return this.entries;
  }

  last(): RecordedAction | undefined {
    return this.entries[this.entries.length - 1];
  }
}

export type LocatorCaptureSurface = {
  captureLocator(ref: number): Promise<Locator | null>;
};

/** Tools that act on a DOM ref and need locator capture. */
export function refForToolCall(call: AgentToolCall): number | undefined {
  switch (call.tool) {
    case "click":
    case "fill":
    case "select":
    case "extract":
      return call.ref;
    case "wait_for":
      return call.ref;
    default:
      return undefined;
  }
}

export async function captureLocatorForCall(
  surface: LocatorCaptureSurface,
  call: AgentToolCall,
): Promise<Locator | undefined> {
  const ref = refForToolCall(call);
  if (ref === undefined) return undefined;
  const locator = await surface.captureLocator(ref);
  return locator ?? undefined;
}
