const formatterCache = new Map();

export const DEFAULT_SOURCE_TIME_ZONE = "America/Los_Angeles";
export const DEFAULT_TARGET_TIME_ZONE = "Asia/Shanghai";

function formatterFor(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(
      timeZone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        calendar: "iso8601",
        numberingSystem: "latn",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
        timeZoneName: "short"
      })
    );
  }
  return formatterCache.get(timeZone);
}

function partsMap(date, timeZone) {
  const result = {};
  for (const part of formatterFor(timeZone).formatToParts(date)) {
    if (part.type !== "literal") result[part.type] = part.value;
  }
  return result;
}

export function localParts(date, timeZone) {
  const parts = partsMap(date, timeZone);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    timeZoneName: parts.timeZoneName || ""
  };
}

export function formatZoned(date, timeZone) {
  const parts = localParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, "0");
  const stamp = `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
  return parts.timeZoneName ? `${stamp} ${parts.timeZoneName}` : stamp;
}

export function isoZoned(date, timeZone) {
  const parts = localParts(date, timeZone);
  const pad = (value) => String(value).padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

export function getOffsetMinutes(date, timeZone) {
  const parts = localParts(date, timeZone);
  const wallAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  return Math.round((wallAsUtc - date.getTime()) / 60000);
}

export function offsetLabel(date, timeZone) {
  const minutes = getOffsetMinutes(date, timeZone);
  const sign = minutes >= 0 ? "+" : "-";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const remainder = absolute % 60;
  return `UTC${sign}${hours}${remainder ? `:${String(remainder).padStart(2, "0")}` : ""}`;
}

export function localDateParts(date, timeZone) {
  const parts = localParts(date, timeZone);
  return { year: parts.year, month: parts.month, day: parts.day };
}

export function addLocalDays(parts, days) {
  const utc = Date.UTC(parts.year, parts.month - 1, parts.day) + days * 86400000;
  const date = new Date(utc);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/**
 * Convert a wall-clock date/time in an IANA zone to an instant.
 * The short fixed-point iteration handles DST offsets without hard-coding PDT/PST.
 */
export function zonedLocalToDate({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone) {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = wallAsUtc;
  for (let index = 0; index < 4; index += 1) {
    const offset = getOffsetMinutes(new Date(guess), timeZone);
    const next = wallAsUtc - offset * 60000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess);
}

export function formatInterval(start, end, sourceTimeZone, targetTimeZone) {
  return {
    startUtc: start.toISOString(),
    endUtc: end.toISOString(),
    source: {
      timeZone: sourceTimeZone,
      start: formatZoned(start, sourceTimeZone),
      end: formatZoned(end, sourceTimeZone),
      startIso: isoZoned(start, sourceTimeZone),
      endIso: isoZoned(end, sourceTimeZone),
      offsetStart: offsetLabel(start, sourceTimeZone),
      offsetEnd: offsetLabel(end, sourceTimeZone)
    },
    target: {
      timeZone: targetTimeZone,
      start: formatZoned(start, targetTimeZone),
      end: formatZoned(end, targetTimeZone),
      startIso: isoZoned(start, targetTimeZone),
      endIso: isoZoned(end, targetTimeZone),
      offsetStart: offsetLabel(start, targetTimeZone),
      offsetEnd: offsetLabel(end, targetTimeZone)
    }
  };
}

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

export function isValidDate(date) {
  return date instanceof Date && Number.isFinite(date.getTime());
}
