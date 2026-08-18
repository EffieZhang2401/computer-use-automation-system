import { describe, expect, it } from "vitest";
import type { ArtifactPolicy, Step } from "../src/core/schema.js";
import { PolicyGate, classifyRisk } from "../src/policy/gate.js";

const policy: ArtifactPolicy = {
  allowedOrigins: ["http://localhost:3000"],
  allowedActions: ["navigate", "click", "fill", "extract", "waitFor", "assert"],
  maxSteps: 25,
  highestRisk: "irreversible",
};

describe("PolicyGate", () => {
  it("rejects an out-of-allowlist origin", () => {
    const gate = new PolicyGate(policy);
    const decision = gate.check({
      action: "navigate",
      url: "https://evil.example/phish",
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/origin not in allowlist/i);
  });

  it("flags an irreversible action", () => {
    const gate = new PolicyGate(policy);
    const decision = gate.check(
      {
        kind: "click",
      },
      {
        currentUrl: "http://localhost:3000/transfers",
        intent: "Post the wire transfer",
        targetName: "Confirm transfer",
      },
    );
    expect(decision.risk).toBe("irreversible");
    expect(decision.flagged).toBe(true);
  });

  it("allows a navigate to an allowlisted origin", () => {
    const gate = new PolicyGate(policy);
    const decision = gate.check({
      action: "navigate",
      url: "http://localhost:3000/members/search",
    });
    expect(decision.allowed).toBe(true);
    expect(decision.flagged).toBe(false);
    expect(decision.risk).toBe("safe");
  });

  it("blocks unapproved irreversible replay", () => {
    const gate = new PolicyGate(policy, { mode: "replay", artifactStatus: "draft" });
    const step: Step = {
      id: "s09",
      intent: "Post the wire transfer",
      action: "click",
      target: {
        primary: { by: "role", role: "button", name: "Confirm transfer", nameMatch: "exact" },
        fallbacks: [],
      },
      risk: "irreversible",
    };
    const decision = gate.check(step, { currentUrl: "http://localhost:3000/transfers" });
    expect(decision.flagged).toBe(true);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/approved artifact/i);
  });
});

describe("classifyRisk", () => {
  it("treats a member-search click as safe", () => {
    expect(
      classifyRisk({
        action: "click",
        intent: "Submit the member search",
        targetName: "Search",
      }),
    ).toBe("safe");
  });
});
