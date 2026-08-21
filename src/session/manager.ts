/**
 * SessionManager — holds controlOwner and coordinates intervention handoff
 * on the same live session (browser stays open while paused).
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { InterventionRequest } from "../agent/types.js";
import {
  ControlTransfer,
  type ControlOwner,
  type ControlState,
  type ControlTransition,
} from "./control.js";

export type InterventionOutcome = "resumed" | "aborted";

export type InterventionRecord = {
  runId: string;
  sessionId: string;
  reason: InterventionRequest["reason"];
  message: string;
  stepIndex: number;
  url?: string;
  observationHash?: string;
  whatHumanShouldDo?: string;
  goal?: string;
  capabilityId?: string;
  requestedAt: string;
  takenControlAt?: string;
  handedBackAt?: string;
  abortedAt?: string;
  humanNote?: string;
  outcome?: InterventionOutcome;
  controlTransitions: ControlTransition[];
};

export type SessionSnapshot = {
  sessionId: string;
  runId: string;
  goal?: string;
  capabilityId?: string;
  state: ControlState;
  controlOwner: ControlOwner;
  aborted: boolean;
  intervention: InterventionRequest | null;
  stepIndex?: number;
};

export type SessionEvent =
  | { type: "intervention"; session: SessionSnapshot; intervention: InterventionRequest }
  | { type: "state"; session: SessionSnapshot }
  | { type: "closed"; sessionId: string; runId: string };

export type SessionManagerOptions = {
  runId: string;
  sessionId?: string;
  goal?: string;
  capabilityId?: string;
  evidenceDir?: string;
};

type Waiter = {
  resolve: (outcome: InterventionOutcome) => void;
};

const registry = new Map<string, SessionManager>();
const bus = new EventEmitter();

export function getSession(sessionId: string): SessionManager | undefined {
  return registry.get(sessionId);
}

export function listSessions(): SessionManager[] {
  return [...registry.values()];
}

export function onSessionEvent(listener: (event: SessionEvent) => void): () => void {
  bus.on("session", listener);
  return () => {
    bus.off("session", listener);
  };
}

export class SessionAbortedError extends Error {
  constructor(sessionId: string) {
    super(`Session ${sessionId} was aborted by the operator`);
    this.name = "SessionAbortedError";
  }
}

export class SessionManager {
  readonly sessionId: string;
  readonly runId: string;
  readonly goal?: string;
  readonly capabilityId?: string;
  readonly evidenceDir: string;
  readonly control = new ControlTransfer();

  private _aborted = false;
  private currentIntervention: InterventionRequest | null = null;
  private interventionRecord: InterventionRecord | null = null;
  private waiters: Waiter[] = [];
  private closed = false;

  private constructor(opts: SessionManagerOptions) {
    this.sessionId = opts.sessionId ?? opts.runId;
    this.runId = opts.runId;
    this.goal = opts.goal;
    this.capabilityId = opts.capabilityId;
    this.evidenceDir = opts.evidenceDir ?? path.resolve("evidence", opts.runId);
  }

  static create(opts: SessionManagerOptions): SessionManager {
    const session = new SessionManager(opts);
    registry.set(session.sessionId, session);
    session.emit({ type: "state", session: session.snapshot() });
    return session;
  }

  get controlOwner(): ControlOwner {
    return this.control.controlOwner;
  }

  get state(): ControlState {
    return this.control.state;
  }

  get aborted(): boolean {
    return this._aborted;
  }

  get intervention(): InterventionRequest | null {
    return this.currentIntervention;
  }

  snapshot(): SessionSnapshot {
    return {
      sessionId: this.sessionId,
      runId: this.runId,
      goal: this.goal,
      capabilityId: this.capabilityId,
      state: this.control.state,
      controlOwner: this.control.controlOwner,
      aborted: this._aborted,
      intervention: this.currentIntervention,
      stepIndex: this.currentIntervention?.stepIndex,
    };
  }

  /**
   * Every discovery/replay action must call this before acting.
   * Blocks until controlOwner === "automation" (after hand-back), or throws if aborted.
   */
  async assertAutomationControl(): Promise<void> {
    if (this._aborted) {
      throw new SessionAbortedError(this.sessionId);
    }
    if (this.control.controlOwner === "automation" && this.control.state === "AUTOMATION") {
      return;
    }
    await this.waitUntilAutomation();
    if (this._aborted) {
      throw new SessionAbortedError(this.sessionId);
    }
  }

  /**
   * Pause for human intervention on the same live session.
   * Resolves with "resumed" after hand-back, or "aborted" if the operator aborts.
   */
  async requestIntervention(req: InterventionRequest): Promise<InterventionOutcome> {
    if (this._aborted) {
      return "aborted";
    }
    if (this.control.state !== "AUTOMATION") {
      // Already paused — coalesce onto the existing wait.
      return this.waitUntilAutomation();
    }

    this.control.requestPause();
    this.currentIntervention = req;
    const requestedAt = new Date().toISOString();
    this.interventionRecord = {
      runId: this.runId,
      sessionId: this.sessionId,
      reason: req.reason,
      message: req.message,
      stepIndex: req.stepIndex,
      url: req.url,
      observationHash: req.observationHash,
      whatHumanShouldDo: req.whatHumanShouldDo,
      goal: this.goal,
      capabilityId: this.capabilityId,
      requestedAt,
      controlTransitions: [...this.control.history],
    };

    await mkdir(this.evidenceDir, { recursive: true });
    await this.persistRuntimeQueue();
    await this.logEvent({
      type: "intervention_requested",
      actor: "automation",
      runId: this.runId,
      reason: req.reason,
      message: req.message,
      stepIndex: req.stepIndex,
      url: req.url,
      whatHumanShouldDo: req.whatHumanShouldDo,
      timestamp: requestedAt,
    });
    await this.writeInterventionEvidence();

    this.emit({ type: "intervention", session: this.snapshot(), intervention: req });
    this.emit({ type: "state", session: this.snapshot() });

    return this.waitUntilAutomation();
  }

  takeControl(): void {
    this.control.takeControl();
    const at = new Date().toISOString();
    if (this.interventionRecord !== null) {
      this.interventionRecord.takenControlAt = at;
      this.interventionRecord.controlTransitions = [...this.control.history];
    }
    void this.logEvent({
      type: "control_taken",
      actor: "human",
      runId: this.runId,
      stepIndex: this.currentIntervention?.stepIndex,
      timestamp: at,
    });
    void this.writeInterventionEvidence();
    this.emit({ type: "state", session: this.snapshot() });
  }

  handBack(humanNote?: string): void {
    this.control.handBack();
    const at = new Date().toISOString();
    if (this.interventionRecord !== null) {
      this.interventionRecord.handedBackAt = at;
      this.interventionRecord.humanNote =
        humanNote ??
        `Human completed step ${this.currentIntervention?.stepIndex ?? "?"} manually and handed control back`;
      this.interventionRecord.outcome = "resumed";
      this.interventionRecord.controlTransitions = [...this.control.history];
    }
    void this.logEvent({
      type: "control_handed_back",
      actor: "human",
      runId: this.runId,
      stepIndex: this.currentIntervention?.stepIndex,
      humanNote: this.interventionRecord?.humanNote,
      timestamp: at,
    });
    void this.writeInterventionEvidence();
    void this.persistRuntimeQueue();

    this.currentIntervention = null;
    this.resolveWaiters("resumed");
    this.emit({ type: "state", session: this.snapshot() });
  }

  abort(reason?: string): void {
    if (this.control.state === "AUTOMATION" && this.waiters.length === 0) {
      this._aborted = true;
      return;
    }
    if (this.control.state !== "AUTOMATION") {
      this.control.abort();
    }
    this._aborted = true;
    const at = new Date().toISOString();
    if (this.interventionRecord !== null) {
      this.interventionRecord.abortedAt = at;
      this.interventionRecord.humanNote = reason ?? "Operator aborted the run";
      this.interventionRecord.outcome = "aborted";
      this.interventionRecord.controlTransitions = [...this.control.history];
    }
    void this.logEvent({
      type: "session_aborted",
      actor: "human",
      runId: this.runId,
      reason: reason ?? "Operator aborted the run",
      stepIndex: this.currentIntervention?.stepIndex,
      timestamp: at,
    });
    void this.writeInterventionEvidence();
    void this.persistRuntimeQueue();

    this.currentIntervention = null;
    this.resolveWaiters("aborted");
    this.emit({ type: "state", session: this.snapshot() });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.waiters.length > 0) {
      this.abort("Session closed");
    }
    registry.delete(this.sessionId);
    this.emit({ type: "closed", sessionId: this.sessionId, runId: this.runId });
    await this.persistRuntimeQueue();
  }

  private waitUntilAutomation(): Promise<InterventionOutcome> {
    if (this._aborted) {
      return Promise.resolve("aborted");
    }
    if (this.control.state === "AUTOMATION" && this.currentIntervention === null) {
      return Promise.resolve("resumed");
    }
    return new Promise<InterventionOutcome>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  private resolveWaiters(outcome: InterventionOutcome): void {
    const pending = this.waiters.splice(0, this.waiters.length);
    for (const waiter of pending) {
      waiter.resolve(outcome);
    }
  }

  private emit(event: SessionEvent): void {
    bus.emit("session", event);
  }

  private async logEvent(event: Record<string, unknown>): Promise<void> {
    await mkdir(this.evidenceDir, { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    await appendFile(path.join(this.evidenceDir, "events.ndjson"), line, "utf8");
  }

  private async writeInterventionEvidence(): Promise<void> {
    if (this.interventionRecord === null) return;
    await mkdir(this.evidenceDir, { recursive: true });
    const file = path.join(this.evidenceDir, "intervention.json");
    await writeFile(file, `${JSON.stringify(this.interventionRecord, null, 2)}\n`, "utf8");
  }

  private async persistRuntimeQueue(): Promise<void> {
    const runtimeDir = path.resolve("runtime");
    await mkdir(runtimeDir, { recursive: true });
    const payload = {
      updatedAt: new Date().toISOString(),
      sessions: listSessions().map((s) => s.snapshot()),
      pendingInterventions: listSessions()
        .filter((s) => s.intervention !== null)
        .map((s) => ({
          ...s.intervention!,
          sessionId: s.sessionId,
          goal: s.goal,
          capabilityId: s.capabilityId,
          state: s.state,
          controlOwner: s.controlOwner,
        })),
    };
    await writeFile(
      path.join(runtimeDir, "interventions.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }
}
