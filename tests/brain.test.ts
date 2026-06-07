import { describe, expect, test } from "bun:test";
import {
  afterScheduledJobSent,
  applyProductDecision,
  CHECK_IN_KIND,
  scheduleMorningPlan,
  scheduleNextMorningWake,
  SILENCE_KIND_PREFIX,
} from "../src/brain";
import { Scheduler } from "../src/scheduler";
import { BotStore } from "../src/store";

describe("brain", () => {
  test("schedules one morning wake per local day", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    const first = scheduleNextMorningWake({
      config: testConfig(),
      now: new Date("2026-06-06T04:00:00.000Z"),
      random: randomSequence([0, 0]),
      scheduler,
      spaceId: "chat-1",
      store,
    });
    const second = scheduleNextMorningWake({
      config: testConfig(),
      now: new Date("2026-06-06T04:01:00.000Z"),
      random: randomSequence([0.2, 0.8]),
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(first?.dueAt).toBe("2026-06-06T09:55:00.000Z");
    expect(second).toBeUndefined();

    scheduler.stop();
    store.close();
  });

  test("schedules a simplified daily plan without rigid followups", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    const jobs = scheduleMorningPlan({
      config: testConfig(),
      now: new Date("2026-06-06T04:00:00.000Z"),
      random: () => 0,
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(jobs.wake).toBeDefined();
    expect(jobs.noon).toBeDefined();
    expect(jobs.afternoon).toBeDefined();
    expect(jobs.evening).toBeDefined();

    const kinds = store.listPendingJobs().map((j) => j.kind);
    expect(kinds.some((k) => k.startsWith("morning_followup"))).toBe(false);
    expect(kinds.some((k) => k.startsWith("morning_noon"))).toBe(false);

    scheduler.stop();
    store.close();
  });

  test("declared task becomes an active commitment with a guaranteed check in", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:00:00.000Z"),
      response: {
        decision: {
          check_in_at: "2026-06-06T12:25:00.000Z",
          rung: "rung3_probe",
          status: "declared",
          task: "write the outline",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getActiveCommitment("chat-1")?.task).toBe("write the outline");
    expect(store.getPendingJobByKind("chat-1", CHECK_IN_KIND)?.dueAt).toBe("2026-06-06T12:25:00.000Z");

    scheduler.stop();
    store.close();
  });

  test("declared task sets started_at to now and defaults check-in to ~60 min", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    const now = new Date("2026-06-06T12:00:00.000Z");
    applyProductDecision({
      config: testConfig(),
      now,
      response: {
        decision: {
          rung: "rung3_probe",
          status: "declared",
          task: "write the outline",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    const commitment = store.getActiveCommitment("chat-1");
    expect(commitment?.task).toBe("write the outline");
    expect(commitment?.startedAt).toBe("2026-06-06T12:00:00.000Z");
    expect(store.getPendingJobByKind("chat-1", CHECK_IN_KIND)?.dueAt).toBe("2026-06-06T13:00:00.000Z");

    scheduler.stop();
    store.close();
  });

  test("declared task stores deadline and caps next_checkin_at before it", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    const now = new Date("2026-06-06T12:00:00.000Z");
    applyProductDecision({
      config: testConfig(),
      now,
      response: {
        decision: {
          deadline: "2026-06-06T12:30:00.000Z",
          rung: "rung3_probe",
          status: "declared",
          task: "write the outline",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    const commitment = store.getActiveCommitment("chat-1");
    expect(commitment?.deadline).toBe("2026-06-06T12:30:00.000Z");
    expect(store.getPendingJobByKind("chat-1", CHECK_IN_KIND)?.dueAt).toBe("2026-06-06T12:25:00.000Z");

    scheduler.stop();
    store.close();
  });

  test("specificity needed records the daily nudge without creating a commitment", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:00:00.000Z"),
      response: {
        decision: {
          status: "specificity_needed",
          verify: "not_applicable",
        },
        messages: ["build what, king"],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.hasSpecificityNudge("chat-1", "2026-06-06")).toBe(true);
    expect(store.getActiveCommitment("chat-1")).toBeUndefined();

    scheduler.stop();
    store.close();
  });

  test("vague declarations are accepted after the nudge has been used", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    store.markSpecificityNudge("chat-1", "2026-06-06", new Date("2026-06-06T11:00:00.000Z"));

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:00:00.000Z"),
      response: {
        decision: {
          check_in_at: "2026-06-06T12:30:00.000Z",
          resolution: "vague",
          status: "declared",
          task: "build eod",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getActiveCommitment("chat-1")?.task).toBe("build eod");
    expect(store.getPendingJobByKind("chat-1", CHECK_IN_KIND)?.dueAt).toBe("2026-06-06T12:30:00.000Z");

    scheduler.stop();
    store.close();
  });

  test("good excuses cancel the active commitment", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const commitment = store.upsertActiveCommitment({
      now: new Date("2026-06-06T12:00:00.000Z"),
      spaceId: "chat-1",
      task: "write the outline",
    });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:10:00.000Z"),
      response: {
        decision: {
          excuse_until: "2026-06-06T15:00:00.000Z",
          status: "excused",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getCommitment(commitment.id)?.status).toBe("excused");
    expect(store.getActiveCommitment("chat-1")).toBeUndefined();

    scheduler.stop();
    store.close();
  });

  test("good excuses without a commitment stop the morning chase for the day", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:10:00.000Z"),
      response: {
        decision: {
          excuse_until: "2026-06-06T16:00:00.000Z",
          status: "excused",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getDayExcuse("chat-1", "2026-06-06")).toBe("2026-06-06T16:00:00.000Z");

    scheduler.stop();
    store.close();
  });

  test("canceled status deletes the active commitment", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const commitment = store.upsertActiveCommitment({
      now: new Date("2026-06-06T12:00:00.000Z"),
      spaceId: "chat-1",
      task: "write the outline",
    });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:10:00.000Z"),
      response: {
        decision: {
          status: "canceled",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getCommitment(commitment.id)?.status).toBe("canceled");
    expect(store.getActiveCommitment("chat-1")).toBeUndefined();

    scheduler.stop();
    store.close();
  });

  test("failed commitments create a capped charity penalty", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const commitment = store.upsertActiveCommitment({
      now: new Date("2026-06-06T12:00:00.000Z"),
      spaceId: "chat-1",
      task: "must do huge project",
    });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:30:00.000Z"),
      response: {
        decision: {
          penalty_amount_dollars: 25,
          status: "failed",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getCommitment(commitment.id)?.status).toBe("failed");
    expect(store.getPendingPenalty("chat-1")?.amountDollars).toBe(25);

    scheduler.stop();
    store.close();
  });

  test("penalty payments clear the pending penalty", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    store.createPenalty({
      amountDollars: 5,
      charityName: "Good Charity",
      now: new Date("2026-06-06T12:00:00.000Z"),
      reason: "miss",
      spaceId: "chat-1",
    });

    applyProductDecision({
      config: testConfig(),
      now: new Date("2026-06-06T12:30:00.000Z"),
      response: {
        decision: {
          penalty_paid: true,
          status: "none",
        },
        messages: [],
        reactions: [],
        schedules: [],
      },
      scheduler,
      spaceId: "chat-1",
      store,
    });

    expect(store.getPendingPenalty("chat-1")).toBeUndefined();

    scheduler.stop();
    store.close();
  });

  test("silence followups escalate to failed then stop", () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const commitment = store.upsertActiveCommitment({
      now: new Date("2026-06-06T12:00:00.000Z"),
      spaceId: "chat-1",
      task: "write the outline",
    });
    const first = store.createJob({
      spaceId: "chat-1",
      kind: `${SILENCE_KIND_PREFIX}1`,
      body: "king",
      dueAt: new Date("2026-06-06T13:00:00.000Z"),
      now: new Date("2026-06-06T12:30:00.000Z"),
    });

    afterScheduledJobSent({
      config: testConfig(),
      job: first,
      now: new Date("2026-06-06T13:00:00.000Z"),
      scheduler,
      store,
    });
    expect(store.getCommitment(commitment.id)?.silenceLevel).toBe(1);

    const second = store.getPendingJobByKind("chat-1", `${SILENCE_KIND_PREFIX}2`)!;
    afterScheduledJobSent({
      config: testConfig(),
      job: second,
      now: new Date("2026-06-06T13:30:00.000Z"),
      scheduler,
      store,
    });

    const third = store.getPendingJobByKind("chat-1", `${SILENCE_KIND_PREFIX}3`)!;
    afterScheduledJobSent({
      config: testConfig(),
      job: third,
      now: new Date("2026-06-06T14:00:00.000Z"),
      scheduler,
      store,
    });

    expect(store.getCommitment(commitment.id)?.status).toBe("failed");

    scheduler.stop();
    store.close();
  });
});

function testConfig() {
  return {
    botTimezone: "America/New_York",
    charityDonateUrl: "https://donate.example.test",
    charityMonthlyCapDollars: 50,
    charityName: "Good Charity",
    morningJitterMaxMinutes: 15,
    morningJitterMinMinutes: 5,
    morningNoonAnnoyanceIntervalMinutes: 30,
    morningTargetHour: 6,
    silenceFollowupAfterHour: 9,
    silenceFollowupDelayMinutes: 30,
  };
}

function randomSequence(values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}
