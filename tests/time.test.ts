import { describe, expect, test } from "bun:test";
import { nextMorningWake, silenceFollowupDueAt } from "../src/time";

describe("time helpers", () => {
  test("schedules next morning wake around 6 with jitter", () => {
    const dueAt = nextMorningWake({
      jitterMaxMinutes: 15,
      jitterMinMinutes: 5,
      now: new Date("2026-06-06T04:00:00.000Z"),
      random: randomSequence([0, 0]),
      targetHour: 6,
      timeZone: "America/New_York",
    });

    expect(dueAt.toISOString()).toBe("2026-06-06T09:55:00.000Z");
  });

  test("silence followup waits until 9 if delay lands earlier", () => {
    const dueAt = silenceFollowupDueAt({
      afterHour: 9,
      delayMinutes: 30,
      now: new Date("2026-06-06T12:15:00.000Z"),
      timeZone: "America/New_York",
    });

    expect(dueAt.toISOString()).toBe("2026-06-06T13:00:00.000Z");
  });
});

function randomSequence(values: number[]) {
  let index = 0;
  return () => values[index++] ?? 0;
}
