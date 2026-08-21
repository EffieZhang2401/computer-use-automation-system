# computer-use-automation-system

Record-once, replay-without-a-model computer-use automation for bank/credit-union
style interfaces (Interface.ai take-home).

An LLM drives a **discovery** run once against a live UI, capturing real
accessibility-tree locators. That recording compiles into a versioned
**capability artifact**. Later **replay** runs execute the artifact
deterministically — no model in the decision loop.

## What this repo demonstrates

- Discovery agent loop with a constrained tool schema (no LangChain / frameworks)
- Locator capture from the real DOM/a11y tree (the model never invents selectors)
- PolicyGate on every action (discovery and replay)
- Deterministic replay with business outcomes vs hard failures
- Human-in-the-loop escalation on the **same live browser session**
- File-based artifacts, evidence, and LLM cassettes (no Docker, no database)

## Prerequisites

- Node.js ≥ 20
- Playwright Chromium (installed with `npx playwright install chromium` if needed)
- Optional: `GEMINI_API_KEY` or `ANTHROPIC_API_KEY` for live discovery

```bash
npm install
cp .env.example .env   # then edit keys / LLM_MODE
```

## Quick start

### 1. Demo bank UI (always needed)

```bash
npm run demo-app
# → http://127.0.0.1:3100  (login: teller / password)
```

### 2. Tests / typecheck

```bash
npm test
npm run typecheck
```

### 3. Replay an approved capability (no LLM)

```bash
# Happy path — Jane Rivera savings balance
npx tsx src/cli/replay.ts --artifact artifacts/member.read_savings_balance/1.0.0.json --input memberId=12345 --input baseUrl=http://localhost:3100

# Business outcome — member not found
npx tsx src/cli/replay.ts --artifact artifacts/member.read_savings_balance/1.0.0.json --input memberId=99999 --input baseUrl=http://localhost:3100

# Hard failure — injected app error
npx tsx src/cli/replay.ts --artifact artifacts/member.read_savings_balance/1.0.0.json --input memberId=12345 --input baseUrl=http://localhost:3100 --inject app_error
```

### 4. Discovery (LLM)

Development uses cassettes when possible (`LLM_MODE=replay` or `auto`).
Produce a new evidence run with `LLM_MODE=live`.

```powershell
# PowerShell — live headed run with operator console
$env:LLM_MODE="live"
npx tsx src/cli/discover.ts --headed --goal "Look up member 12345 and read the savings balance" --target http://localhost:3100/members/search
```

Operator console (when discover starts with operator enabled): http://127.0.0.1:3200

Approve a draft artifact:

```bash
npm run approve -- --artifact artifacts/<id>.draft.json
```

## Layout

| Path | Role |
|------|------|
| `src/agent/` | Discovery loop, tools, recorder, compiler, stuck detection |
| `src/llm/` | Only LLM entrypoint; cassettes + token budget |
| `src/replay/` | Deterministic executor (no LLM imports) |
| `src/surface/` | `Surface` abstraction; Playwright web + desktop stub |
| `src/policy/` | PolicyGate |
| `src/session/` | Control-ownership state machine |
| `src/operator/` | Minimal SSE operator console |
| `src/core/` | Zod artifact schema, redactor |
| `demo-app/` | Deterministic CoreBank Lite |
| `artifacts/` | Draft + approved capability JSON |
| `evidence/` | Per-run event logs and results |
| `.cassettes/` | Recorded LLM responses for zero-cost replay |
| `REPORT.md` | Design write-up for reviewers |

## Environment

See `.env.example`:

| Variable | Meaning |
|----------|---------|
| `LLM_MODE` | `auto` \| `replay` \| `live` |
| `LLM_PROVIDER` | `gemini` \| `anthropic` |
| `MODEL` | Provider model id |
| `MAX_RUN_TOKENS` | Per-run budget; overrun → escalate |
| `BASE_URL` | Demo app origin |

`LLM_MODE=replay` never calls the network; a cassette miss fails closed.

## Design write-up

See [REPORT.md](./REPORT.md) for architecture, schema, determinism, multi-tenant
notes, escalation, safety, and deliberate cuts.
