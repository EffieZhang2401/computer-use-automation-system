/**
 * Control-ownership state machine:
 * AUTOMATION ⇄ PAUSED_AWAITING_HUMAN ⇄ HUMAN
 *
 * Abort may return PAUSED or HUMAN → AUTOMATION without a hand-back.
 */

export type ControlState = "AUTOMATION" | "PAUSED_AWAITING_HUMAN" | "HUMAN";

export type ControlOwner = "automation" | "human";

export class IllegalTransitionError extends Error {
  readonly from: ControlState;
  readonly action: string;

  constructor(from: ControlState, action: string) {
    super(`Illegal control transition: cannot ${action} from ${from}`);
    this.name = "IllegalTransitionError";
    this.from = from;
    this.action = action;
  }
}

export function ownerFromState(state: ControlState): ControlOwner {
  return state === "HUMAN" ? "human" : "automation";
}

export type ControlTransition = {
  from: ControlState;
  to: ControlState;
  action: string;
  at: string;
};

/**
 * Pure state machine for session control transfer.
 * `controlOwner` is derived: only HUMAN maps to "human"; otherwise "automation"
 * (including PAUSED_AWAITING_HUMAN — automation owns the session but must not act).
 */
export class ControlTransfer {
  private _state: ControlState = "AUTOMATION";
  readonly history: ControlTransition[] = [];

  get state(): ControlState {
    return this._state;
  }

  get controlOwner(): ControlOwner {
    return ownerFromState(this._state);
  }

  /** AUTOMATION → PAUSED_AWAITING_HUMAN */
  requestPause(): void {
    this.transition("AUTOMATION", "PAUSED_AWAITING_HUMAN", "requestPause");
  }

  /** PAUSED_AWAITING_HUMAN → HUMAN */
  takeControl(): void {
    this.transition("PAUSED_AWAITING_HUMAN", "HUMAN", "takeControl");
  }

  /** HUMAN → AUTOMATION */
  handBack(): void {
    this.transition("HUMAN", "AUTOMATION", "handBack");
  }

  /** PAUSED_AWAITING_HUMAN | HUMAN → AUTOMATION */
  abort(): void {
    if (this._state === "AUTOMATION") {
      throw new IllegalTransitionError(this._state, "abort");
    }
    const from = this._state;
    this._state = "AUTOMATION";
    this.history.push({
      from,
      to: "AUTOMATION",
      action: "abort",
      at: new Date().toISOString(),
    });
  }

  private transition(expected: ControlState, to: ControlState, action: string): void {
    if (this._state !== expected) {
      throw new IllegalTransitionError(this._state, action);
    }
    const from = this._state;
    this._state = to;
    this.history.push({
      from,
      to,
      action,
      at: new Date().toISOString(),
    });
  }
}
