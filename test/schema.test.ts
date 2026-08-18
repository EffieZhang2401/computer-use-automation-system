import { describe, expect, it } from "vitest";
import {
  CapabilityArtifactSchema,
  LocatorSchema,
  ParamSpecSchema,
  ReplayResultSchema,
  type CapabilityArtifact,
  type Locator,
} from "../src/core/schema";

const memberIdLocator: Locator = {
  frame: ["content"],
  primary: {
    by: "role",
    role: "textbox",
    name: "Member ID",
    nameMatch: "exact",
  },
  fallbacks: [
    { by: "label", text: "Member ID" },
    {
      by: "textAnchor",
      anchorText: "Member ID",
      direction: "right",
      nth: 0,
    },
    { by: "css", selector: "[name='memberId']" },
    { by: "domPath", path: "html/body/form/input[1]" },
    { by: "coordinates", x: 240, y: 160, relativeTo: "viewport" },
  ],
  verify: {
    role: "textbox",
    nameContains: "Member",
    textMatches: "Member ID",
  },
};

const validArtifact: CapabilityArtifact = {
  schemaVersion: "1.0",
  id: "member.read_savings_balance",
  version: "1.2.0",
  status: "draft",
  name: "Read member savings balance",
  description:
    "Look up a member by ID and extract the displayed savings account balance.",
  target: {
    appId: "corebank-lite",
    appVersionRange: ">=2.1 <3.0",
    entryPoint: "{{baseUrl}}/members/search",
  },
  surface: {
    kind: "web",
    capabilities: ["iframe"],
  },
  inputs: [
    {
      name: "memberId",
      type: "string",
      required: true,
      description: "Member identifier",
      sensitivity: "pii",
    },
    {
      name: "baseUrl",
      type: "string",
      required: true,
      description: "Tenant base URL",
      sensitivity: "public",
      example: "http://localhost:3000",
    },
  ],
  outputs: [
    {
      name: "savingsBalance",
      type: "string",
      description: "Displayed savings balance",
      sensitivity: "pii",
      source: { stepId: "s04", extract: "innerText" },
    },
  ],
  steps: [
    {
      id: "s01",
      intent: "Open the member search page",
      action: "navigate",
      value: { kind: "param", name: "baseUrl" },
      risk: "safe",
    },
    {
      id: "s02",
      intent: "Enter the member ID into the search box",
      action: "fill",
      target: memberIdLocator,
      value: { kind: "param", name: "memberId" },
      postcondition: {
        kind: "visible",
        locator: {
          primary: {
            by: "role",
            role: "button",
            name: "Search",
            nameMatch: "exact",
          },
          fallbacks: [],
        },
      },
      risk: "safe",
    },
    {
      id: "s03",
      intent: "Submit the member search",
      action: "click",
      target: {
        primary: {
          by: "role",
          role: "button",
          name: "Search",
          nameMatch: "exact",
        },
        fallbacks: [{ by: "label", text: "Search" }],
      },
      wait: { until: "assertion", timeoutMs: 5000, retries: 1 },
      postcondition: {
        kind: "any",
        of: [
          { kind: "textPresent", text: "Savings" },
          { kind: "textPresent", text: "Member not found" },
        ],
      },
      risk: "safe",
    },
    {
      id: "s04",
      intent: "Extract the savings balance",
      action: "extract",
      target: {
        primary: {
          by: "textAnchor",
          anchorText: "Savings",
          direction: "right",
          nth: 0,
        },
        fallbacks: [],
        verify: { textMatches: "\\$[0-9,]+\\.\\d{2}" },
      },
      extractAs: "savingsBalance",
      risk: "safe",
    },
  ],
  successCheckpoint: {
    kind: "all",
    of: [
      { kind: "textPresent", text: "Savings" },
      { kind: "urlMatches", pattern: "/members/" },
    ],
  },
  outcomes: [
    {
      code: "MEMBER_NOT_FOUND",
      detect: { kind: "textPresent", text: "Member not found" },
      terminal: true,
      message: "No member exists for the given identifier",
      mapsTo: "business_outcome",
    },
  ],
  recoveries: [
    {
      id: "dismiss-system-notice",
      detect: { kind: "textPresent", text: "System notice" },
      action: {
        kind: "click",
        target: {
          primary: {
            by: "role",
            role: "button",
            name: "Dismiss",
            nameMatch: "exact",
          },
          fallbacks: [],
        },
      },
      maxAttempts: 2,
    },
  ],
  policy: {
    allowedOrigins: ["http://localhost:3000"],
    allowedActions: ["navigate", "click", "fill", "extract", "waitFor", "assert"],
    maxSteps: 25,
    highestRisk: "safe",
  },
  provenance: {
    discoveryRunId: "run_001",
    model: "claude-haiku-4-5-20251001",
    promptVersion: "1",
    recordedAt: "2026-08-17T20:00:00.000Z",
    recordedBy: "discovery-agent",
  },
};

describe("CapabilityArtifactSchema", () => {
  it("accepts a valid artifact", () => {
    const result = CapabilityArtifactSchema.safeParse(validArtifact);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.id).toBe("member.read_savings_balance");
      expect(result.data.steps).toHaveLength(4);
    }
  });

  it("rejects an artifact missing a required field", () => {
    const { successCheckpoint: _, ...missingCheckpoint } = validArtifact;
    const result = CapabilityArtifactSchema.safeParse(missingCheckpoint);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes("successCheckpoint"))).toBe(
        true,
      );
    }
  });

  it("rejects a PII param that carries a literal example", () => {
    const result = ParamSpecSchema.safeParse({
      name: "memberId",
      type: "string",
      required: true,
      description: "Member identifier",
      sensitivity: "pii",
      example: "123456",
    });
    expect(result.success).toBe(false);
  });
});

describe("LocatorSchema", () => {
  it("round-trips a fallback ladder through JSON serialize/deserialize", () => {
    const parsed = LocatorSchema.parse(memberIdLocator);
    expect(parsed.primary.by).toBe("role");
    expect(parsed.fallbacks.map((s) => s.by)).toEqual([
      "label",
      "textAnchor",
      "css",
      "domPath",
      "coordinates",
    ]);

    const json = JSON.stringify(parsed);
    const roundTripped = LocatorSchema.parse(JSON.parse(json) as unknown);
    expect(roundTripped).toEqual(parsed);
    expect(JSON.stringify(roundTripped)).toBe(json);
  });
});

describe("ReplayResultSchema", () => {
  it("accepts a business_outcome result and rejects a failed result without failure", () => {
    const business = ReplayResultSchema.safeParse({
      status: "business_outcome",
      runId: "r1",
      artifactId: "member.read_savings_balance",
      artifactVersion: "1.2.0",
      durationMs: 1200,
      evidenceDir: "evidence/r1",
      outcome: { code: "MEMBER_NOT_FOUND", message: "No member exists" },
      steps: [{ stepId: "s03", durationMs: 400, resolvedTier: 0, retries: 0 }],
      driftSignals: [],
    });
    expect(business.success).toBe(true);

    const failedWithoutDetail = ReplayResultSchema.safeParse({
      status: "failed",
      runId: "r2",
      artifactId: "member.read_savings_balance",
      artifactVersion: "1.2.0",
      durationMs: 800,
      evidenceDir: "evidence/r2",
      steps: [],
      driftSignals: [],
    });
    expect(failedWithoutDetail.success).toBe(false);
  });
});
