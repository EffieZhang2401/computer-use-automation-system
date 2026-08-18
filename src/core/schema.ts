/**
 * Capability artifact schema — the serializable contract between discovery
 * (record once) and replay (execute with no model in the loop).
 *
 * Locators are captured from the real accessibility tree at action time.
 * This module describes their shape only; it contains no resolution logic.
 *
 * Patterns are strings (regex source), never RegExp objects — artifacts
 * must round-trip through JSON.
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1.0" as const;

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const ArtifactStatusSchema = z.enum(["draft", "approved", "deprecated"]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const SurfaceKindSchema = z.enum(["web", "legacy-web", "desktop"]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const ActionKindSchema = z.enum([
  "navigate",
  "click",
  "fill",
  "select",
  "press",
  "extract",
  "waitFor",
  "assert",
]);
export type ActionKind = z.infer<typeof ActionKindSchema>;

export const RiskLevelSchema = z.enum(["safe", "reversible", "irreversible"]);
export type RiskLevel = z.infer<typeof RiskLevelSchema>;

export const SensitivitySchema = z.enum(["public", "pii", "secret"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

export const ParamTypeSchema = z.enum(["string", "number", "boolean", "enum"]);
export type ParamType = z.infer<typeof ParamTypeSchema>;

export const NameMatchSchema = z.enum(["exact", "contains"]);
export type NameMatch = z.infer<typeof NameMatchSchema>;

// ---------------------------------------------------------------------------
// Strategy + Locator
//
// `role + name` is ranked first because it is the concept shared by the
// Chromium accessibility tree, Windows UIA, and macOS AX — so a step can
// survive a Surface swap without rewriting locators.
//
// After a candidate handle is resolved, `verify` re-checks role/text. A
// failed verify is unresolved (try the next tier), never a silent mismatch.
// ---------------------------------------------------------------------------

export const StrategySchema = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("role"),
      role: z.string().min(1),
      name: z.string().min(1),
      nameMatch: NameMatchSchema,
    })
    .strict(),
  z
    .object({
      by: z.literal("label"),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      by: z.literal("textAnchor"),
      anchorText: z.string().min(1),
      direction: z.enum(["right", "below"]),
      nth: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      by: z.literal("css"),
      selector: z.string().min(1),
    })
    .strict(),
  z
    .object({
      by: z.literal("domPath"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      by: z.literal("coordinates"),
      x: z.number(),
      y: z.number(),
      relativeTo: z.enum(["viewport", "anchor"]),
    })
    .strict(),
]);
export type Strategy = z.infer<typeof StrategySchema>;

export const LocatorVerifySchema = z
  .object({
    role: z.string().min(1).optional(),
    nameContains: z.string().min(1).optional(),
    /** Regex source string — JSON-serializable. */
    textMatches: z.string().min(1).optional(),
  })
  .strict();
export type LocatorVerify = z.infer<typeof LocatorVerifySchema>;

export const LocatorSchema = z
  .object({
    /** iframe / frameset path; required for nested legacy layouts. */
    frame: z.array(z.string().min(1)).optional(),
    primary: StrategySchema,
    /** Ordered fallback ladder tried after `primary`. */
    fallbacks: z.array(StrategySchema),
    verify: LocatorVerifySchema.optional(),
  })
  .strict();
export type Locator = z.infer<typeof LocatorSchema>;

// ---------------------------------------------------------------------------
// Assertion (recursive — `all` / `any`)
// ---------------------------------------------------------------------------

export type Assertion =
  | { kind: "visible"; locator: Locator }
  | { kind: "textPresent"; text: string; scope?: Locator }
  | { kind: "textPresent"; pattern: string; scope?: Locator }
  | { kind: "textAbsent"; text: string }
  | { kind: "textAbsent"; pattern: string }
  | { kind: "urlMatches"; pattern: string }
  | { kind: "all"; of: Assertion[] }
  | { kind: "any"; of: Assertion[] };

const TextPresentSchema = z.union([
  z
    .object({
      kind: z.literal("textPresent"),
      text: z.string().min(1),
      scope: LocatorSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("textPresent"),
      pattern: z.string().min(1),
      scope: LocatorSchema.optional(),
    })
    .strict(),
]);

const TextAbsentSchema = z.union([
  z
    .object({
      kind: z.literal("textAbsent"),
      text: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("textAbsent"),
      pattern: z.string().min(1),
    })
    .strict(),
]);

