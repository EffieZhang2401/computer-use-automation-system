/**
 * Promote a mechanical discovery draft into a replay-ready approved artifact.
 */
import type { CapabilityArtifact, Locator, Step } from "../core/schema.js";
import { CapabilityArtifactSchema } from "../core/schema.js";

const SEARCH_BUTTON_LOCATOR: Locator = {
  primary: {
    by: "role",
    role: "button",
    name: "Search",
    nameMatch: "exact",
  },
  fallbacks: [
    { by: "css", selector: "#ctl00\\$MainContent\\$btnSearch" },
    { by: "css", selector: "button[type=\"submit\"]" },
  ],
  verify: { role: "button", nameContains: "Search" },
};

export function prepareApprovedArtifact(draft: CapabilityArtifact): CapabilityArtifact {
  const steps = draft.steps.map((step) => enhanceStep(step));

  const approved: CapabilityArtifact = {
    ...draft,
    version: "1.0.0",
    status: "approved",
    name: "Read member savings balance",
    description:
      "Look up a member by ID and extract the displayed savings account balance.",
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
        example: "http://localhost:3100",
      },
    ],
    outputs: [
      {
        name: "savingsBalance",
        type: "string",
        description: "Displayed savings balance",
        sensitivity: "pii",
        source: { stepId: "s03", extract: "innerText" },
      },
    ],
    steps,
    successCheckpoint: {
      kind: "all",
      of: [
        { kind: "textPresent", text: "Savings" },
        { kind: "urlMatches", pattern: ".*/members/.*" },
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
    recoveries: [],
    policy: {
      ...draft.policy,
      allowedOrigins: [
        ...new Set([
          ...draft.policy.allowedOrigins,
          "http://127.0.0.1:3100",
          "http://localhost:3100",
        ]),
      ],
    },
    health: draft.health ?? {
      replays: 0,
      successes: 0,
      lastVerifiedAt: new Date().toISOString(),
      fallbackTierHistogram: {},
    },
  };

  return CapabilityArtifactSchema.parse(approved);
}

function enhanceStep(step: Step): Step {
  if (step.id === "s01") {
    return {
      ...step,
      intent: "Enter the member ID into the search box",
      value: { kind: "param", name: "memberId" },
      postcondition: {
        kind: "visible",
        locator: step.target ?? {
          primary: {
            by: "role",
            role: "textbox",
            name: "Member ID",
            nameMatch: "exact",
          },
          fallbacks: [],
        },
      },
    };
  }

  if (step.id === "s02") {
    return {
      ...step,
      intent: "Submit the member search",
      target: step.target ?? SEARCH_BUTTON_LOCATOR,
      wait: { until: "assertion", timeoutMs: 10_000, retries: 0 },
      postcondition: {
        kind: "any",
        of: [
          { kind: "textPresent", text: "Savings" },
          { kind: "textPresent", text: "Member not found" },
        ],
      },
    };
  }

  if (step.id === "s03") {
    return {
      ...step,
      intent: "Extract the savings balance from the accounts table",
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
      postcondition: {
        kind: "textPresent",
        pattern: "\\$[0-9,]+\\.\\d{2}",
      },
    };
  }

  return step;
}

export function defaultDraftPath(artifactId: string): string {
  return `artifacts/${artifactId}.draft.json`;
}
