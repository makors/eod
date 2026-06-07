import type { AiResponse } from "./ai";
import type { BotConfig } from "./config";
import type { Scheduler } from "./scheduler";
import { botText } from "./style";
import { dateKey, localTimeForDateKey, monthKey, nextMorningWake, silenceFollowupDueAt } from "./time";
import type { BotStore, Commitment, Penalty, ScheduledJob, StoredSpace } from "./store";

export const MORNING_WAKE_KIND_PREFIX = "morning_wake:";
export const NOON_KIND_PREFIX = "noon:";
export const AFTERNOON_KIND_PREFIX = "afternoon_check_in:";
export const EVENING_KIND_PREFIX = "evening_check_in:";
export const CHECK_IN_KIND = "commitment_check_in";
export const SILENCE_KIND_PREFIX = "silence_followup:";
export const PENALTY_KIND_PREFIX = "penalty_followup:";

type BrainConfig = Pick<
  BotConfig,
  | "charityDonateUrl"
  | "charityMonthlyCapDollars"
  | "charityName"
  | "botTimezone"
  | "morningJitterMaxMinutes"
  | "morningJitterMinMinutes"
  | "morningNoonAnnoyanceIntervalMinutes"
  | "morningTargetHour"
  | "silenceFollowupAfterHour"
  | "silenceFollowupDelayMinutes"
>;

export function scheduleNextMorningWake(input: {
  config: BrainConfig;
  now?: Date;
  random?: () => number;
  scheduler: Scheduler;
  spaceId: string;
  store: BotStore;
}): ScheduledJob | undefined {
  return scheduleMorningPlan(input).wake;
}

export function scheduleMorningPlan(input: {
  config: BrainConfig;
  now?: Date;
  random?: () => number;
  scheduler: Scheduler;
  spaceId: string;
  store: BotStore;
}): { wake?: ScheduledJob; noon?: ScheduledJob; afternoon?: ScheduledJob; evening?: ScheduledJob } {
  const now = input.now ?? new Date();
  const todayKey = dateKey(now, input.config.botTimezone);
  const noonToday = localTimeForDateKey({ date: todayKey, hour: 12, timeZone: input.config.botTimezone });
  const useToday = now.getTime() < noonToday.getTime();
  const dueAt = useToday
    ? jitteredLocalWake({
        config: input.config,
        date: todayKey,
        random: input.random,
      })
    : nextMorningWake({
        jitterMaxMinutes: input.config.morningJitterMaxMinutes,
        jitterMinMinutes: input.config.morningJitterMinMinutes,
        now,
        random: input.random,
        targetHour: input.config.morningTargetHour,
        timeZone: input.config.botTimezone,
      });
  const key = useToday ? todayKey : dateKey(dueAt, input.config.botTimezone);
  return {
    wake: scheduleUnique(input, {
      body: morningWakeBody(),
      dueAt,
      key,
      kind: `${MORNING_WAKE_KIND_PREFIX}${key}`,
      payload: { event: "morning_wake", date: key },
    }),
    noon: scheduleUnique(input, {
      body: noonAnnoyanceBody(),
      dueAt: localTimeForDateKey({ date: key, hour: 12, timeZone: input.config.botTimezone }),
      key,
      kind: `${NOON_KIND_PREFIX}${key}`,
      payload: { event: "noon", date: key },
    }),
    afternoon: scheduleUnique(input, {
      body: afternoonCheckInBody(),
      dueAt: jitteredLocalTime({
        date: key,
        hour: 16,
        jitterMinutes: 10,
        minute: 30,
        random: input.random,
        timeZone: input.config.botTimezone,
      }),
      key,
      kind: `${AFTERNOON_KIND_PREFIX}${key}`,
      payload: { event: "afternoon_check_in", date: key },
    }),
    evening: scheduleUnique(input, {
      body: eveningCheckInBody(),
      dueAt: jitteredLocalTime({
        date: key,
        hour: 19,
        jitterMinutes: 10,
        minute: 0,
        random: input.random,
        timeZone: input.config.botTimezone,
      }),
      key,
      kind: `${EVENING_KIND_PREFIX}${key}`,
      payload: { event: "evening_check_in", date: key },
    }),
  };
}

