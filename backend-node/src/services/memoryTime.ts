export type CalendarGranularity = "week" | "month" | "quarter" | "year";

export interface CalendarBucket {
  granularity: CalendarGranularity;
  bucketKey: string;
  periodStart: Date;
  periodEnd: Date;
}

/**
 * Display timezone for every UI-facing "day" key and daily aggregation.
 * Mirrors Python `core/common/display_tz.py`: env override first, then the
 * configured default. The system timezone is deliberately NOT used here.
 */
export const DEFAULT_DISPLAY_TIMEZONE = "Asia/Shanghai";

export function displayTimeZone(): string {
  return (process.env.LINGSHU_DISPLAY_TIMEZONE || "").trim() || DEFAULT_DISPLAY_TIMEZONE;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function utcParts(date: Date): ZonedParts {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return {
    year,
    month,
    day,
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    weekday: date.getUTCDay(),
  };
}

/** Wall-clock parts of an absolute instant in the display timezone. */
export function zonedParts(date: Date, timeZone: string = displayTimeZone()): ZonedParts {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(date);
    const read = (type: string) => {
      const found = parts.find((part) => part.type === type);
      return Number(found?.value || 0);
    };
    const year = read("year");
    const month = read("month");
    const day = read("day");
    let hour = read("hour");
    if (hour === 24) hour = 0;
    return {
      year,
      month,
      day,
      hour,
      minute: read("minute"),
      second: read("second"),
      weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    };
  } catch {
    // Invalid timezone name: retry with the configured default, then fall back
    // to UTC. Never consult the host timezone (requirement: display tz only).
    if (timeZone !== DEFAULT_DISPLAY_TIMEZONE) {
      return zonedParts(date, DEFAULT_DISPLAY_TIMEZONE);
    }
    return utcParts(date);
  }
}

/** Convert a wall-clock reading in `timeZone` to an absolute instant (DST-safe). */
export function wallTimeToUtc(parts: ZonedParts, timeZone: string = displayTimeZone()): Date {
  const target = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour || 0,
    parts.minute || 0,
    parts.second || 0,
  );
  let guess = target;
  for (let index = 0; index < 3; index += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualMs = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const diff = target - actualMs;
    if (!diff) break;
    guess += diff;
  }
  return new Date(guess);
}

export interface DayWindow {
  day: string;
  startIso: string;
  endIso: string;
  createdAt: string;
}

/** Validate `YYYY-MM-DD` and return its display-timezone day bounds (UTC ISO). */
export function dayWindow(day: string, timeZone: string = displayTimeZone()): DayWindow {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day ?? "").trim());
  if (!match) throw new Error("invalid_day");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const date = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, date));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== date
  ) {
    throw new Error("invalid_day");
  }
  const base = { year, month, day: date, minute: 0, second: 0, weekday: 0 };
  const start = wallTimeToUtc({ ...base, hour: 0 }, timeZone);
  const end = wallTimeToUtc({ ...base, day: date + 1, hour: 0 }, timeZone);
  const noon = wallTimeToUtc({ ...base, hour: 12 }, timeZone);
  return {
    day: `${year}-${pad2(month)}-${pad2(date)}`,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
    createdAt: noon.toISOString(),
  };
}

/** Display-timezone bounds of a calendar month plus its day count. */
export function monthBounds(
  year: number,
  month: number,
  timeZone: string = displayTimeZone(),
): { startIso: string; endIso: string; days: number } {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("invalid_month");
  }
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    startIso: dayWindow(`${year}-${pad2(month)}-01`, timeZone).startIso,
    endIso: dayWindow(`${nextYear}-${pad2(nextMonth)}-01`, timeZone).startIso,
    days: new Date(Date.UTC(year, month, 0)).getUTCDate(),
  };
}

