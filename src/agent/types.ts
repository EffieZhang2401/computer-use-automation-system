import type { Locator } from "../core/schema.js";
import type { AgentToolCall } from "./tools.js";

export type StuckReason =
  | "no_progress"
  | "action_loop"
  | "policy_rejection"
  | "model_escalate"
  | "max_steps"
  | "timeout"
  | "token_budget"
  | "irreversible";

export type InterventionRequest = {
  runId: string;
  reason: StuckReason;
  message: string;
  stepIndex: number;
  observationHash?: string;
  url?: string;
  whatHumanShouldDo?: string;
};

export type RecordedAction = {
  stepIndex: number;
  toolCall: AgentToolCall;
  locator?: Locator;
  obsHashBefore: string;
  obsHashAfter: string;
  policyRejected?: boolean;
  result: string;
};

export type DiscoveryResult =
  | {
      status: "completed";
      terminalTool: AgentToolCall;
      recordings: RecordedAction[];
      outputs: Record<string, string>;
    }
  | {
      status: "intervention";
      intervention: InterventionRequest;
      recordings: RecordedAction[];
    };

export type DiscoveryOptions = {
  goal: string;
  targetUrl: string;
  runId: string;
  maxSteps?: number;
  timeoutMs?: number;
  baseUrl?: string;
  artifactId?: string;
};
