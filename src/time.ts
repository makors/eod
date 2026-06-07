export function localNowDescription(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
    timeZoneName: "short",
  }).format(date);
}

export function localTimeTag(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).format(date);
}

export function dateKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

export function monthKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad(parts.month)}`;
}

export function localDayAndHour(date: Date, timeZone: string): { day: number; hour: number } {
  const parts = zonedParts(date, timeZone);
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(date);
  const days: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return { day: days[day] ?? 0, hour: parts.hour };
}

export function nextMorningWake(input: {
  jitterMaxMinutes: number;
  jitterMinMinutes: number;
  now: Date;
  random?: () => number;
  targetHour: number;
  timeZone: string;
}): Date {
  const random = input.random ?? Math.random;
  const nowParts = zonedParts(input.now, input.timeZone);
  const todayTarget = zonedTimeToUtc({
    day: nowParts.day,
    hour: input.targetHour,
    minute: 0,
    month: nowParts.month,
    second: 0,
    timeZone: input.timeZone,
    year: nowParts.year,
  });
  const targetBase =
    input.now.getTime() < todayTarget.getTime()
      ? todayTarget
      : addZonedDays(todayTarget, 1, input.timeZone);

  const jitterRange = input.jitterMaxMinutes - input.jitterMinMinutes + 1;
  const jitterMinutes = input.jitterMinMinutes + Math.floor(random() * jitterRange);
  const sign = random() < 0.5 ? -1 : 1;

  return new Date(targetBase.getTime() + sign * jitterMinutes * 60_000);
}

export function silenceFollowupDueAt(input: {
  afterHour: number;
  delayMinutes: number;
  now: Date;
  timeZone: string;
}): Date {
  const delayed = new Date(input.now.getTime() + input.delayMinutes * 60_000);
  const parts = zonedParts(input.now, input.timeZone);
  const floor = zonedTimeToUtc({
    day: parts.day,
    hour: input.afterHour,
    minute: 0,
    month: parts.month,
    second: 0,
    timeZone: input.timeZone,
    year: parts.year,
  });

  return delayed.getTime() > floor.getTime() ? delayed : floor;
}

export function localTimeForDateKey(input: {
  date: string;
  hour: number;
  minute?: number;
  second?: number;
  timeZone: string;
}): Date {
  const [year, month, day] = input.date.split("-").map(Number);
  return zonedTimeToUtc({
    day: day ?? 1,
    hour: input.hour,
    minute: input.minute ?? 0,
    month: month ?? 1,
    second: input.second ?? 0,
    timeZone: input.timeZone,
    year: year ?? 1970,
  });
}

function addZonedDays(date: Date, days: number, timeZone: string): Date {
  const parts = zonedParts(date, timeZone);
  const noon = zonedTimeToUtc({
    ...parts,
    hour: 12,
    minute: 0,
    second: 0,
    timeZone,
  });
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000);
  const shiftedParts = zonedParts(shifted, timeZone);
  return zonedTimeToUtc({
    day: shiftedParts.day,
    hour: parts.hour,
    minute: parts.minute,
    month: shiftedParts.month,
    second: parts.second,
    timeZone,
    year: shiftedParts.year,
  });
}

function zonedTimeToUtc(input: {
  day: number;
  hour: number;
  minute: number;
  month: number;
  second: number;
  timeZone: string;
  year: number;
}): Date {
  const guess = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, input.second));
  const offset = timeZoneOffsetMs(guess, input.timeZone);
  return new Date(guess.getTime() - offset);
}

function zonedParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone,
    year: "numeric",
  });

  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    day: Number(parts.day),
    hour: Number(parts.hour === "24" ? "0" : parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    year: Number(parts.year),
  };
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  });
  const value = formatter.formatToParts(date).find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  const match = value.match(/^GMT(?:(?<sign>[+-])(?<hours>\d{1,2})(?::(?<minutes>\d{2}))?)?$/u);
  if (!match?.groups) {
    return 0;
  }

  const sign = match.groups.sign === "-" ? -1 : 1;
  const hours = Number(match.groups.hours ?? 0);
  const minutes = Number(match.groups.minutes ?? 0);
  return sign * (hours * 60 + minutes) * 60_000;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