export const AssertionSchema: z.ZodType<Assertion> = z.lazy(() =>
  z.union([
    z
      .object({
        kind: z.literal("visible"),
        locator: LocatorSchema,
      })
      .strict(),
    TextPresentSchema,
    TextAbsentSchema,
    z
      .object({
        kind: z.literal("urlMatches"),
        pattern: z.string().min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("all"),
        of: z.array(AssertionSchema).min(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal("any"),
        of: z.array(AssertionSchema).min(1),
      })
      .strict(),
  ]),
);

// ---------------------------------------------------------------------------
// Inputs / outputs
//
// `sensitivity != "public"` values are stored only as parameter references
// (`{ kind: "param", name }`), never as literals. `example` is allowed only
// on public fields.
// ---------------------------------------------------------------------------

export const ParamSpecSchema = z
  .object({
    name: z.string().min(1),
    type: ParamTypeSchema,
    enum: z.array(z.string().min(1)).min(1).optional(),
    required: z.boolean(),
    description: z.string().min(1),
    sensitivity: SensitivitySchema,
    example: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.example !== undefined && val.sensitivity !== "public") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`example` is allowed only when sensitivity is `public`",
        path: ["example"],
      });
    }
    if (val.type === "enum" && (val.enum === undefined || val.enum.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`enum` values are required when type is `enum`",
        path: ["enum"],
      });
    }
    if (val.type !== "enum" && val.enum !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`enum` is only valid when type is `enum`",
        path: ["enum"],
      });
    }
  });
export type ParamSpec = z.infer<typeof ParamSpecSchema>;

export const OutputSpecSchema = z
  .object({
    name: z.string().min(1),
    type: ParamTypeSchema,
    description: z.string().min(1),
    sensitivity: SensitivitySchema,
    source: z
      .object({
        stepId: z.string().min(1),
        /** How to read the value from the element resolved at `stepId`. */
        extract: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

// ---------------------------------------------------------------------------
// Step
// ---------------------------------------------------------------------------

export const StepValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("literal"),
      value: z.union([z.string(), z.number(), z.boolean()]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("param"),
      name: z.string().min(1),
    })
    .strict(),
]);
export type StepValue = z.infer<typeof StepValueSchema>;

export const StepWaitSchema = z
  .object({
    until: z.enum(["networkIdle", "assertion"]),
    timeoutMs: z.number().int().positive(),
    retries: z.number().int().nonnegative(),
  })
  .strict();
export type StepWait = z.infer<typeof StepWaitSchema>;

export const StepSchema = z
  .object({
    id: z.string().min(1),
    /** Human-readable intent, for review — not used as a locator. */
    intent: z.string().min(1),
    action: ActionKindSchema,
    target: LocatorSchema.optional(),
    value: StepValueSchema.optional(),
    extractAs: z.string().min(1).optional(),
    precondition: AssertionSchema.optional(),
    /** Never assume a click worked; replay checks this after acting. */
    postcondition: AssertionSchema.optional(),
    wait: StepWaitSchema.optional(),
    risk: RiskLevelSchema,
  })
  .strict();
export type Step = z.infer<typeof StepSchema>;

// ---------------------------------------------------------------------------
// Outcome / recovery (declarative — no model needed at replay time)
// ---------------------------------------------------------------------------

export const OutcomeRuleSchema = z
  .object({
    code: z.string().min(1),
    detect: AssertionSchema,
    terminal: z.boolean(),
    message: z.string().min(1),
    mapsTo: z.literal("business_outcome"),
  })
  .strict();
export type OutcomeRule = z.infer<typeof OutcomeRuleSchema>;

export const RecoveryActionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("click"),
      target: LocatorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("wait"),
      timeoutMs: z.number().int().positive(),
    })
    .strict(),
  z.object({ kind: z.literal("reauth") }).strict(),
  z.object({ kind: z.literal("reload") }).strict(),
]);
export type RecoveryAction = z.infer<typeof RecoveryActionSchema>;

export const RecoveryRuleSchema = z
  .object({
    id: z.string().min(1),
    detect: AssertionSchema,
    action: RecoveryActionSchema,
    maxAttempts: z.number().int().positive(),
  })
  .strict();
export type RecoveryRule = z.infer<typeof RecoveryRuleSchema>;

// ---------------------------------------------------------------------------
// CapabilityArtifact
// ---------------------------------------------------------------------------

export const ArtifactTargetSchema = z
  .object({
    /** Vendor-product identity; the key for cross-tenant reuse. */
    appId: z.string().min(1),
    appVersionRange: z.string().min(1).optional(),
    /** Absent = base (vendor-wide) artifact. */
    tenantId: z.string().min(1).optional(),
    /** Templated, never a hardcoded host. */
    entryPoint: z.string().min(1),
  })
  .strict();
export type ArtifactTarget = z.infer<typeof ArtifactTargetSchema>;

export const ArtifactSurfaceSchema = z
  .object({
    kind: SurfaceKindSchema,
    /** Surface-specific feature flags (e.g. "iframe", "frameset"). */
    capabilities: z.array(z.string().min(1)),
  })
  .strict();
export type ArtifactSurface = z.infer<typeof ArtifactSurfaceSchema>;

