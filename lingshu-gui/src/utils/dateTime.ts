/**
 * Parse API/WS timestamps. SQLite stores UTC as naive ISO strings without offset;
 * treat those as UTC so local display is correct (e.g. UTC+8).
 */
export function parseServerDateTime(
  value: string | number | Date | null | undefined,
  fallback: Date = new Date(),
): Date {
  if (value == null) return fallback;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? fallback : value;
  }
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }

  const text = String(value).trim();
  if (!text) return fallback;

  const normalized = text.includes(' ') && !text.includes('T')
    ? text.replace(' ', 'T')
    : text;

  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(normalized)) {
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? fallback : date;
  }

  const date = new Date(`${normalized}Z`);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

/** Unix seconds or milliseconds from export JSON. */
export function parseUnixTimestamp(value: number): Date {
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis);
}

/** Local wall time from export tools, e.g. 2025/9/13 23:32:56 */
export function parseImportTimeStr(value: string): Date | null {
  const text = String(value).trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(year, month - 1, day, hour, minute, second);
  return Number.isNaN(date.getTime()) ? null : date;
}
