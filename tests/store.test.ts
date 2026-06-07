import { describe, expect, test } from "bun:test";
import { BotStore } from "../src/store";

describe("BotStore", () => {
  test("persists spaces, messages, attachments, and jobs", () => {
    const store = new BotStore(":memory:");
    const now = new Date("2026-06-06T12:00:00.000Z");

    const first = store.upsertSpace(
      { id: "chat-1", platform: "iMessage", kind: "dm", phone: "+15555550100" },
      now,
    );

    expect(first.isNew).toBe(true);
    expect(first.space.enabled).toBe(true);

    const second = store.upsertSpace(
      { id: "chat-1", platform: "iMessage", kind: "dm", phone: "+15555550100" },
      new Date("2026-06-06T12:01:00.000Z"),
    );

    expect(second.isNew).toBe(false);
    expect(store.getSpace("chat-1")?.lastSeenAt).toBe("2026-06-06T12:01:00.000Z");

    store.saveMessage({
      id: "msg-1",
      spaceId: "chat-1",
      platform: "iMessage",
      direction: "inbound",
      senderId: "me",
      contentType: "attachment",
      timestamp: now.toISOString(),
    });

    store.saveAttachment({
      id: "att-1",
      messageId: "msg-1",
      spaceId: "chat-1",
      name: "proof.jpg",
      mimeType: "image/jpeg",
      size: 123,
      readable: true,
      timestamp: now.toISOString(),
    });

    expect(store.getSpaceStats("chat-1")).toEqual({
      inboundCount: 1,
      attachmentCount: 1,
    });

    store.saveModelDecision({
      messageId: "msg-1",
      spaceId: "chat-1",
      rawJson: "{}",
      rung: "rung1_verifiable_picture",
      verify: "pass",
      createdAt: now.toISOString(),
    });

    const job = store.createJob({
      spaceId: "chat-1",
      kind: "test_poke",
      body: "poke",
      dueAt: new Date("2026-06-06T12:02:00.000Z"),
      now,
      payloadJson: "{\"ok\":true}",
    });

    expect(store.listDueJobs(new Date("2026-06-06T12:01:59.000Z"))).toHaveLength(0);
    expect(store.listDueJobs(new Date("2026-06-06T12:02:00.000Z"))).toHaveLength(1);
    expect(store.getNextPendingJob("chat-1")?.id).toBe(job.id);
    expect(store.getPendingJobByKind("chat-1", "test_poke")?.id).toBe(job.id);
    expect(store.getJob(job.id)?.kind).toBe("test_poke");
    expect(store.getJob(job.id)?.payloadJson).toBe("{\"ok\":true}");
    expect(store.getJob("non-existent-id")).toBeUndefined();
    expect(store.hasSpecificityNudge("chat-1", "2026-06-06")).toBe(false);
    store.markSpecificityNudge("chat-1", "2026-06-06", now);
    expect(store.hasSpecificityNudge("chat-1", "2026-06-06")).toBe(true);

    const commitment = store.upsertActiveCommitment({
      checkInAt: "2026-06-06T12:30:00.000Z",
      now,
      rung: "rung3_probe",
      spaceId: "chat-1",
      task: "write the outline",
    });
    expect(store.getActiveCommitment("chat-1")?.id).toBe(commitment.id);
    expect(store.incrementSilenceLevel(commitment.id, now)?.silenceLevel).toBe(1);
    store.setCommitmentStatus(commitment.id, "completed", now);
    expect(store.getActiveCommitment("chat-1")).toBeUndefined();

    store.saveLedgerSummary({
      now,
      spaceId: "chat-1",
      summary: "three weak probes, one completion",
    });
    expect(store.getLatestLedgerSummary("chat-1")?.summary).toBe("three weak probes, one completion");
    expect(store.listRecentCommitments("chat-1")).toHaveLength(1);
    expect(store.listRecentDecisions("chat-1")).toHaveLength(1);

    const penalty = store.createPenalty({
      amountDollars: 5,
      charityDonateUrl: "https://donate.example.test",
      charityName: "Good Charity",
      now,
      reason: "missed outline",
      spaceId: "chat-1",
    });
    expect(store.getPendingPenalty("chat-1")?.id).toBe(penalty.id);
    expect(store.monthlyPenaltyTotal("chat-1", "2026-06")).toBe(5);
    store.markPendingPenaltyPaid("chat-1", now);
    expect(store.getPendingPenalty("chat-1")).toBeUndefined();

    store.markJobSent(job.id, new Date("2026-06-06T12:03:00.000Z"));
    expect(store.listPendingJobs()).toHaveLength(0);

    store.close();
  });

  test("can disable a space and cancel pending jobs", () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });
    store.createJob({
      spaceId: "chat-1",
      kind: "test_poke",
      body: "poke",
      dueAt: new Date("2026-06-06T12:02:00.000Z"),
    });

    store.setSpaceEnabled("chat-1", false);
    store.cancelPendingJobsForSpace("chat-1");

    expect(store.getSpace("chat-1")?.enabled).toBe(false);
    expect(store.listPendingJobs()).toHaveLength(0);

    store.close();
  });

  test("listRecentMessages windows by time, caps, and returns chronological order", () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" });

    const base = new Date("2026-06-06T12:00:00.000Z").getTime();
    // one old message outside the window
    store.saveMessage({
      id: "old",
      spaceId: "chat-1",
      platform: "iMessage",
      direction: "inbound",
      contentType: "text",
      text: "ancient",
      timestamp: new Date(base - 48 * 60 * 60_000).toISOString(),
    });
    // 40 recent messages within the window, saved out of order
    for (let i = 39; i >= 0; i -= 1) {
      store.saveMessage({
        id: `m-${i}`,
        spaceId: "chat-1",
        platform: "iMessage",
        direction: i % 2 === 0 ? "inbound" : "outbound",
        contentType: "text",
        text: `msg ${i}`,
        timestamp: new Date(base - i * 60_000).toISOString(),
      });
    }

    const recent = store.listRecentMessages("chat-1", {
      since: new Date(base - 24 * 60 * 60_000),
      limit: 30,
    });

    expect(recent).toHaveLength(30);
    expect(recent.some((m) => m.id === "old")).toBe(false);
    // chronological order: oldest first
    const times = recent.map((m) => new Date(m.timestamp).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    // newest message is the last one and is included
    expect(recent[recent.length - 1]?.id).toBe("m-0");

    store.close();
  });
});
