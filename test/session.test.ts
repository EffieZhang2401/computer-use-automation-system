import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ControlTransfer,
  IllegalTransitionError,
  ownerFromState,
} from "../src/session/control.js";
import { listSessions, SessionManager } from "../src/session/manager.js";

afterEach(async () => {
  for (const s of listSessions()) {
    await s.close();
  }
});

describe("ControlTransfer state machine", () => {
  it("starts in AUTOMATION with controlOwner automation", () => {
    const control = new ControlTransfer();
    expect(control.state).toBe("AUTOMATION");
    expect(control.controlOwner).toBe("automation");
    expect(ownerFromState("AUTOMATION")).toBe("automation");
  });

  it("allows the legal path AUTOMATION → PAUSED → HUMAN → AUTOMATION", () => {
    const control = new ControlTransfer();
    control.requestPause();
    expect(control.state).toBe("PAUSED_AWAITING_HUMAN");
    expect(control.controlOwner).toBe("automation");

    control.takeControl();
    expect(control.state).toBe("HUMAN");
    expect(control.controlOwner).toBe("human");

    control.handBack();
    expect(control.state).toBe("AUTOMATION");
    expect(control.controlOwner).toBe("automation");
  });

  it("allows abort from PAUSED and HUMAN back to AUTOMATION", () => {
    const paused = new ControlTransfer();
    paused.requestPause();
    paused.abort();
    expect(paused.state).toBe("AUTOMATION");

    const human = new ControlTransfer();
    human.requestPause();
    human.takeControl();
    human.abort();
    expect(human.state).toBe("AUTOMATION");
  });

  it("rejects illegal transitions", () => {
    const control = new ControlTransfer();

    expect(() => control.takeControl()).toThrow(IllegalTransitionError);
    expect(() => control.handBack()).toThrow(IllegalTransitionError);
    expect(() => control.abort()).toThrow(IllegalTransitionError);

    control.requestPause();
    expect(() => control.requestPause()).toThrow(IllegalTransitionError);
    expect(() => control.handBack()).toThrow(IllegalTransitionError);

    control.takeControl();
    expect(() => control.takeControl()).toThrow(IllegalTransitionError);
    expect(() => control.requestPause()).toThrow(IllegalTransitionError);
  });

  it("records transition history", () => {
    const control = new ControlTransfer();
    control.requestPause();
    control.takeControl();
    control.handBack();
    expect(control.history.map((h) => h.action)).toEqual([
      "requestPause",
      "takeControl",
      "handBack",
    ]);
  });
});

describe("SessionManager control handoff", () => {
  it("blocks assertAutomationControl until hand-back", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cua-session-"));
    const session = SessionManager.create({
      runId: "run-assert",
      goal: "test",
      evidenceDir: dir,
    });

    const interventionPromise = session.requestIntervention({
      runId: "run-assert",
      reason: "irreversible",
      message: "Confirm transfer needs a human",
      stepIndex: 3,
      whatHumanShouldDo: "Click Confirm transfer, then hand back",
    });

    await vi.waitFor(() => {
      expect(session.state).toBe("PAUSED_AWAITING_HUMAN");
    });

    const assertPromise = session.assertAutomationControl();
    let asserted = false;
    void assertPromise.then(() => {
      asserted = true;
    });

    await Promise.resolve();
    expect(asserted).toBe(false);

    session.takeControl();
    expect(session.controlOwner).toBe("human");
    session.handBack("Clicked Confirm transfer manually");

    await expect(interventionPromise).resolves.toBe("resumed");
    await assertPromise;
    expect(asserted).toBe(true);
    expect(session.state).toBe("AUTOMATION");

    const evidence = JSON.parse(
      await readFile(path.join(dir, "intervention.json"), "utf8"),
    ) as { outcome: string; humanNote: string };
    expect(evidence.outcome).toBe("resumed");
    expect(evidence.humanNote).toMatch(/Confirm transfer/i);

    await session.close();
  });

  it("resolves intervention with aborted when operator aborts", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "cua-session-"));
    const session = SessionManager.create({
      runId: "run-abort",
      evidenceDir: dir,
    });

    const interventionPromise = session.requestIntervention({
      runId: "run-abort",
      reason: "no_progress",
      message: "stuck",
      stepIndex: 1,
    });

    await vi.waitFor(() => expect(session.state).toBe("PAUSED_AWAITING_HUMAN"));
    session.abort("Giving up");
    await expect(interventionPromise).resolves.toBe("aborted");
    expect(session.aborted).toBe(true);

    const evidence = JSON.parse(
      await readFile(path.join(dir, "intervention.json"), "utf8"),
    ) as { outcome: string };
    expect(evidence.outcome).toBe("aborted");

    await session.close();
  });
});
