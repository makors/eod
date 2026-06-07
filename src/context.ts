import type { CharityContext, SchoolContext, TrajectoryContext } from "./ai";
import type { BotConfig } from "./config";
import { monthKey, localDayAndHour } from "./time";
import type { BotStore, StoredSpace } from "./store";

type ContextConfig = Pick<
  BotConfig,
  | "botTimezone"
  | "charityDonateUrl"
  | "charityMonthlyCapDollars"
  | "charityName"
  | "schoolDays"
  | "schoolEndHour"
  | "schoolStartHour"
>;

export function schoolContext(config: ContextConfig, now: Date): SchoolContext {
  const local = localDayAndHour(now, config.botTimezone);
  const isSchoolDay = config.schoolDays.includes(local.day);
  return {
    is_school_day: isSchoolDay,
    is_school_time: isSchoolDay && local.hour >= config.schoolStartHour && local.hour < config.schoolEndHour,
    local_day: local.day,
    local_hour: local.hour,
  };
}

export function charityContext(
  config: ContextConfig,
  store: BotStore,
  space: StoredSpace,
  now: Date,
): CharityContext {
  const total = store.monthlyPenaltyTotal(space.id, monthKey(now, config.botTimezone));
  return {
    charity_name: config.charityName,
    donate_url: config.charityDonateUrl || undefined,
    monthly_cap_dollars: config.charityMonthlyCapDollars,
    monthly_remaining_dollars: Math.max(0, config.charityMonthlyCapDollars - total),
    pending_penalty: store.getPendingPenalty(space.id),
  };
}

export function trajectoryContext(store: BotStore, spaceId: string): TrajectoryContext {
  const recentCommitments = store.listRecentCommitments(spaceId, 20);
  const recentDecisions = store.listRecentDecisions(spaceId, 30);
  return {
    failed_count: recentCommitments.filter((commitment) => commitment.status === "failed").length,
    recent_commitments: recentCommitments,
    recent_decisions: recentDecisions,
    rung3_needs_more_count: recentDecisions.filter(
      (decision) => decision.rung === "rung3_probe" || decision.verify === "needs_more",
    ).length,
    summary: store.getLatestLedgerSummary(spaceId),
  };
}