function zonedStart(
  year: number,
  month: number,
  day: number,
  timeZone: string = displayTimeZone(),
): Date {
  return wallTimeToUtc(
    { year, month, day, hour: 0, minute: 0, second: 0, weekday: 0 },
    timeZone,
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** ISO week for calendar parts (independent of the host timezone). */
function isoWeekFromParts(parts: ZonedParts): { year: number; week: number } {
  const target = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const year = target.getUTCFullYear();
  const yearStart = Date.UTC(year, 0, 1);
  const week = Math.ceil(((target.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year, week };
}

export function isoWeekParts(date: Date): { year: number; week: number } {
  return isoWeekFromParts(zonedParts(date));
}

function isoWeekStart(year: number, week: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const day = jan4.getUTCDay() || 7;
  const monday = new Date(Date.UTC(year, 0, 4 - (day - 1)));
  monday.setUTCDate(monday.getUTCDate() + (week - 1) * 7);
  return zonedStart(monday.getUTCFullYear(), monday.getUTCMonth() + 1, monday.getUTCDate());
}

function addDays(date: Date, days: number): Date {
  const parts = zonedParts(date);
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return zonedStart(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

function bucketFromParts(
  granularity: CalendarGranularity,
  year: number,
  part?: number,
): CalendarBucket {
  let start: Date;
  let nextStart: Date;
  let key: string;
  if (granularity === "week") {
    if (!part || part < 1 || part > 53) throw new Error("invalid_bucket_key");
    start = isoWeekStart(year, part);
    nextStart = addDays(start, 7);
    key = `${year}-W${pad2(part)}`;
  } else if (granularity === "month") {
    if (!part || part < 1 || part > 12) throw new Error("invalid_bucket_key");
    start = zonedStart(year, part, 1);
    nextStart = part === 12 ? zonedStart(year + 1, 1, 1) : zonedStart(year, part + 1, 1);
    key = `${year}-${pad2(part)}`;
  } else if (granularity === "quarter") {
    if (!part || part < 1 || part > 4) throw new Error("invalid_bucket_key");
    start = zonedStart(year, (part - 1) * 3 + 1, 1);
    nextStart = part === 4 ? zonedStart(year + 1, 1, 1) : zonedStart(year, part * 3 + 1, 1);
    key = `${year}-Q${part}`;
  } else {
    start = zonedStart(year, 1, 1);
    nextStart = zonedStart(year + 1, 1, 1);
    key = String(year);
  }
  return {
    granularity,
    bucketKey: key,
    periodStart: start,
    periodEnd: new Date(nextStart.getTime() - 1),
  };
}

export function currentCalendarBucket(
  granularity: CalendarGranularity,
  now: Date = new Date(),
): CalendarBucket {
  // Calendar buckets are display-timezone wall-clock periods; never derive
  // them from the host timezone (a laptop in UTC+0 must still see Shanghai days).
  const parts = zonedParts(now);
  if (granularity === "week") {
    const iso = isoWeekFromParts(parts);
    return bucketFromParts("week", iso.year, iso.week);
  }
  if (granularity === "month") return bucketFromParts("month", parts.year, parts.month);
  if (granularity === "quarter") {
    return bucketFromParts("quarter", parts.year, Math.floor((parts.month - 1) / 3) + 1);
  }
  return bucketFromParts("year", parts.year);
}

export function calendarBucketFromKey(
  granularity: CalendarGranularity,
  bucketKey?: string | null,
  now: Date = new Date(),
): CalendarBucket {
  const key = String(bucketKey || "").trim();
  if (!key) return currentCalendarBucket(granularity, now);
  if (granularity === "week") {
    const match = /^(\d{4})-W(\d{1,2})$/.exec(key);
    if (!match) throw new Error("invalid_bucket_key");
    return bucketFromParts("week", Number(match[1]), Number(match[2]));
  }
  if (granularity === "month") {
    const match = /^(\d{4})-(\d{1,2})$/.exec(key);
    if (!match) throw new Error("invalid_bucket_key");
    return bucketFromParts("month", Number(match[1]), Number(match[2]));
  }
  if (granularity === "quarter") {
    const match = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!match) throw new Error("invalid_bucket_key");
    return bucketFromParts("quarter", Number(match[1]), Number(match[2]));
  }
  const match = /^(\d{4})$/.exec(key);
  if (!match) throw new Error("invalid_bucket_key");
  return bucketFromParts("year", Number(match[1]));
}

export function previousCalendarBucket(
  granularity: CalendarGranularity,
  now: Date = new Date(),
): CalendarBucket {
  const current = currentCalendarBucket(granularity, now);
  return currentCalendarBucket(granularity, new Date(current.periodStart.getTime() - 1));
}

export function childBucketKeys(bucket: CalendarBucket): [CalendarGranularity, string][] {
  const startParts = zonedParts(bucket.periodStart);
  if (bucket.granularity === "month") {
    const endParts = zonedParts(bucket.periodEnd);
    const endUtc = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
    const monday = new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() || 7) - 1));
    const out: [CalendarGranularity, string][] = [];
    while (monday.getTime() <= endUtc) {
      const iso = isoWeekFromParts({
        year: monday.getUTCFullYear(),
        month: monday.getUTCMonth() + 1,
        day: monday.getUTCDate(),
        hour: 0,
        minute: 0,
        second: 0,
        weekday: monday.getUTCDay(),
      });
      out.push(["week", `${iso.year}-W${pad2(iso.week)}`]);
      monday.setUTCDate(monday.getUTCDate() + 7);
    }
    return out;
  }
  if (bucket.granularity === "quarter") {
    const quarter = Number(bucket.bucketKey.split("-Q")[1]);
    const year = startParts.year;
    return Array.from({ length: 3 }, (_, index) => {
      const month = (quarter - 1) * 3 + index + 1;
      return ["month", `${year}-${pad2(month)}`] as [CalendarGranularity, string];
    });
  }
  if (bucket.granularity === "year") {
    const year = startParts.year;
    return Array.from({ length: 4 }, (_, index) => ["quarter", `${year}-Q${index + 1}`] as [
      CalendarGranularity,
      string,
    ]);
  }
  return [];
}

export function bucketIsFrozen(bucket: CalendarBucket, now: Date = new Date()): boolean {
  return bucket.periodEnd.getTime() < now.getTime();
}

/** Display-timezone day key (`YYYY-MM-DD`), never the host timezone. */
export function dayKey(date: Date, timeZone: string = displayTimeZone()): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Period key for affect aggregation, bucketed in the display timezone. */
export function affectPeriodKey(
  date: Date,
  granularity: string,
  timeZone: string = displayTimeZone(),
): string {
  const parts = zonedParts(date, timeZone);
  if (granularity === "day") return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
  if (granularity === "week") {
    const iso = isoWeekFromParts(parts);
    return `${iso.year}-W${pad2(iso.week)}`;
  }
  if (granularity === "month") return `${parts.year}-${pad2(parts.month)}`;
  if (granularity === "quarter") {
    return `${parts.year}-Q${Math.floor((parts.month - 1) / 3) + 1}`;
  }
  return String(parts.year);
}
