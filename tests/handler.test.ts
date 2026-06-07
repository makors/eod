import { describe, expect, test } from "bun:test";
import { CHECK_IN_KIND } from "../src/brain";
import { applyAiResponse, handleInbound } from "../src/handler";
import { Scheduler } from "../src/scheduler";
import { BotStore } from "../src/store";

describe("handleInbound", () => {
  test("shows a typing indicator while processing AI turns", async () => {
    const store = new BotStore(":memory:");
    const scheduler = new Scheduler(store, async () => "sent");
    const events: string[] = [];

    await handleInbound({
      ai: {
        respond: async () => {
          events.push("ai");
          return {
            messages: ["answer"],
            reactions: [],
            schedules: [],
          };
        },
      } as any,
      config: testConfig(),
      message: {
        id: "msg-typing",
        content: { type: "text", text: "help me decide" },
        direction: "inbound",
        platform: "iMessage",
        sender: { id: "person-1" },
        timestamp: new Date("2026-06-06T12:00:00.000Z"),
      } as any,
      scheduler,
      space: {
        __platform: "iMessage",
        id: "chat-typing",
        responding: async (fn: () => Promise<void>) => {
          events.push("start");
          await fn();
          events.push("stop");
        },
        send: async (text: string) => {
          events.push(`send:${text}`);
        },
      } as any,
      store,
    });

    expect(events).toEqual(["start", "ai", "send:answer", "stop"]);

    scheduler.stop();
    store.close();
  });
});

describe("applyAiResponse", () => {
  test("executes model actions", async () => {
    const store = new BotStore(":memory:");
    store.upsertSpace({ id: "chat-1", platform: "iMessage" }, new Date("2026-06-06T12:00:00.000Z"));
    store.saveMessage({
      id: "msg-1",
      spaceId: "chat-1",
      platform: "iMessage",
      direction: "inbound",
      contentType: "text",
      text: "done",
      timestamp: "2026-06-06T12:00:00.000Z",
    });

    const sent: string[] = [];
    const reactions: string[] = [];
    const scheduler = new Scheduler(store, async () => "sent");

    await applyAiResponse(
      {
        message: {
          id: "msg-1",
          platform: "iMessage",
          react: async (emoji: string) => {
            reactions.push(emoji);
          },
        } as any,
        config: testConfig(),
        scheduler,
        space: {
          send: async (text: string) => {
            sent.push(text);
          },
        } as any,
        store,
      },
      {
        decision: {
          rung: "rung1_verifiable_picture",
          status: "declared",
          verify: "needs_more",
          check_in_at: "2026-06-06T12:30:00.000Z",
          task: "walk",
        },
        messages: ["nice\nlogged"],
        reactions: [{ emoji: "✅" }],
        schedules: [{ delay_minutes: 30, kind: "check_in", message: "prove the next bit" }],
      },
      "chat-1",
      new Date("2026-06-06T12:00:00.000Z"),
    );

    expect(sent).toEqual(["nice\nlogged"]);
    expect(reactions).toEqual(["✅"]);
    const checkIn = store.getPendingJobByKind("chat-1", CHECK_IN_KIND);
    expect(checkIn?.body).toContain("walk");

    // outbound reply text is persisted so it can be replayed as history
    const history = store.listRecentMessages("chat-1", {
      since: new Date("2026-06-05T12:00:00.000Z"),
    });
    const outbound = history.filter((m) => m.direction === "outbound");
    expect(outbound).toHaveLength(1);
    expect(outbound[0]?.text).toBe("nice\nlogged");

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
    schoolDays: [1, 2, 3, 4, 5],
    schoolEndHour: 15,
    schoolStartHour: 8,
    silenceFollowupAfterHour: 9,
    silenceFollowupDelayMinutes: 30,
    testPokeDelaySeconds: 1,
  };
}