export function applyProductDecision(input: {
  config: BrainConfig;
  now: Date;
  response: AiResponse;
  scheduler: Scheduler;
  spaceId: string;
  store: BotStore;
}) {
  const decision = input.response.decision;
  if (!decision) {
    return;
  }

  if (decision.penalty_paid) {
    input.store.markPendingPenaltyPaid(input.spaceId, input.now);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, PENALTY_KIND_PREFIX);
  }

  const active = input.store.getActiveCommitment(input.spaceId);

  if (decision.status === "specificity_needed") {
    input.store.markSpecificityNudge(
      input.spaceId,
      dateKey(input.now, input.config.botTimezone),
      input.now,
    );
    return;
  }

  if (decision.status === "canceled" && active) {
    input.store.setCommitmentStatus(active.id, "canceled", input.now);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, CHECK_IN_KIND);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, SILENCE_KIND_PREFIX);
    saveLedgerIfPresent(input);
    return;
  }

  if (decision.status === "completed" || decision.verify === "pass") {
    if (active) {
      input.store.setCommitmentStatus(active.id, "completed", input.now);
      input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, CHECK_IN_KIND);
      input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, SILENCE_KIND_PREFIX);
    }
    if (decision.penalty_paid) {
      input.store.markPendingPenaltyPaid(input.spaceId, input.now);
      input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, PENALTY_KIND_PREFIX);
    }
    saveLedgerIfPresent(input);
    return;
  }

  if (decision.status === "excused" && active) {
    const until = parseOptionalDate(decision.excuse_until) ?? new Date(input.now.getTime() + 2 * 60 * 60_000);
    input.store.excuseCommitment(active.id, until.toISOString(), input.now);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, CHECK_IN_KIND);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, SILENCE_KIND_PREFIX);
    saveLedgerIfPresent(input);
    return;
  }

  if (decision.status === "excused") {
    const until = parseOptionalDate(decision.excuse_until) ?? new Date(input.now.getTime() + 2 * 60 * 60_000);
    input.store.markDayExcused(
      input.spaceId,
      dateKey(input.now, input.config.botTimezone),
      until.toISOString(),
      input.now,
    );
    saveLedgerIfPresent(input);
    return;
  }

  if (decision.status === "failed" && active) {
    input.store.setCommitmentStatus(active.id, "failed", input.now);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, CHECK_IN_KIND);
    input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, SILENCE_KIND_PREFIX);
    createPenaltyForMiss(input, active, decision.penalty_amount_dollars);
    saveLedgerIfPresent(input);
    return;
  }

  const task = decision.task?.trim();
  if (!task) {
    return;
  }

  const startedAt = input.now.toISOString();
  const deadline = parseOptionalDate(decision.deadline);
  let nextCheckIn =
    parseOptionalDate(decision.next_checkin_at) ??
    parseOptionalDate(decision.check_in_at) ??
    firstScheduleDate(input.response, input.now) ??
    new Date(input.now.getTime() + 60 * 60_000);
  if (deadline && nextCheckIn.getTime() > deadline.getTime()) {
    nextCheckIn = new Date(deadline.getTime() - 5 * 60_000);
  }
  const commitment = input.store.upsertActiveCommitment({
    checkInAt: nextCheckIn.toISOString(),
    deadline: deadline?.toISOString(),
    now: input.now,
    rung: decision.rung,
    spaceId: input.spaceId,
    startedAt,
    task,
  });

  input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, CHECK_IN_KIND);
  input.store.cancelPendingJobsForSpaceByKindPrefix(input.spaceId, SILENCE_KIND_PREFIX);
  input.scheduler.schedule({
    spaceId: input.spaceId,
    kind: CHECK_IN_KIND,
    body: checkInBody(commitment),
    dueAt: nextCheckIn,
    now: input.now,
    payloadJson: JSON.stringify({ event: "commitment_check_in", commitmentId: commitment.id }),
  });
  saveLedgerIfPresent(input);
}

