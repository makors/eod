export type BotConfig = {
  aiApiKey: string;
  aiBaseUrl: string;
  aiMaxImageBytes: number;
  aiModel: string;
  aiTemperature: number;
  aiTimeoutMs: number;
  botTimezone: string;
  charityDonateUrl: string;
  charityMonthlyCapDollars: number;
  charityName: string;
  dbPath: string;
  morningJitterMaxMinutes: number;
  morningJitterMinMinutes: number;
  morningNoonAnnoyanceIntervalMinutes: number;
  morningTargetHour: number;
  schoolDays: number[];
  schoolEndHour: number;
  schoolStartHour: number;
  projectId: string;
  projectSecret: string;
  silenceFollowupAfterHour: number;
  silenceFollowupDelayMinutes: number;
  testPokeDelaySeconds: number;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): BotConfig {
  const projectId = requiredEnv(env, "PROJECT_ID");
  const projectSecret = requiredEnv(env, "PROJECT_SECRET");
  const aiBaseUrl = requiredEnv(env, "AI_BASE_URL").replace(/\/+$/u, "");
  const aiApiKey = requiredEnv(env, "AI_API_KEY");
  const aiModel = requiredEnv(env, "AI_MODEL");
  const charityName = env.CHARITY_NAME?.trim() || "the charity jar";
  const charityDonateUrl = env.CHARITY_DONATE_URL?.trim() || "";
  const morningJitterMinMinutes = parsePositiveInt(
    env.MORNING_JITTER_MIN_MINUTES,
    10,
    "MORNING_JITTER_MIN_MINUTES",
  );
  const morningJitterMaxMinutes = parsePositiveInt(
    env.MORNING_JITTER_MAX_MINUTES,
    10,
    "MORNING_JITTER_MAX_MINUTES",
  );
  if (morningJitterMinMinutes > morningJitterMaxMinutes) {
    throw new Error("MORNING_JITTER_MIN_MINUTES must be less than or equal to MORNING_JITTER_MAX_MINUTES");
  }
  const testPokeDelaySeconds = parsePositiveInt(
    env.TEST_POKE_DELAY_SECONDS,
    60,
    "TEST_POKE_DELAY_SECONDS",
  );

  return {
    aiApiKey,
    aiBaseUrl,
    aiMaxImageBytes: parsePositiveInt(env.AI_MAX_IMAGE_BYTES, 6_000_000, "AI_MAX_IMAGE_BYTES"),
    aiModel,
    aiTemperature: parseNumber(env.AI_TEMPERATURE, 0.4, "AI_TEMPERATURE"),
    aiTimeoutMs: parsePositiveInt(env.AI_TIMEOUT_MS, 30_000, "AI_TIMEOUT_MS"),
    botTimezone: env.BOT_TIMEZONE?.trim() || "America/New_York",
    charityDonateUrl,
    charityMonthlyCapDollars: parsePositiveInt(env.CHARITY_MONTHLY_CAP_DOLLARS, 50, "CHARITY_MONTHLY_CAP_DOLLARS"),
    charityName,
    dbPath: env.BOT_DB_PATH?.trim() || "./eod.sqlite",
    morningJitterMaxMinutes,
    morningJitterMinMinutes,
    morningNoonAnnoyanceIntervalMinutes: parsePositiveInt(
      env.MORNING_NOON_ANNOYANCE_INTERVAL_MINUTES,
      30,
      "MORNING_NOON_ANNOYANCE_INTERVAL_MINUTES",
    ),
    morningTargetHour: parseHour(env.MORNING_TARGET_HOUR, 6, "MORNING_TARGET_HOUR"),
    projectId,
    projectSecret,
    schoolDays: parseSchoolDays(env.SCHOOL_DAYS),
    schoolEndHour: parseHour(env.SCHOOL_END_HOUR, 15, "SCHOOL_END_HOUR"),
    schoolStartHour: parseHour(env.SCHOOL_START_HOUR, 8, "SCHOOL_START_HOUR"),
    silenceFollowupAfterHour: parseHour(env.SILENCE_FOLLOWUP_AFTER_HOUR, 9, "SILENCE_FOLLOWUP_AFTER_HOUR"),
    silenceFollowupDelayMinutes: parsePositiveInt(
      env.SILENCE_FOLLOWUP_DELAY_MINUTES,
      30,
      "SILENCE_FOLLOWUP_DELAY_MINUTES",
    ),
    testPokeDelaySeconds,
  };
}

function requiredEnv(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInt(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number`);
  }

  return parsed;
}

function parseHour(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  if (parsed < 0 || parsed > 23) {
    throw new Error(`${name} must be between 0 and 23`);
  }
  return parsed;
}

function parseSchoolDays(value: string | undefined): number[] {
  if (!value?.trim()) {
    return [1, 2, 3, 4, 5];
  }

  const aliases: Record<string, number> = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
  };

  return value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map((part) => {
      const numeric = Number(part);
      if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 6) {
        return numeric;
      }
      const aliased = aliases[part];
      if (aliased === undefined) {
        throw new Error("SCHOOL_DAYS must contain weekdays like mon,tue or numbers 0-6");
      }
      return aliased;
    });
}
