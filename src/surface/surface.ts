/**
 * Surface abstraction — the seam between UI perception/action and recorded flows.
 * Implementations must not leak Playwright or other driver types through this file.
 */

export type FramePath = string[];

export type InteractiveNode = {
  /** Stable per observation; identical page states yield identical refs. */
  ref: number;
  role: string;
  name: string;
  frame: FramePath;
  /** Optional detail, e.g. `rows=3` for tables. */
  detail?: string;
};

export type Observation = {
  url: string;
  nodes: InteractiveNode[];
  /** Compressed, model-readable snapshot text. */
  text: string;
  /** Stable hash of `text` for cassette cache keys. */
  hash: string;
};

export type ActionCall =
  | { kind: "navigate"; url: string }
  | { kind: "click"; ref: number }
  | { kind: "fill"; ref: number; text: string }
  | { kind: "select"; ref: number; value: string }
  | { kind: "press"; key: string };

export type ActionResult = {
  ok: boolean;
  error?: string;
};

export interface Surface {
  observe(): Promise<Observation>;
  act(call: ActionCall): Promise<ActionResult>;
  screenshot(): Promise<Buffer>;
}