export function afterScheduledJobSent(input: {
  config: BrainConfig;
  job: ScheduledJob;
  now: Date;
  scheduler: Scheduler;
  store: BotStore;
}) {
  if (input.job.kind.startsWith(MORNING_WAKE_KIND_PREFIX)) {
    scheduleMorningPlan({
      config: input.config,
      now: input.now,
      scheduler: input.scheduler,
      spaceId: input.job.spaceId,
      store: input.store,
    });
    return;
  }

  if (input.job.kind === CHECK_IN_KIND) {
    const commitment = input.store.getActiveCommitment(input.job.spaceId);
    if (!commitment) {
      return;
    }

    const dueAt = silenceFollowupDueAt({
      afterHour: input.config.silenceFollowupAfterHour,
      delayMinutes: input.config.silenceFollowupDelayMinutes,
      now: input.now,
      timeZone: input.config.botTimezone,
    });

    input.scheduler.schedule({
      spaceId: input.job.spaceId,
      kind: `${SILENCE_KIND_PREFIX}1`,
      body: silenceBody(1, commitment),
      dueAt,
      now: input.now,
      payloadJson: JSON.stringify({ event: "silence_followup", commitmentId: commitment.id, level: 1 }),
    });
    return;
  }

  if (input.job.kind.startsWith(SILENCE_KIND_PREFIX)) {
    const commitment = input.store.getActiveCommitment(input.job.spaceId);
    if (!commitment) {
      return;
    }

    const lastInboundAt = input.store.getLastInboundAt(input.job.spaceId);
    if (lastInboundAt && new Date(lastInboundAt).getTime() > new Date(input.job.createdAt).getTime()) {
      return;
    }

    const updated = input.store.incrementSilenceLevel(commitment.id, input.now);
    const level = updated?.silenceLevel ?? commitment.silenceLevel + 1;
    if (level >= 3) {
      input.store.setCommitmentStatus(commitment.id, "failed", input.now);
      input.store.cancelPendingJobsForSpaceByKindPrefix(input.job.spaceId, SILENCE_KIND_PREFIX);
      createPenaltyForMiss(
        {
          config: input.config,
          now: input.now,
          response: { messages: [], reactions: [], schedules: [] },
          scheduler: input.scheduler,
          spaceId: input.job.spaceId,
          store: input.store,
        },
        commitment,
      );
      return;
    }

    input.scheduler.schedule({
      spaceId: input.job.spaceId,
      kind: `${SILENCE_KIND_PREFIX}${level + 1}`,
      body: silenceBody(level + 1, commitment),
      dueAt: new Date(input.now.getTime() + input.config.silenceFollowupDelayMinutes * 60_000),
      now: input.now,
      payloadJson: JSON.stringify({ event: "silence_followup", commitmentId: commitment.id, level: level + 1 }),
    });
  }

  if (input.job.kind.startsWith(PENALTY_KIND_PREFIX)) {
    const pending = input.store.getPendingPenalty(input.job.spaceId);
    if (!pending) {
      return;
    }

    input.scheduler.schedule({
      spaceId: input.job.spaceId,
      kind: `${PENALTY_KIND_PREFIX}${pending.id}:${Date.now()}`,
      body: penaltyBody(pending),
      dueAt: new Date(input.now.getTime() + input.config.morningNoonAnnoyanceIntervalMinutes * 60_000),
      now: input.now,
      payloadJson: JSON.stringify({ event: "penalty_followup", penaltyId: pending.id }),
    });
  }
}

export function clearSilenceOnInbound(store: BotStore, spaceId: string) {
  store.cancelPendingJobsForSpaceByKindPrefix(spaceId, SILENCE_KIND_PREFIX);
}

export function morningWakeBody(): string {
  return botText([
    "morning king",
    "name the mission",
    "bounded task or bounded rest",
  ]);
}

export function noonAnnoyanceBody(): string {
  return botText([
    "noon king",
    "we are past cute",
    "declare something or explain the real blocker",
  ]);
}

export function afternoonCheckInBody(): string {
  return botText([
    "afternoon check",
    "what moved",
  ]);
}

export function eveningCheckInBody(): string {
  return botText([
    "evening check",
    "where are we",
  ]);
}

export function checkInBody(commitment: Commitment): string {
  return botText([
    "check in king",
    commitment.task,
    "show me what moved",
  ]);
}

function scheduleUnique(
  input: {
    now?: Date;
    scheduler: Scheduler;
    spaceId: string;
    store: BotStore;
  },
  job: {
    body: string;
    dueAt: Date;
    key: string;
    kind: string;
    payload: Record<string, unknown>;
  },
): ScheduledJob | undefined {
  const now = input.now ?? new Date();
  if (job.dueAt.getTime() <= now.getTime()) {
    return undefined;
  }
  if (input.store.getPendingJobByKind(input.spaceId, job.kind)) {
    return undefined;
  }

  return input.scheduler.schedule({
    spaceId: input.spaceId,
    kind: job.kind,
    body: job.body,
    dueAt: job.dueAt,
    now,
    payloadJson: JSON.stringify(job.payload),
  });
}

