import { createHash } from "node:crypto";
import type { FramePath, InteractiveNode } from "./surface.js";

/** Roles we always include when named or otherwise meaningful. */
const INTERACTIVE_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menu",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Named containers worth surfacing even when not directly interactive. */
const NAMED_CONTAINER_ROLES = new Set(["table", "grid", "tree", "list"]);

export const MAX_OBSERVATION_NODES = 50;

export type RawAxNode = {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  description?: { value?: string };
  value?: { value?: string };
  backendDOMNodeId?: number;
  childIds?: string[];
  properties?: Array<{ name?: string; value?: { value?: unknown } }>;
};

export type RawAxEntry = {
  node: RawAxNode;
  frame: FramePath;
};

function roleOf(node: RawAxNode): string {
  return (node.role?.value ?? "unknown").toLowerCase();
}

function nameOf(node: RawAxNode): string {
  return (node.name?.value ?? "").trim();
}

function intProperty(node: RawAxNode, key: string): number | undefined {
  const prop = node.properties?.find((p) => p.name === key);
  const raw = prop?.value?.value;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function shouldInclude(node: RawAxNode): boolean {
  const role = roleOf(node);
  const name = nameOf(node);
  if (INTERACTIVE_ROLES.has(role)) return true;
  if (NAMED_CONTAINER_ROLES.has(role) && name !== "") return true;
  if (role === "cell" && name !== "") return true;
  return false;
}

function detailFor(node: RawAxNode): string | undefined {
  const role = roleOf(node);
  if (role === "table" || role === "grid") {
    const rows = intProperty(node, "rowcount");
    if (rows !== undefined) return `rows=${rows}`;
  }
  return undefined;
}

export function collectObservationEntries(
  roots: RawAxNode[],
  index: Map<string, RawAxNode>,
  frame: FramePath,
  out: RawAxEntry[],
): void {
  for (const root of roots) {
    walkAxTree(root, index, frame, out);
  }
}

function walkAxTree(
  node: RawAxNode,
  index: Map<string, RawAxNode>,
  frame: FramePath,
  out: RawAxEntry[],
): void {
  if (shouldInclude(node)) {
    out.push({ node, frame });
  }
  for (const childId of node.childIds ?? []) {
    const child = index.get(childId);
    if (child !== undefined) walkAxTree(child, index, frame, out);
  }
}

/**
 * Assign refs from stable traversal order (frame path, then backendDOMNodeId).
 * Identical trees produce identical ref assignments.
 */
export function compressAxEntries(entries: RawAxEntry[]): InteractiveNode[] {
  const sorted = [...entries].sort((a, b) => {
    const frameCmp = a.frame.join("\0").localeCompare(b.frame.join("\0"));
    if (frameCmp !== 0) return frameCmp;
    const aId = a.node.backendDOMNodeId ?? Number.MAX_SAFE_INTEGER;
    const bId = b.node.backendDOMNodeId ?? Number.MAX_SAFE_INTEGER;
    return aId - bId;
  });

  const capped = sorted.slice(0, MAX_OBSERVATION_NODES);
  return capped.map((entry, idx) => {
    const role = roleOf(entry.node);
    const name = nameOf(entry.node);
    const ref = entry.node.backendDOMNodeId ?? idx + 1;
    return {
      ref,
      role,
      name,
      frame: [...entry.frame],
      detail: detailFor(entry.node),
    };
  });
}

export function formatFramePath(frame: FramePath): string {
  if (frame.length === 0) return "top";
  return frame.join(" > ");
}

export function formatObservationText(url: string, nodes: InteractiveNode[]): string {
  const lines: string[] = [`url: ${url}`, ""];
  for (const node of nodes) {
    const frameSuffix =
      node.frame.length > 0 ? ` (frame: ${formatFramePath(node.frame)})` : "";
    const namePart = node.name !== "" ? ` "${node.name}"` : "";
    const detailPart = node.detail !== undefined ? `  ${node.detail}` : "";
    lines.push(`[ref=${node.ref}] ${node.role}${namePart}${detailPart}${frameSuffix}`);
  }
  return lines.join("\n");
}

export function hashObservationText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function buildObservation(url: string, nodes: InteractiveNode[]) {
  const text = formatObservationText(url, nodes);
  return { url, nodes, text, hash: hashObservationText(text) };
}
