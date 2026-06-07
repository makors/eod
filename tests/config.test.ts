import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

describe("loadConfig", () => {
  test("loads required and default values", () => {
    const config = loadConfig({
      AI_API_KEY: "key",
      AI_BASE_URL: "https://api.example.test/v1/",
      AI_MODEL: "model",
      PROJECT_ID: "project",
      PROJECT_SECRET: "secret",
    });

    expect(config).toEqual({
      aiApiKey: "key",
      aiBaseUrl: "https://api.example.test/v1",
      aiMaxImageBytes: 6000000,
      aiModel: "model",
      aiTemperature: 0.4,
      aiTimeoutMs: 30000,
      botTimezone: "America/New_York",
      charityDonateUrl: "",
      charityMonthlyCapDollars: 50,
      charityName: "the charity jar",
      dbPath: "./eod.sqlite",
      morningJitterMaxMinutes: 10,
      morningJitterMinMinutes: 10,
      morningNoonAnnoyanceIntervalMinutes: 30,
      morningTargetHour: 6,
      projectId: "project",
      projectSecret: "secret",
      schoolDays: [1, 2, 3, 4, 5],
      schoolEndHour: 15,
      schoolStartHour: 8,
      silenceFollowupAfterHour: 9,
      silenceFollowupDelayMinutes: 30,
      testPokeDelaySeconds: 60,
    });
  });

  test("loads optional values", () => {
    const config = loadConfig({
      AI_API_KEY: "key",
      AI_BASE_URL: "https://api.example.test/v1",
      AI_MAX_IMAGE_BYTES: "1234",
      AI_MODEL: "model",
      AI_TEMPERATURE: "0.2",
      AI_TIMEOUT_MS: "5000",
      BOT_DB_PATH: "/tmp/bot.sqlite",
      BOT_TIMEZONE: "America/Los_Angeles",
      CHARITY_DONATE_URL: "https://donate.example.test",
      CHARITY_MONTHLY_CAP_DOLLARS: "25",
      CHARITY_NAME: "Good Charity",
      MORNING_JITTER_MAX_MINUTES: "12",
      MORNING_JITTER_MIN_MINUTES: "7",
      MORNING_NOON_ANNOYANCE_INTERVAL_MINUTES: "20",
      MORNING_TARGET_HOUR: "5",
      PROJECT_ID: "project",
      PROJECT_SECRET: "secret",
      SCHOOL_DAYS: "mon,wed,fri",
      SCHOOL_END_HOUR: "14",
      SCHOOL_START_HOUR: "7",
      SILENCE_FOLLOWUP_AFTER_HOUR: "10",
      SILENCE_FOLLOWUP_DELAY_MINUTES: "45",
      TEST_POKE_DELAY_SECONDS: "5",
    });

    expect(config.dbPath).toBe("/tmp/bot.sqlite");
    expect(config.botTimezone).toBe("America/Los_Angeles");
    expect(config.aiMaxImageBytes).toBe(1234);
    expect(config.aiTemperature).toBe(0.2);
    expect(config.aiTimeoutMs).toBe(5000);
    expect(config.charityDonateUrl).toBe("https://donate.example.test");
    expect(config.charityMonthlyCapDollars).toBe(25);
    expect(config.charityName).toBe("Good Charity");
    expect(config.morningJitterMaxMinutes).toBe(12);
    expect(config.morningJitterMinMinutes).toBe(7);
    expect(config.morningNoonAnnoyanceIntervalMinutes).toBe(20);
    expect(config.morningTargetHour).toBe(5);
    expect(config.schoolDays).toEqual([1, 3, 5]);
    expect(config.schoolEndHour).toBe(14);
    expect(config.schoolStartHour).toBe(7);
    expect(config.silenceFollowupAfterHour).toBe(10);
    expect(config.silenceFollowupDelayMinutes).toBe(45);
    expect(config.testPokeDelaySeconds).toBe(5);
  });

  test("rejects missing credentials", () => {
    expect(() => loadConfig({ PROJECT_SECRET: "secret" })).toThrow("PROJECT_ID is required");
    expect(() => loadConfig({ PROJECT_ID: "project" })).toThrow("PROJECT_SECRET is required");
    expect(() => loadConfig({ PROJECT_ID: "project", PROJECT_SECRET: "secret" })).toThrow(
      "AI_BASE_URL is required",
    );
  });

  test("rejects invalid test poke delay", () => {
    expect(() =>
      loadConfig({
        AI_API_KEY: "key",
        AI_BASE_URL: "https://api.example.test/v1",
        AI_MODEL: "model",
        PROJECT_ID: "project",
        PROJECT_SECRET: "secret",
        TEST_POKE_DELAY_SECONDS: "0",
      }),
    ).toThrow("TEST_POKE_DELAY_SECONDS must be a positive integer");
  });
});
