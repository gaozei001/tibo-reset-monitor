import {
  DEFAULT_SOURCE_TIME_ZONE,
  DEFAULT_TARGET_TIME_ZONE,
  addLocalDays,
  addMinutes,
  formatInterval,
  isValidDate,
  localDateParts,
  zonedLocalToDate
} from "./time.mjs";

const CLOCK_PATTERN = String.raw`(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;
const ZONE_PATTERN = String.raw`(PT|PDT|PST|Pacific Time|San Francisco(?: time)?|UTC|GMT|Z)`;

const RANGE_RE = new RegExp(
  String.raw`\b(?:between|from)\s+${CLOCK_PATTERN}\s+(?:and|to)\s+${CLOCK_PATTERN}(?:\s*${ZONE_PATTERN})?`,
  "i"
);

const EXACT_RE = new RegExp(
  String.raw`(?:\b(at|around|about|roughly|approximately|approx|@)\s+)?${CLOCK_PATTERN}(?:\s*${ZONE_PATTERN})?`,
  "i"
);

const CHINESE_CLOCK_RE = /(?:在|于|约|大约|大概|凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:点|时)(?:(\d{2})分?)?/i;

const DEFAULT_KEYWORDS = ["reset", "restart", "reboot", "refresh", "reset window", "reset soon"];

export function normalizeText(value) {
  return String(value || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanZoneLabel(value) {
  const label = String(value || "").trim().toLowerCase();
  if (["utc", "gmt", "z"].includes(label)) return "UTC";
  return null;
}

function parseClock(hourValue, minuteValue, ampmValue) {
  let hour = Number(hourValue);
  const minute = minuteValue === undefined || minuteValue === "" ? 0 : Number(minuteValue);
  const ampm = String(ampmValue || "").toLowerCase().replace(/\./g, "");

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (ampm === "am" || ampm === "pm") {
    if (hour < 1 || hour > 12) return null;
    if (ampm === "am" && hour === 12) hour = 0;
    if (ampm === "pm" && hour !== 12) hour += 12;
  } else if (hour < 0 || hour > 23) {
    return null;
  }

  return { hour, minute };
}

function eventZoneFromLabel(label, config) {
  const explicit = cleanZoneLabel(label);
  if (explicit) return explicit;
  return config.sourceTimeZone || DEFAULT_SOURCE_TIME_ZONE;
}

function dateForClock(postDate, clock, timeZone, dayOffset = 0) {
  const base = addLocalDays(localDateParts(postDate, timeZone), dayOffset);
  return zonedLocalToDate({ ...base, ...clock }, timeZone);
}

function intervalForDateRange(start, end, sourceTimeZone, targetTimeZone, kind, explanation, extra = {}) {
  if (!isValidDate(start) || !isValidDate(end) || end < start) return null;
  return {
    ...formatInterval(start, end, sourceTimeZone, targetTimeZone),
    kind,
    explanation,
    ...extra
  };
}

function parseRelativeWindow(text, postDate, config) {
  const match = text.match(
    /\b(?:in|within|after)\s+(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?\s*(minutes?|mins?|m|hours?|hrs?|h|days?|d)\b/i
  );
  if (!match) return null;

  const first = Number(match[1]);
  const second = match[2] === undefined ? first : Number(match[2]);
  const unit = match[3].toLowerCase();
  const multiplier = unit.startsWith("d") ? 1440 : unit.startsWith("h") ? 60 : 1;
  const start = addMinutes(postDate, first * multiplier);
  const end = addMinutes(postDate, second * multiplier);
  return intervalForDateRange(
    start,
    end,
    config.sourceTimeZone || DEFAULT_SOURCE_TIME_ZONE,
    config.targetTimeZone || DEFAULT_TARGET_TIME_ZONE,
    "relative",
    `以帖子发布时间为基准，识别到相对时间 ${match[0]}`,
    { explicitTimeZone: false, inferredTimeZone: false, relativeMinutes: [first * multiplier, second * multiplier] }
  );
}

function parseRangeWindow(text, postDate, config) {
  const match = text.match(RANGE_RE);
  if (!match) return null;

  const first = parseClock(match[1], match[2], match[3] || match[6]);
  const second = parseClock(match[4], match[5], match[6] || match[3]);
  if (!first || !second) return null;

  const eventTimeZone = eventZoneFromLabel(match[7], config);
  const dayOffset = /\b(?:tomorrow|next day)\b|明天/i.test(text) ? 1 : 0;
  const start = dateForClock(postDate, first, eventTimeZone, dayOffset);
  let end = dateForClock(postDate, second, eventTimeZone, dayOffset);
  if (end < start) end = dateForClock(postDate, second, eventTimeZone, dayOffset + 1);

  return intervalForDateRange(
    start,
    end,
    eventTimeZone,
    config.targetTimeZone || DEFAULT_TARGET_TIME_ZONE,
    "explicit_range",
    `识别到明确时间区间 ${match[0]}`,
    {
      explicitTimeZone: Boolean(match[7]),
      inferredTimeZone: !match[7],
      rawTimeExpression: match[0]
    }
  );
}

function parseExactWindow(text, postDate, config) {
  const match = text.match(EXACT_RE);
  if (match) {
    const prefix = match[1] || "";
    const clock = parseClock(match[2], match[3], match[4]);
    const hasMinute = match[3] !== undefined;
    const hasAmpm = Boolean(match[4]);
    const hasZone = Boolean(match[5]);
    const hasUsefulPrefix = Boolean(prefix);
    if (clock && (hasMinute || hasAmpm || hasZone || hasUsefulPrefix)) {
      const eventTimeZone = eventZoneFromLabel(match[5], config);
      const dayOffset = /\b(?:tomorrow|next day)\b|明天/i.test(text) ? 1 : 0;
      const center = dateForClock(postDate, clock, eventTimeZone, dayOffset);
      const fuzzy = /\b(?:around|about|roughly|approximately|approx)\b|大约|大概|左右/i.test(text);
      const tolerance = fuzzy
        ? Number(config.fuzzyToleranceMinutes ?? 30)
        : Number(config.exactToleranceMinutes ?? 5);
      const start = addMinutes(center, -tolerance);
      const end = addMinutes(center, tolerance);
      return intervalForDateRange(
        start,
        end,
        eventTimeZone,
        config.targetTimeZone || DEFAULT_TARGET_TIME_ZONE,
        fuzzy ? "fuzzy_time" : "explicit_time",
        `识别到${fuzzy ? "模糊" : "明确"}时间表达 ${match[0]}，采用 ±${tolerance} 分钟容差`,
        {
          explicitTimeZone: hasZone,
          inferredTimeZone: !hasZone,
          rawTimeExpression: match[0],
          toleranceMinutes: tolerance
        }
      );
    }
  }

  const chinese = text.match(CHINESE_CLOCK_RE);
  if (chinese) {
    const clock = parseClock(chinese[1], chinese[2], null);
    if (!clock) return null;
    const eventTimeZone = config.sourceTimeZone || DEFAULT_SOURCE_TIME_ZONE;
    const dayOffset = /明天/.test(text) ? 1 : 0;
    const center = dateForClock(postDate, clock, eventTimeZone, dayOffset);
    const fuzzy = /约|大约|大概|左右/.test(text);
    const tolerance = fuzzy
      ? Number(config.fuzzyToleranceMinutes ?? 30)
      : Number(config.exactToleranceMinutes ?? 5);
    return intervalForDateRange(
      addMinutes(center, -tolerance),
      addMinutes(center, tolerance),
      eventTimeZone,
      config.targetTimeZone || DEFAULT_TARGET_TIME_ZONE,
      fuzzy ? "fuzzy_time" : "explicit_time",
      `识别到中文时间表达 ${chinese[0]}，采用 ±${tolerance} 分钟容差`,
      {
        explicitTimeZone: false,
        inferredTimeZone: true,
        rawTimeExpression: chinese[0],
        toleranceMinutes: tolerance
      }
    );
  }

  return null;
}

function parseVagueWindow(text, postDate, config) {
  const eventTimeZone = config.sourceTimeZone || DEFAULT_SOURCE_TIME_ZONE;
  const targetTimeZone = config.targetTimeZone || DEFAULT_TARGET_TIME_ZONE;
  const base = localDateParts(postDate, eventTimeZone);
  let dayOffset = null;
  let startClock = null;

  if (/\b(?:tomorrow|next day)\b|明天/i.test(text)) dayOffset = 1;
  else if (/\b(?:today|later today)\b|今天/i.test(text)) dayOffset = 0;
  else if (/\btonight\b|今晚/i.test(text)) {
    dayOffset = 0;
    startClock = { hour: 18, minute: 0 };
  }

  if (dayOffset === null) return null;
  const date = addLocalDays(base, dayOffset);
  const start = zonedLocalToDate({ ...date, ...(startClock || { hour: 0, minute: 0 }) }, eventTimeZone);
  const end = zonedLocalToDate({ ...date, hour: 23, minute: 59, second: 59 }, eventTimeZone);
  return intervalForDateRange(
    start,
    end,
    eventTimeZone,
    targetTimeZone,
    "vague_window",
    `只识别到日期范围表达 ${dayOffset === 1 ? "tomorrow/明天" : startClock ? "tonight/今晚" : "today/今天"}`,
    { explicitTimeZone: false, inferredTimeZone: true, rawTimeExpression: dayOffset === 1 ? "tomorrow" : startClock ? "tonight" : "today" }
  );
}

export function parseTemporalWindow(textValue, postDateValue, config = {}) {
  const text = normalizeText(textValue);
  const postDate = postDateValue instanceof Date ? postDateValue : new Date(postDateValue);
  if (!isValidDate(postDate)) return null;

  return (
    parseRelativeWindow(text, postDate, config) ||
    parseRangeWindow(text, postDate, config) ||
    parseExactWindow(text, postDate, config) ||
    parseVagueWindow(text, postDate, config)
  );
}

function containsTerm(text, term) {
  const value = normalizeText(term).toLowerCase();
  if (!value) return false;
  return value.includes(" ") ? text.toLowerCase().includes(value) : new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escapeRegExp(value)}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function confidenceLabel(score) {
  if (score >= 0.78) return "高";
  if (score >= 0.5) return "中";
  return "低";
}

export function analyzePost({ post, username = "", config = {} }) {
  const text = normalizeText(post?.text || "");
  const resetKeywords = config.resetKeywords?.length ? config.resetKeywords : DEFAULT_KEYWORDS;
  const keywordHits = resetKeywords.filter((term) => containsTerm(text, term));
  const contextKeywords = config.contextKeywords || [];
  const contextHits = contextKeywords.filter((term) => containsTerm(text, term));
  const targetUsername = String(config.tiboUsername || "").replace(/^@/, "").toLowerCase();
  const actualUsername = String(username || "").replace(/^@/, "").toLowerCase();
  const isTargetAuthor = Boolean(targetUsername && actualUsername && targetUsername === actualUsername);
  const negative = /\b(?:do not|don't|does not|doesn't|will not|won't|never|no)\s+(?:reset|restart|reboot)|\b(?:not|without)\s+(?:a\s+)?reset|不会重置|不重置|没有重置/i.test(text);
  const historical = /\b(?:last|previous|old|earlier)\s+(?:reset|restart|reboot)|\b(?:was|were|has been)\s+(?:reset|restarted|rebooted)|上次重置|已经重置/i.test(text);
  const futureIntent = /\b(?:will|going to|plan to|planning to|scheduled|next|soon|in|within|after|tomorrow|tonight|later|upcoming)\b|即将|准备|计划|将在|大约|明天|今晚|稍后/i.test(text);
  const timeCue = /\b(?:at|around|about|between|from)\b/i.test(text);
  const futureSignal = futureIntent || (!historical && timeCue);
  const postDate = new Date(post?.created_at || Date.now());
  const temporal = keywordHits.length && !negative && (!historical || futureIntent)
    ? parseTemporalWindow(text, postDate, config)
    : null;
  const mode = config.monitorMode || "author";

  let score = 0;
  if (keywordHits.length) score += 0.25;
  if (isTargetAuthor) score += 0.3;
  if (temporal) score += temporal.kind === "explicit_range" || temporal.kind === "explicit_time" ? 0.3 : 0.2;
  if (temporal?.explicitTimeZone) score += 0.1;
  if (futureSignal) score += 0.1;
  if (contextHits.length) score += 0.05;
  if (negative) score -= 0.75;
  if (historical && !temporal) score -= 0.2;
  score = Math.max(0, Math.min(1, score));

  const candidate = keywordHits.length > 0;
  const allowedSource = mode !== "author" || !targetUsername || isTargetAuthor;
  const shouldAlert = Boolean(
    candidate &&
      allowedSource &&
      !negative &&
      (temporal || futureSignal || mode === "author") &&
      !(historical && !temporal && !futureSignal)
  );

  let signal = "no_time";
  if (negative) signal = "negative";
  else if (historical && !temporal) signal = "historical";
  else if (temporal) signal = temporal.kind;
  else if (futureSignal) signal = "future_without_time";

  const reasons = [];
  if (keywordHits.length) reasons.push(`命中关键词：${keywordHits.join(", ")}`);
  if (isTargetAuthor) reasons.push("发布者与配置的 tibo 用户名一致");
  if (temporal) reasons.push(temporal.explanation);
  if (negative) reasons.push("检测到否定表达，不触发报警");
  if (historical) reasons.push("检测到历史回顾表达");
  if (!temporal) reasons.push("未提取到可计算的具体时间区间");

  return {
    candidate,
    shouldAlert,
    confidence: confidenceLabel(score),
    confidenceScore: Number(score.toFixed(3)),
    signal,
    keywordHits,
    contextHits,
    isTargetAuthor,
    negative,
    historical,
    futureSignal,
    futureIntent,
    reasons,
    interval: temporal,
    sourceText: text
  };
}

export { DEFAULT_KEYWORDS };
