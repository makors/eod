import { describe, expect, test } from "bun:test";
import { charityContext, schoolContext, trajectoryContext } from "../src/context";
import { BotStore } from "../src/store";

describe("context helpers", () => {
  test("computes school context from configured days and hours", () => {
    const config = testConfig();

    expect(schoolContext(config, new Date("2026-06-08T14:00:00.000Z"))).toMatchObject({
      is_school_day: true,
      is_school_time: true,
      local_day: 1,
      local_hour: 10,
    });
    expect(schoolContext(config, new Date("2026-06-06T14:00:00.000Z")).is_school_day).toBe(false);
  });

  test("computes charity and trajectory context", () => {
    const store = new BotStore(":memory:");
    const config = testConfig();
    const space = store.upsertSpace({ id: "chat-1", platform: "iMessage" }).space;
    store.createPenalty({
      amountDollars: 10,
      charityName: "Good Charity",
      now: new Date("2026-06-06T12:00:00.000Z"),
      reason: "miss",
      spaceId: "chat-1",
    });
    store.upsertActiveCommitment({
      now: new Date("2026-06-06T12:00:00.000Z"),
      spaceId: "chat-1",
      task: "outline",
    });

    expect(charityContext(config, store, space, new Date("2026-06-06T12:00:00.000Z"))).toMatchObject({
      monthly_cap_dollars: 50,
      monthly_remaining_dollars: 40,
    });
    expect(trajectoryContext(store, "chat-1").recent_commitments).toHaveLength(1);

    store.close();
  });
});

function testConfig() {
  return {
    botTimezone: "America/New_York",
    charityDonateUrl: "https://donate.example.test",
    charityMonthlyCapDollars: 50,
    charityName: "Good Charity",
    schoolDays: [1, 2, 3, 4, 5],
    schoolEndHour: 15,
    schoolStartHour: 8,
  };
}
