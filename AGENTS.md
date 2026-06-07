# eod — Agent Context

## Overview

`eod` is an anti-procrastination iMessage bot built on Bun + TypeScript. It uses the `spectrum-ts` library with the iMessage provider to chat with a single user (or small set of users) and enforce daily task declarations via scheduled check-ins, silence follow-ups, and charity penalties for missed commitments.

## Stack

- **Runtime:** Bun v1.3.6+
- **Language:** TypeScript 5.x, strict mode
- **Module system:** ESM (`"type": "module"`)
- **Database:** SQLite via `bun:sqlite`
- **External dependency:** `spectrum-ts` (iMessage provider + messaging framework)

## Build & Check Commands

```bash
# Install dependencies
bun install

# Run the bot
PROJECT_ID=... PROJECT_SECRET=... AI_BASE_URL=... AI_API_KEY=... AI_MODEL=... bun run index.ts

# Run tests
bun test

# Typecheck
bunx tsc --noEmit
```

## Project Layout

```
index.ts          # Entry point: wire providers, store, scheduler, AI client, message loop
src/
  ai.ts           # OpenAI-compatible chat client, prompt builder, response parser
  brain.ts        # Product logic: morning scheduling, commitment lifecycle, penalties, silence
  config.ts       # Environment parsing with strict validation
  context.ts      # Context builders for AI prompts (school, charity, trajectory)
  handler.ts      # Inbound message routing, command parsing, AI turn orchestration
  scheduler.ts    # SQLite-backed job scheduler with timer coalescing & deduping
  store.ts         # SQLite schema, migrations, and all persistence
  style.ts         # Bot text styling: lowercase, minimal punctuation, burst format
  time.ts          # Timezone-aware date math and formatting utilities
tests/
  ai.test.ts
  brain.test.ts
  config.test.ts
  context.test.ts
  handler.test.ts
  scheduler.test.ts
  store.test.ts
  style.test.ts
  time.test.ts
```

## Coding Conventions

- **TypeScript:** Strict mode, `noUncheckedIndexedAccess`, `noImplicitOverride`, `noFallthroughCasesInSwitch`.
- **Imports:** Prefer `import type { ... }` for type-only imports. `verbatimModuleSyntax` is enabled.
- **String formatting:** Use template literals. Prefer `\n` line splitting for multi-line bot messages (see `style.ts`).
- **Naming:** `camelCase` for variables/functions, `PascalCase` for classes/types, `UPPER_SNAKE` for module-level constants.
- **Error handling:** Prefer returning `undefined` over throwing for missing records. Log errors with `console.error`/`console.warn` at boundaries.
- **Time:** Always reason in the user's configured timezone (`config.botTimezone`). Never do UTC math in prompts.

## Key Architectural Patterns

### 1. AI-Driven State Machine (Not Hardcoded)

The bot does **not** enforce rigid state transitions in code. Instead:

- The AI model receives rich context (commitments, school hours, charity cap, trajectory, history).
- The AI returns a JSON action object (`messages`, `reactions`, `schedules`, `decision`).
- Code (`brain.ts`, `handler.ts`) **applies** the model's declared decisions: creating commitments, marking status, scheduling follow-ups.

Important rule: the app guarantees check-ins and silence follow-ups even when the model doesn't schedule them.

### 2. Commitment Lifecycle

- `declared` → active commitment created with `checkInAt` (~60 min out)
- `completed` / `excused` / `failed` / `canceled` → commitment status updated, pending jobs canceled
- `failed` → charity penalty created (capped monthly)
- Silence levels (1–3) auto-escalate via scheduled jobs if check-ins are ignored

### 3. Scheduling Guarantees

`brain.ts` schedules these regardless of AI output:

- **Morning wake:** ~6am local + jitter
- **Noon annoyance:** 12pm if nothing declared
- **Afternoon check-in:** ~4:30pm
- **Evening check-in:** ~7pm
- **Commitment check-in:** when a task is declared
- **Silence follow-ups:** 3 escalating levels after ignored check-ins
- **Penalty follow-ups:** nag until donation proof is received

The `Scheduler` coalesces duplicate jobs and deduplicates by kind prefix.

### 4. Database

SQLite with inline migrations in `store.ts`. The schema is self-migrating via `migrate()` and `ensureColumn()`.

Key tables: `spaces`, `messages`, `attachments`, `scheduled_jobs`, `commitments`, `model_decisions`, `declaration_days`, `ledger_summaries`, `penalties`.

All timestamps stored as ISO 8601 strings.

### 5. Bot Voice

- Strict lowercase
- Short rapid-fire line bursts (joined with `\n`)
- Minimal punctuation, no trailing periods
- Firm coach + funny friend tone
- Casual profanity only when the user is clearly ignoring the bot

Defined in `style.ts` and enforced by `botText()`.

### 6. Image Handling

Inbound image attachments under `AI_MAX_IMAGE_BYTES` are base64-encoded and sent as `image_url` multimodal parts to the model.

## Environment Variables

Required:
- `PROJECT_ID`, `PROJECT_SECRET` (spectrum-ts)
- `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL`

Optional (all have defaults):
- `AI_TEMPERATURE` (default `0.4`)
- `AI_TIMEOUT_MS` (default `30000`)
- `AI_MAX_IMAGE_BYTES` (default `6000000`)
- `BOT_DB_PATH` (default `./eod.sqlite`)
- `BOT_TIMEZONE` (default `America/New_York`)
- `MORNING_TARGET_HOUR` (default `6`)
- `MORNING_JITTER_MIN_MINUTES` / `MORNING_JITTER_MAX_MINUTES` (default `10`)
- `MORNING_NOON_ANNOYANCE_INTERVAL_MINUTES` (default `30`)
- `SCHOOL_DAYS` (default `1,2,3,4,5`)
- `SCHOOL_START_HOUR` (default `8`)
- `SCHOOL_END_HOUR` (default `15`)
- `CHARITY_NAME`, `CHARITY_DONATE_URL`, `CHARITY_MONTHLY_CAP_DOLLARS` (default `50`)
- `SILENCE_FOLLOWUP_AFTER_HOUR` (default `9`)
- `SILENCE_FOLLOWUP_DELAY_MINUTES` (default `30`)
- `TEST_POKE_DELAY_SECONDS` (default `60`)

## Testing Notes

- Bun's built-in test runner: `bun test`
- Tests use in-memory SQLite databases where possible
- Time-sensitive tests accept an optional `random` or `now` injection for determinism
- When adding scheduler logic, also test deduplication and coalescing behavior

## Common Gotchas

- The AI prompt lives in `src/ai.ts` (`systemPrompt()`). Changing product rules often requires updating the prompt text there.
- `check_in_at` is a legacy alias for `next_checkin_at`. The prompt tells the model to prefer `next_checkin_at`.
- `declaration_context.specificity_nudge_used` gates whether the bot pushes for sharper tasks. Once true, accept vague.
- School excuses are only valid when `school_context` says it is both a school day and school time.
- Penalty amounts must be one of `[1, 5, 10, 25]` and cannot exceed monthly remaining cap.