export const ArtifactPolicySchema = z
  .object({
    allowedOrigins: z.array(z.string().min(1)),
    allowedActions: z.array(ActionKindSchema),
    maxSteps: z.number().int().positive(),
    highestRisk: RiskLevelSchema,
  })
  .strict();
export type ArtifactPolicy = z.infer<typeof ArtifactPolicySchema>;

export const ArtifactProvenanceSchema = z
  .object({
    discoveryRunId: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    recordedAt: z.string().datetime(),
    recordedBy: z.string().min(1),
  })
  .strict();
export type ArtifactProvenance = z.infer<typeof ArtifactProvenanceSchema>;

export const ArtifactHealthSchema = z
  .object({
    replays: z.number().int().nonnegative(),
    successes: z.number().int().nonnegative(),
    lastVerifiedAt: z.string().datetime(),
    /**
     * Counts of which locator tier succeeded, keyed by `"0"` (primary) or
     * `"1"`… (fallback index). A rising non-primary rate is the UI-drift signal.
     */
    fallbackTierHistogram: z.record(z.string(), z.number().int().nonnegative()),
  })
  .strict();
export type ArtifactHealth = z.infer<typeof ArtifactHealthSchema>;

export const CapabilityArtifactSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    /** Stable name, callable by an agent (e.g. `member.read_savings_balance`). */
    id: z.string().min(1),
    /** Semver of this capability. */
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: ArtifactStatusSchema,
    name: z.string().min(1),
    description: z.string().min(1),
    target: ArtifactTargetSchema,
    surface: ArtifactSurfaceSchema,
    inputs: z.array(ParamSpecSchema),
    outputs: z.array(OutputSpecSchema),
    steps: z.array(StepSchema),
    successCheckpoint: AssertionSchema,
    outcomes: z.array(OutcomeRuleSchema),
    recoveries: z.array(RecoveryRuleSchema),
    policy: ArtifactPolicySchema,
    provenance: ArtifactProvenanceSchema,
    health: ArtifactHealthSchema.optional(),
  })
  .strict();
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

// ---------------------------------------------------------------------------
// ReplayResult
//
// Terminal statuses only. `recoverable` is handled internally and retried;
// it never appears here. A business outcome (e.g. "member not found") is a
// successful end of the capability, not a failure.
// ---------------------------------------------------------------------------

export const ReplayStatusSchema = z.enum([
  "success",
  "business_outcome",
  "escalated",
  "failed",
]);
export type ReplayStatus = z.infer<typeof ReplayStatusSchema>;

export const FailureKindSchema = z.enum([
  "locator_unresolved",
  "checkpoint_failed",
  "policy_violation",
  "timeout",
  "app_error",
]);
export type FailureKind = z.infer<typeof FailureKindSchema>;

export const ReplayFailureSchema = z
  .object({
    stepId: z.string().min(1),
    stepIntent: z.string().min(1),
    kind: FailureKindSchema,
    expected: z.string(),
    observed: z.string(),
    resolvedTier: z.number().int().nonnegative().optional(),
    evidence: z
      .object({
        screenshot: z.string().min(1),
        a11ySnapshot: z.string().min(1),
        url: z.string().min(1),
      })
      .strict(),
  })
  .strict();
export type ReplayFailure = z.infer<typeof ReplayFailureSchema>;

export const StepResultSchema = z
  .object({
    stepId: z.string().min(1),
    durationMs: z.number().nonnegative(),
    /** 0 = primary, 1 = first fallback, …; absent for locator-less steps. */
    resolvedTier: z.number().int().nonnegative().optional(),
    retries: z.number().int().nonnegative(),
  })
  .strict();
export type StepResult = z.infer<typeof StepResultSchema>;

export const DriftSignalSchema = z
  .object({
    stepId: z.string().min(1),
    primaryFailed: z.boolean(),
    hitTier: z.number().int().nonnegative(),
  })
  .strict();
export type DriftSignal = z.infer<typeof DriftSignalSchema>;

export const ReplayResultSchema = z
  .object({
    status: ReplayStatusSchema,
    runId: z.string().min(1),
    artifactId: z.string().min(1),
    artifactVersion: z.string().min(1),
    durationMs: z.number().nonnegative(),
    evidenceDir: z.string().min(1),
    outputs: z.record(z.string(), z.unknown()).optional(),
    outcome: z
      .object({
        code: z.string().min(1),
        message: z.string().min(1),
      })
      .strict()
      .optional(),
    failure: ReplayFailureSchema.optional(),
    steps: z.array(StepResultSchema),
    driftSignals: z.array(DriftSignalSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.status === "success" && val.outputs === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`outputs` is required when status is `success`",
        path: ["outputs"],
      });
    }
    if (val.status === "business_outcome" && val.outcome === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`outcome` is required when status is `business_outcome`",
        path: ["outcome"],
      });
    }
    if (val.status === "failed" && val.failure === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "`failure` is required when status is `failed`",
        path: ["failure"],
      });
    }
  });
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
