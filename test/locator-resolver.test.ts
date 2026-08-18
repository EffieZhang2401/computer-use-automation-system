import { describe, expect, it } from "vitest";
import type { Locator, Strategy } from "../src/core/schema.js";
import {
  passesVerify,
  resolveLocator,
  type LocatorResolveBackend,
  type VerifyFields,
} from "../src/surface/locator-resolver.js";

type MockElement = {
  id: string;
  role: string;
  name: string;
  text: string;
  frame: string[];
  label?: string;
  css?: string;
};

function mockBackend(elements: MockElement[]): LocatorResolveBackend<MockElement> {
  return {
    async resolveStrategy(strategy: Strategy, locatorFrame?: string[]): Promise<MockElement | null> {
      const scope = locatorFrame ?? [];
      const pool = elements.filter((el) => frameMatch(el.frame, scope));

      switch (strategy.by) {
        case "role": {
          return (
            pool.find((el) => {
              if (el.role !== strategy.role.toLowerCase()) return false;
              const name = el.name.toLowerCase();
              const target = strategy.name.toLowerCase();
              return strategy.nameMatch === "exact" ? name === target : name.includes(target);
            }) ?? null
          );
        }
        case "label":
          return pool.find((el) => el.label === strategy.text || el.name === strategy.text) ?? null;
        case "css":
          return pool.find((el) => el.css === strategy.selector) ?? null;
        case "textAnchor":
        case "domPath":
        case "coordinates":
          return null;
        default: {
          const _exhaustive: never = strategy;
          return _exhaustive;
        }
      }
    },

    async readVerifyFields(candidate: MockElement): Promise<VerifyFields> {
      return {
        role: candidate.role,
        name: candidate.name,
        text: candidate.text,
      };
    },
  };
}

function frameMatch(elementFrame: string[], locatorFrame: string[]): boolean {
  if (locatorFrame.length === 0) return elementFrame.length === 0;
  if (elementFrame.length !== locatorFrame.length) return false;
  return elementFrame.every((v, i) => v === locatorFrame[i]);
}

describe("locator-resolver", () => {
  it("resolves via primary when verify passes", async () => {
    const locator: Locator = {
      primary: {
        by: "role",
        role: "textbox",
        name: "Member ID",
        nameMatch: "exact",
      },
      fallbacks: [{ by: "label", text: "Member ID" }],
      verify: { role: "textbox", nameContains: "Member" },
    };

    const backend = mockBackend([
      {
        id: "member-id",
        role: "textbox",
        name: "Member ID",
        text: "Member ID",
        frame: [],
      },
    ]);

    const result = await resolveLocator(locator, backend);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.tier).toBe(0);
      expect(result.candidate.id).toBe("member-id");
    }
  });

  it("falls back when primary does not match any element", async () => {
    const locator: Locator = {
      primary: {
        by: "role",
        role: "textbox",
        name: "Account Number",
        nameMatch: "exact",
      },
      fallbacks: [{ by: "label", text: "Member ID" }],
    };

    const backend = mockBackend([
      {
        id: "member-id",
        role: "textbox",
        name: "Member ID",
        text: "",
        frame: [],
        label: "Member ID",
      },
    ]);

    const result = await resolveLocator(locator, backend);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.tier).toBe(1);
    }
  });

  it("rejects a candidate that fails verify and tries the next tier", async () => {
    const locator: Locator = {
      primary: {
        by: "role",
        role: "textbox",
        name: "ID",
        nameMatch: "contains",
      },
      fallbacks: [{ by: "label", text: "Member ID" }],
      verify: { role: "textbox", nameContains: "Member" },
    };

    const backend = mockBackend([
      {
        id: "wrong",
        role: "textbox",
        name: "User ID",
        text: "User ID",
        frame: [],
      },
      {
        id: "right",
        role: "textbox",
        name: "Member ID",
        text: "Member ID",
        frame: [],
        label: "Member ID",
      },
    ]);

    const result = await resolveLocator(locator, backend);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.tier).toBe(1);
      expect(result.candidate.id).toBe("right");
    }
  });

  it("returns unresolved when every tier fails or fails verify", async () => {
    const locator: Locator = {
      primary: {
        by: "role",
        role: "button",
        name: "Search",
        nameMatch: "exact",
      },
      fallbacks: [{ by: "css", selector: "#missing" }],
      verify: { role: "button", nameContains: "Search" },
    };

    const backend = mockBackend([
      {
        id: "wrong-button",
        role: "button",
        name: "Cancel",
        text: "Cancel",
        frame: [],
      },
    ]);

    const result = await resolveLocator(locator, backend);
    expect(result.status).toBe("unresolved");
    if (result.status === "unresolved") {
      expect(result.attemptedTiers).toBe(2);
    }
  });

  it("respects iframe frame paths", async () => {
    const locator: Locator = {
      frame: ["content"],
      primary: {
        by: "role",
        role: "textbox",
        name: "Member ID",
        nameMatch: "exact",
      },
      fallbacks: [],
    };

    const backend = mockBackend([
      {
        id: "top-level",
        role: "textbox",
        name: "Member ID",
        text: "",
        frame: [],
      },
      {
        id: "in-frame",
        role: "textbox",
        name: "Member ID",
        text: "",
        frame: ["content"],
      },
    ]);

    const result = await resolveLocator(locator, backend);
    expect(result.status).toBe("resolved");
    if (result.status === "resolved") {
      expect(result.candidate.id).toBe("in-frame");
    }
  });

  it("passesVerify enforces role, nameContains, and textMatches", () => {
    expect(
      passesVerify(
        { role: "textbox", name: "Member ID", text: "Member ID" },
        { role: "textbox", nameContains: "Member", textMatches: "Member ID" },
      ),
    ).toBe(true);
    expect(
      passesVerify(
        { role: "textbox", name: "User ID", text: "User ID" },
        { nameContains: "Member" },
      ),
    ).toBe(false);
  });
});
