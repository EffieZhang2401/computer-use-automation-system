/**
 * PolicyGate — the choke point for every action in discovery and replay.
 *
 * Checks the origin/action allowlists, classifies risk
 * (safe / reversible / irreversible), and flags irreversible actions so
 * callers can require approval or escalate. Rejection is a decision object,
 * never a thrown exception — discovery feeds it back to the model as a
 * tool result.
 */
import type {
  ActionKind,
  ArtifactPolicy,
  ArtifactStatus,
  Locator,
  RiskLevel,
  Step,
} from "../core/schema.js";

const RISK_RANK: Record<RiskLevel, number> = {
  safe: 0,
  reversible: 1,
  irreversible: 2,
};

/** Money-movement / destructive phrasing → irreversible. */
const IRREVERSIBLE_RE =
  /\b(transfer|wire|delete|purge|debit|disburse|authorize payment|send money|close account|post funds|post transfer|irreversible)\b/i;

/** Persisted but undoable mutations → reversible. */
const REVERSIBLE_RE = /\b(save|update|edit|change|reset|logout|log out|toggle)\b/i;

const BASE_RISK: Record<ActionKind, RiskLevel> = {
  navigate: "safe",
  extract: "safe",
  waitFor: "safe",
  assert: "safe",
  fill: "safe",
  select: "safe",
  press: "safe",
  click: "safe",
};

export type PolicyMode = "discovery" | "replay";

/**
 * Normalized action the gate inspects. Discovery maps a tool call into this;
 * replay can pass a compiled `Step` directly to `check`.
 */
export type GatedAction = {
  action: ActionKind;
  /** Page URL or navigate target, used for the origin allowlist. */
  url?: string;
  intent?: string;
  /** Accessible name of the target (button label, field name, …). */
  targetName?: string;
  declaredRisk?: RiskLevel;
};

export type PolicyCheckContext = {
  currentUrl?: string;
  intent?: string;
  targetName?: string;
  /** 0-based index of this action in the run; compared to `policy.maxSteps`. */
  stepIndex?: number;
};

export type PolicyDecision = {
  allowed: boolean;
  risk: RiskLevel;
  /** True when the action is classified or declared irreversible. */
  flagged: boolean;
  reason?: string;
};

export type PolicyGateOptions = {
  artifactStatus?: ArtifactStatus;
  /**
   * Replay blocks unapproved irreversible actions. Discovery only flags
   * them so a transfer flow can still be recorded.
   */
  mode?: PolicyMode;
};

type KindedCall = {
  kind: ActionKind;
  url?: string;
};

export class PolicyGate {
  constructor(
    private readonly policy: ArtifactPolicy,
    private readonly options: PolicyGateOptions = {},
  ) {}

  check(
    action: GatedAction | Step | KindedCall,
    context: PolicyCheckContext = {},
  ): PolicyDecision {
    const gated = toGatedAction(action, context);
    const reasons: string[] = [];

    if (gated.url !== undefined) {
      if (!originAllowed(gated.url, this.policy.allowedOrigins)) {
        reasons.push(`origin not in allowlist: ${originOf(gated.url) ?? gated.url}`);
      }
    } else if (gated.action === "navigate") {
      reasons.push("navigate is missing a URL for the origin allowlist check");
    }

    if (!this.policy.allowedActions.includes(gated.action)) {
      reasons.push(`action not in allowlist: ${gated.action}`);
    }

    if (context.stepIndex !== undefined && context.stepIndex >= this.policy.maxSteps) {
      reasons.push(`step index ${context.stepIndex} exceeds maxSteps ${this.policy.maxSteps}`);
    }

    const classified = classifyRisk(gated);
    const risk = gated.declaredRisk !== undefined ? maxRisk(classified, gated.declaredRisk) : classified;
    const flagged = risk === "irreversible";

    if (riskExceeds(risk, this.policy.highestRisk)) {
      reasons.push(`risk ${risk} exceeds policy highestRisk ${this.policy.highestRisk}`);
    }

    const mode = this.options.mode ?? "discovery";
    const status = this.options.artifactStatus ?? "draft";
    if (flagged && mode === "replay" && status !== "approved") {
      reasons.push("irreversible action requires an approved artifact for unattended replay");
    }

    if (reasons.length > 0) {
      return { allowed: false, risk, flagged, reason: reasons[0] };
    }
    return { allowed: true, risk, flagged };
  }
}

export function classifyRisk(action: GatedAction): RiskLevel {
  const text = `${action.intent ?? ""} ${action.targetName ?? ""}`;
  if (IRREVERSIBLE_RE.test(text)) return "irreversible";
  if (REVERSIBLE_RE.test(text)) return "reversible";
  return BASE_RISK[action.action];
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

function riskExceeds(actual: RiskLevel, ceiling: RiskLevel): boolean {
  return RISK_RANK[actual] > RISK_RANK[ceiling];
}

function toGatedAction(
  action: GatedAction | Step | KindedCall,
  context: PolicyCheckContext,
): GatedAction {
  if (isStep(action)) {
    return {
      action: action.action,
      url: urlFromStep(action) ?? context.currentUrl,
      intent: context.intent ?? action.intent,
      targetName: context.targetName ?? targetNameFromLocator(action.target),
      declaredRisk: action.risk,
    };
  }
  if (isKindedCall(action)) {
    return {
      action: action.kind,
      url: action.kind === "navigate" ? action.url : context.currentUrl,
      intent: context.intent,
      targetName: context.targetName,
    };
  }
  return {
    ...action,
    url: action.url ?? context.currentUrl,
    intent: context.intent ?? action.intent,
    targetName: context.targetName ?? action.targetName,
  };
}

function isStep(value: GatedAction | Step | KindedCall): value is Step {
  return (
    "id" in value &&
    "intent" in value &&
    "action" in value &&
    "risk" in value &&
    typeof value.id === "string"
  );
}

function isKindedCall(value: GatedAction | Step | KindedCall): value is KindedCall {
  return "kind" in value && !("action" in value);
}

function urlFromStep(step: Step): string | undefined {
  if (step.action !== "navigate" || step.value === undefined) return undefined;
  if (step.value.kind === "literal" && typeof step.value.value === "string") {
    return step.value.value;
  }
  return undefined;
}

function targetNameFromLocator(locator: Locator | undefined): string | undefined {
  if (locator === undefined) return undefined;
  const primary = locator.primary;
  switch (primary.by) {
    case "role":
      return primary.name;
    case "label":
      return primary.text;
    case "textAnchor":
      return primary.anchorText;
    default:
      return undefined;
  }
}

export function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function originAllowed(url: string, allowedOrigins: string[]): boolean {
  const origin = originOf(url);
  if (origin === undefined) return false;
  return allowedOrigins.some((allowed) => {
    const allowedOrigin = originOf(allowed) ?? allowed;
    return allowedOrigin === origin;
  });
}
