import { describe, expect, test } from "bun:test";
import { Scheduler, type SendJobResult } from "../src/scheduler";
import { BotStore, type ScheduledJob } from "../src/store";

describe("Scheduler", () => {
  test("sends due enabled jobs", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const sent: ScheduledJob[] = [];
    const scheduler = new Scheduler(store, async (job) => {
      sent.push(job);
      return "sent";
    });

    const job = scheduler.schedule({
      spaceId: "chat-1",
      kind: "test_poke",
      body: "poke",
      dueAt: new Date("2026-06-06T12:00:00.000Z"),
      now: new Date("2026-06-06T11:59:00.000Z"),
    });

    await scheduler.runDue(new Date("2026-06-06T12:00:00.000Z"));

    expect(sent.map((candidate) => candidate.id)).toEqual([job.id]);
    expect(store.listPendingJobs()).toHaveLength(0);

    scheduler.stop();
    store.close();
  });

  test("cancels due jobs for disabled spaces", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    store.setSpaceEnabled("chat-1", false);
    const scheduler = new Scheduler(store, async () => "sent");

    scheduler.schedule({
      spaceId: "chat-1",
      kind: "test_poke",
      body: "poke",
      dueAt: new Date("2026-06-06T12:00:00.000Z"),
    });

    await scheduler.runDue(new Date("2026-06-06T12:00:00.000Z"));

    expect(store.listPendingJobs()).toHaveLength(0);

    scheduler.stop();
    store.close();
  });

  test("keeps deferred jobs pending", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const results: SendJobResult[] = ["defer"];
    const scheduler = new Scheduler(
      store,
      async () => results.shift() ?? "sent",
      { retryDelayMs: 1_000 },
    );

    scheduler.schedule({
      spaceId: "chat-1",
      kind: "test_poke",
      body: "poke",
      dueAt: new Date("2026-06-06T12:00:00.000Z"),
    });

    await scheduler.runDue(new Date("2026-06-06T12:00:00.000Z"));

    expect(store.listPendingJobs()).toHaveLength(1);

    scheduler.stop();
    store.close();
  });

  test("coalesces overdue morning jobs on restart", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const sent: ScheduledJob[] = [];
    const scheduler = new Scheduler(
      store,
      async (job) => {
        sent.push(job);
        return "sent";
      },
      { logger: silentLogger() },
    );

    store.createJob({
      spaceId: "chat-1",
      kind: "morning_wake:2026-06-06",
      body: "wake",
      dueAt: new Date("2026-06-06T10:00:00.000Z"),
      now: new Date("2026-06-06T09:00:00.000Z"),
    });
    store.createJob({
      spaceId: "chat-1",
      kind: "morning_followup:2026-06-06:8",
      body: "8",
      dueAt: new Date("2026-06-06T12:00:00.000Z"),
      now: new Date("2026-06-06T09:00:00.000Z"),
    });
    store.createJob({
      spaceId: "chat-1",
      kind: "morning_followup:2026-06-06:9",
      body: "9",
      dueAt: new Date("2026-06-06T13:00:00.000Z"),
      now: new Date("2026-06-06T09:00:00.000Z"),
    });
    store.createJob({
      spaceId: "chat-1",
      kind: "morning_noon:2026-06-06:1",
      body: "noon",
      dueAt: new Date("2026-06-06T16:00:00.000Z"),
      now: new Date("2026-06-06T09:00:00.000Z"),
    });

    await scheduler.runDue(new Date("2026-06-06T17:00:00.000Z"));

    expect(sent.map((job) => job.kind)).toEqual(["morning_noon:2026-06-06:1"]);
    expect(store.listPendingJobs()).toHaveLength(0);

    scheduler.stop();
    store.close();
  });

  test("skips jobs canceled by an earlier due job in the same run", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const sent: string[] = [];
    let secondId = "";
    const scheduler = new Scheduler(
      store,
      async (job) => {
        sent.push(job.kind);
        if (job.kind === "first") {
          store.markJobCanceled(secondId);
        }
        return "sent";
      },
      { logger: silentLogger() },
    );

    store.createJob({
      spaceId: "chat-1",
      kind: "first",
      body: "first",
      dueAt: new Date("2026-06-06T12:00:00.000Z"),
    });
    secondId = store.createJob({
      spaceId: "chat-1",
      kind: "second",
      body: "second",
      dueAt: new Date("2026-06-06T12:01:00.000Z"),
    }).id;

    await scheduler.runDue(new Date("2026-06-06T12:02:00.000Z"));

    expect(sent).toEqual(["first"]);

    scheduler.stop();
    store.close();
  });

  test("dedupes future duplicate jobs before arming timers", () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const scheduler = new Scheduler(store, async () => "sent", { logger: silentLogger() });

    store.createJob({
      spaceId: "chat-1",
      kind: "morning_noon:2030-06-06:2",
      body: "first",
      dueAt: new Date("2030-06-06T23:31:47.534Z"),
      now: new Date("2030-06-06T23:01:47.534Z"),
    });
    store.createJob({
      spaceId: "chat-1",
      kind: "morning_noon:2030-06-06:2",
      body: "duplicate",
      dueAt: new Date("2030-06-06T23:32:20.067Z"),
      now: new Date("2030-06-06T23:02:20.067Z"),
    });

    scheduler.start();

    const remaining = store
      .listPendingJobs()
      .filter((job) => job.kind === "morning_noon:2030-06-06:2");
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.body).toBe("first");

    scheduler.stop();
    store.close();
  });

  test("cancels stale legacy morning noon jobs before arming timers", () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    const scheduler = new Scheduler(store, async () => "sent", { logger: silentLogger() });

    store.createJob({
      spaceId: "chat-1",
      kind: "morning_noon",
      body: "legacy",
      dueAt: new Date("2030-06-07T23:01:45.219Z"),
      now: new Date("2030-06-06T23:01:45.219Z"),
    });

    scheduler.start();

    expect(store.listPendingJobs().filter((job) => job.kind === "morning_noon")).toHaveLength(0);

    scheduler.stop();
    store.close();
  });
});

function silentLogger() {
  return {
    error: () => {},
    log: () => {},
    warn: () => {},
  };
}
