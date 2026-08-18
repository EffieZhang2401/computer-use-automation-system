import { describe, expect, it } from "vitest";
import { redactForLog, redactParams, redactText, redactValue } from "../src/core/redactor.js";

describe("redactor", () => {
  it("a redacted sensitive value never appears in the output string", () => {
    const ssn = "078-05-1120";
    const output = redactValue(ssn, "pii");
    expect(output).not.toContain(ssn);
    expect(output).toBe("[REDACTED:pii]");

    const secret = "teller-password-9f3c";
    const secretOut = redactValue(secret, "secret");
    expect(secretOut).not.toContain(secret);
    expect(secretOut).toBe("[REDACTED:secret]");

    const memberId = "M-42-9999";
    const log = redactForLog(
      { memberId, baseUrl: "http://localhost:3000" },
      [
        { name: "memberId", sensitivity: "pii" },
        { name: "baseUrl", sensitivity: "public" },
      ],
    );
    expect(log).not.toContain(memberId);
    expect(log).toContain("http://localhost:3000");
  });

  it("leaves public values unchanged", () => {
    expect(redactValue("http://localhost:3000", "public")).toBe("http://localhost:3000");
  });

  it("scrubs sensitive literals from log text", () => {
    const memberId = "M-42-9999";
    const line = redactText(`lookup member ${memberId}`, [
      { value: memberId, sensitivity: "pii" },
    ]);
    expect(line).not.toContain(memberId);
    expect(line).toBe("lookup member [REDACTED:pii]");
  });

  it("does not redact public params", () => {
    const params = redactParams(
      { baseUrl: "http://localhost:3000", memberId: "M-1" },
      [
        { name: "baseUrl", sensitivity: "public" },
        { name: "memberId", sensitivity: "pii" },
      ],
    );
    expect(params.baseUrl).toBe("http://localhost:3000");
    expect(String(params.memberId)).not.toContain("M-1");
  });
});
