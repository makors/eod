import { describe, expect, test } from "bun:test";
import { historyTurns, parseAiResponse } from "../src/ai";
import type { MessageRecord } from "../src/store";

describe("historyTurns", () => {
  const tz = "America/New_York";
  const userText = (turn: unknown): string =>
    (turn as { content: Array<{ text: string }> }).content[0]!.text;
  const rec = (over: Partial<MessageRecord> & Pick<MessageRecord, "id" | "direction" | "timestamp">): MessageRecord => ({
    spaceId: "chat-1",
    platform: "iMessage",
    contentType: "text",
    ...over,
  });

  test("maps direction to roles, prefixes timestamps, excludes current and markers", () => {
    const turns = historyTurns(
      [
        rec({ id: "a", direction: "inbound", text: "gonna finish the essay", timestamp: "2026-06-06T13:12:00.000Z" }),
        rec({ id: "b", direction: "outbound", text: "lock it in king", timestamp: "2026-06-06T13:13:00.000Z" }),
        rec({ id: "evt", direction: "outbound", contentType: "scheduled_event", text: "noon:...", timestamp: "2026-06-06T16:00:00.000Z" }),
        rec({ id: "current", direction: "inbound", text: "done", timestamp: "2026-06-06T17:40:00.000Z" }),
      ],
      tz,
      { excludeId: "current" },
    );

    // current message and scheduled_event marker are dropped
    expect(turns).toHaveLength(2);
    expect(turns[0]?.role).toBe("user");
    expect(turns[1]?.role).toBe("assistant");

    const firstUser = userText(turns[0]);
    expect(firstUser).toContain("gonna finish the essay");
    expect(firstUser).toMatch(/^\[/); // has a time tag prefix
    expect(turns[1]).toEqual({ role: "assistant", content: expect.stringContaining("lock it in king") });
  });

  test("inserts a gap marker after a long silence", () => {
    const turns = historyTurns(
      [
        rec({ id: "a", direction: "inbound", text: "morning", timestamp: "2026-06-06T13:00:00.000Z" }),
        rec({ id: "b", direction: "inbound", text: "back now", timestamp: "2026-06-06T18:00:00.000Z" }),
      ],
      tz,
    );

    expect(userText(turns[1])).toContain("since last message");
    expect(userText(turns[0])).not.toContain("since last message");
  });

  test("returns empty for no history", () => {
    expect(historyTurns(undefined, tz)).toEqual([]);
    expect(historyTurns([], tz)).toEqual([]);
  });
});

describe("parseAiResponse", () => {
  test("normalizes messages, reactions, schedules, and decisions", () => {
    const response = parseAiResponse(
      JSON.stringify({
        messages: [{ text: "OK. \nShow me the thing." }],
        reactions: [{ emoji: "👍" }, "🔥"],
        schedules: [{ delay_minutes: 25, kind: "check_in", message: "Report back." }],
        decision: {
          rung: "rung1_verifiable_picture",
          verify: "pass",
          check_in_at: "2026-06-06T12:25:00.000Z",
          task: "walk",
          note: "fresh image looked plausible",
        },
      }),
    );

    expect(response.messages).toEqual(["ok\nshow me the thing"]);
    expect(response.reactions).toEqual([{ emoji: "👍" }, { emoji: "🔥" }]);
    expect(response.schedules).toEqual([
      { delay_minutes: 25, kind: "check_in", message: "report back" },
    ]);
    expect(response.decision?.rung).toBe("rung1_verifiable_picture");
    expect(response.decision?.verify).toBe("pass");
  });

  test("extracts json from messy compatible responses", () => {
    const response = parseAiResponse('```json\n{"messages":["HELLO."]}\n```');

    expect(response.messages).toEqual(["hello"]);
    expect(response.reactions).toEqual([]);
    expect(response.schedules).toEqual([]);
  });

  test("parses declaration resolution decisions", () => {
    const response = parseAiResponse(
      JSON.stringify({
        decision: {
          status: "specificity_needed",
          resolution: "vague",
          verify: "not_applicable",
        },
        messages: ["build what, king"],
      }),
    );

    expect(response.decision?.status).toBe("specificity_needed");
    expect(response.decision?.resolution).toBe("vague");
    expect(response.messages).toEqual(["build what, king"]);
  });
});