function jitteredLocalWake(input: {
  config: BrainConfig;
  date: string;
  random?: () => number;
}): Date {
  const random = input.random ?? Math.random;
  const base = localTimeForDateKey({
    date: input.date,
    hour: input.config.morningTargetHour,
    timeZone: input.config.botTimezone,
  });
  const range = input.config.morningJitterMaxMinutes - input.config.morningJitterMinMinutes + 1;
  const minutes = input.config.morningJitterMinMinutes + Math.floor(random() * range);
  const sign = random() < 0.5 ? -1 : 1;
  return new Date(base.getTime() + sign * minutes * 60_000);
}

function jitteredLocalTime(input: {
  date: string;
  hour: number;
  jitterMinutes: number;
  minute: number;
  random?: () => number;
  timeZone: string;
}): Date {
  const random = input.random ?? Math.random;
  const base = localTimeForDateKey({
    date: input.date,
    hour: input.hour,
    minute: input.minute,
    timeZone: input.timeZone,
  });
  const offset = Math.floor(random() * (input.jitterMinutes * 2 + 1)) - input.jitterMinutes;
  return new Date(base.getTime() + offset * 60_000);
}

function createPenaltyForMiss(
  input: {
    config: BrainConfig;
    now: Date;
    response: AiResponse;
    scheduler: Scheduler;
    spaceId: string;
    store: BotStore;
  },
  commitment: Commitment,
  requestedAmount?: number,
): Penalty | undefined {
  if (input.store.getPendingPenalty(input.spaceId)) {
    return undefined;
  }

  const month = monthKey(input.now, input.config.botTimezone);
  const remaining = input.config.charityMonthlyCapDollars - input.store.monthlyPenaltyTotal(input.spaceId, month);
  if (remaining <= 0) {
    return undefined;
  }

  const amount = clampPenaltyAmount(requestedAmount ?? defaultPenaltyAmount(commitment), remaining);
  if (amount <= 0) {
    return undefined;
  }

  const penalty = input.store.createPenalty({
    amountDollars: amount,
    charityDonateUrl: input.config.charityDonateUrl || undefined,
    charityName: input.config.charityName,
    commitmentId: commitment.id,
    now: input.now,
    reason: commitment.task,
    spaceId: input.spaceId,
  });

  input.scheduler.schedule({
    spaceId: input.spaceId,
    kind: `${PENALTY_KIND_PREFIX}${penalty.id}`,
    body: penaltyBody(penalty),
    dueAt: new Date(input.now.getTime() + 5 * 60_000),
    now: input.now,
    payloadJson: JSON.stringify({ event: "penalty_followup", penaltyId: penalty.id }),
  });

  return penalty;
}

function penaltyBody(penalty: Penalty): string {
  return botText([
    `charity tax ${penalty.amountDollars} dollars`,
    penalty.charityName,
    penalty.charityDonateUrl ?? "send proof when paid",
  ]);
}

function defaultPenaltyAmount(commitment: Commitment): number {
  const task = commitment.task.toLowerCase();
  if (task.includes("huge") || task.includes("project")) {
    return 25;
  }
  if (task.includes("school") || task.includes("homework") || task.includes("class")) {
    return 5;
  }
  return 10;
}

function clampPenaltyAmount(input: number, remaining: number): number {
  const allowed = [1, 5, 10, 25].filter((amount) => amount <= remaining);
  if (allowed.length === 0) {
    return 0;
  }
  const requested = [1, 5, 10, 25].includes(input) ? input : 10;
  return requested <= remaining ? requested : Math.max(...allowed);
}

function saveLedgerIfPresent(input: { now: Date; response: AiResponse; spaceId: string; store: BotStore }) {
  const summary = input.response.decision?.ledger_summary?.trim();
  if (!summary) {
    return;
  }
  input.store.saveLedgerSummary({
    now: input.now,
    spaceId: input.spaceId,
    summary,
  });
}

export function silenceBody(level: number, commitment: Commitment): string {
  if (level <= 1) {
    return botText([
      "king",
      "you vanished",
      commitment.task,
      "receipt or real excuse",
    ]);
  }

  if (level === 2) {
    return botText([
      "my liege this is drift",
      commitment.task,
      "send proof or call the audible",
    ]);
  }

  return botText([
    "logging the miss",
    "not fatal",
    "but it counts king",
  ]);
}

function firstScheduleDate(response: AiResponse, now: Date): Date | undefined {
  for (const schedule of response.schedules) {
    if (schedule.due_at) {
      const dueAt = parseOptionalDate(schedule.due_at);
      if (dueAt) {
        return dueAt;
      }
    }
    if (schedule.delay_minutes) {
      return new Date(now.getTime() + schedule.delay_minutes * 60_000);
    }
  }
  return undefined;
}

function parseOptionalDate(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}
