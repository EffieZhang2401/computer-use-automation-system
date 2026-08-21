# Report

## Architecture

This system separates **teaching** a workflow from **running** it.

Discovery (`src/agent/loop.ts`) is the only path that calls an LLM, and only
through `src/llm/client.ts`. The model sees a compressed accessibility-tree
observation and may only choose tools from an explicit schema (`ref`-based
click/fill/…, `done`, `escalate`). Every tool call passes `PolicyGate`, then
the surface acts; locators are captured from the real element at that moment
(`src/agent/recorder.ts`) and compiled into a `CapabilityArtifact`.

Replay (`src/replay/executor.ts`) loads that artifact and executes steps with
**no LLM imports**. Classification after each step
(`src/replay/state-classifier.ts`) decides success, a declared business
outcome, an internal recovery retry, or a hard failure. Storage is plain
versioned JSON (`artifacts/`, `evidence/`, `.cassettes/`) — deliberate for a
localhost assessment, not a missing database.

**Design decision to defend:** why record-once / replay-without-a-model
instead of keeping the LLM in the loop in production? Cost, auditability, and
determinism for regulated banking UIs. Pushback: “the UI will drift.” Answer:
locator fallback ladders + `verify` + health histogram are the drift signal;
escalation exists when automation cannot proceed — we do not silently re-prompt
the model mid-replay.

## Artifact schema

The contract is `CapabilityArtifact` in `src/core/schema.ts` (`SCHEMA_VERSION`
`"1.0"`). A capability names inputs/outputs, an ordered `steps[]`, a
`successCheckpoint`, declarative `outcomes` and `recoveries`, a `policy`
block, and provenance.

Locators are a **ladder**: `primary` plus ordered `fallbacks`, preferring
`role`+`name` (portable across web a11y / UIA / AX), then label, textAnchor,
css, domPath, coordinates. After resolve, optional `verify` re-checks; failure
means “try next tier,” never a silent wrong element
(`src/surface/locator-resolver.ts`).

Step values are `literal` or `{kind:"param"}`. Non-`public` parameters must
not appear as literals in the artifact. Status is `draft` until an explicit
approve step (`npm run approve`) produces an `approved` 1.0.0 used for
unattended irreversible replay.

**Design decision to defend:** why not one CSS selector per step? CSS couples
to layout and breaks under restyles; role+name matches how assistive tech (and
desktop automation) already names controls. Fallbacks buy time when the
primary strategy drifts.

## Determinism & error handling

Determinism is enforced at three layers:

1. **Demo app** (`demo-app/seed.ts`) — fixed members, fixed session cookie, no
   timestamps or random IDs leaking into observations (so cassette keys hit).
2. **LLM cassettes** (`src/llm/cassette.ts`) — SHA-256 of a normalized request;
   `LLM_MODE=replay` fails on miss instead of spending tokens.
3. **Replay classification** — terminal statuses are only `success`,
   `business_outcome`, `escalated`, or `failed`. “Member not found” is a
   declared outcome, not an exception. Recoveries retry internally and never
   surface as a fourth terminal bucket.

Discovery stops for stuck conditions (`src/agent/stuck.ts`: unchanged
observations, action loops, repeated policy rejects, token budget, timeouts)
by raising an `InterventionRequest` rather than spinning forever.

**Design decision to defend:** why treat business outcomes as success-shaped
results? Because the capability did what the bank UI does — it reported a
valid business result. Callers need a stable API; throwing on “not found”
would force every integrator to parse error strings.

## Heterogeneity & multi-tenant

Agent and replay code depend on the `Surface` interface
(`src/surface/surface.ts`: `observe` / `act` / `screenshot`), not on Playwright
types. `WebSurface` implements Chromium + CDP accessibility trees (including
iframe content used by the demo shell). `DesktopSurfaceStub` type-checks the
same shape and throws “not implemented,” documenting the intended UIA/AX
path without pretending it ships.

The artifact `target` carries `appId`, optional `tenantId`, and a templated
`entryPoint` (`{{baseUrl}}/...`) so the same capability can be aimed at
different origins via params. Policy `allowedOrigins` is per-artifact, which
is the multi-tenant safety knob that exists today — there is no tenant
registry or runtime isolation fabric.

**Design decision to defend:** why invest in Surface before a second backend?
Because the expensive mistake is baking Playwright selectors into the agent
loop. The interface is the seam; desktop is a stub so the seam stays honest.

## Escalation & handoff

Stuck or risky moments must not “open a fresh browser for the human.”
`SessionManager` (`src/session/manager.ts`) owns an explicit control state
machine (`AUTOMATION` ⇄ `PAUSED_AWAITING_HUMAN` ⇄ `HUMAN` in
`src/session/control.ts`). Discovery and replay call
`assertAutomationControl()` before acting; if control is not automation, they
**block** until hand-back. The Playwright page stays open for the whole pause.

The operator console (`src/operator/`) pushes `InterventionRequest` over SSE.
This build ships the **degraded** console: no CDP screencast and no remote
input forwarding — the human completes the step in the headed window, then
clicks Hand back. Evidence stays continuous: `events.ndjson` with
`actor: "human"|"automation"`, plus `evidence/<runId>/intervention.json`.

**Design decision to defend:** what makes it the same live session? The browser
context is never closed during pause; only `controlOwner` / state change. The
enforcement line is `assertAutomationControl()` before `surface.act` /
step execution — without that assert, “pause” would be a diagram.

## Safety

`PolicyGate` (`src/policy/gate.ts`) is the choke point for every action:
origin allowlist, action allowlist, step ceiling, and risk classification
(safe / reversible / irreversible). Discovery may flag irreversible actions
and, when headed handoff is enabled, pause for a human before executing them.
Replay refuses irreversible steps unless `artifact.status === "approved"`.

Sensitive values are not persisted as literals in artifacts (param references
only). Logs go through `src/core/redactor.ts`. LLM spend is capped by
`MAX_RUN_TOKENS`; overrun becomes an escalation, not an unbounded bill.

**Design decision to defend:** why allow irreversible actions during discovery
at all? Because you cannot record a wire-posting workflow if the gate always
blocks the confirming click. The tradeoff is: discovery records under
supervision (handoff when headed); unattended replay requires an approved
artifact.

## Cuts

Deliberate non-goals for this assessment:

- No Docker, cloud deploy, database, queue, or agent framework
- Desktop automation is a typed stub, not a working UIA/AX driver
- Operator console has no live screencast / no `Input.dispatch*` co-browsing
- No multi-operator auth, routing, or audio/video
- Screenshot sensitive-region masking is specified as intent but not
  implemented; failure screenshots are written as captured
- Replay recoveries are modeled in schema/classifier; the approved sample
  artifact currently ships with an empty `recoveries` list
- No production-scale multi-tenant control plane — only schema fields and
  per-artifact origin policy

These cuts keep the submission cheap and reviewable while keeping the
non-negotiables real: replay without an LLM, locators from the live tree,
PolicyGate on every action, and same-session human handoff with an evidence
trail.
