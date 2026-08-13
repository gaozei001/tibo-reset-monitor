import { localParts } from "./time.mjs";

export const DEFAULT_HISTORY_URL = "https://codex-reset.com/api/timeline";

function isPendingLive(event) {
  return event?.reset_verification_status === "pending" && event?.source === "live";
}

export function normalizeHistoryEvents(events = []) {
  const raw = events
    .filter((event) => event?.group === "reset" && !event.preview)
    .filter((event) => !isPendingLive(event))
    .filter((event) => event.announced_at)
    .sort((a, b) => new Date(a.announced_at) - new Date(b.announced_at));

  const result = [];
  for (const event of raw) {
    const previous = result.at(-1);
    if (previous && (new Date(event.announced_at) - new Date(previous.announced_at)) < 5 * 60 * 1000) continue;
    result.push(event);
  }
  return result;
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function median(values) {
  return quantile(values, 0.5);
}

export function summarizeHistory(events, sourceTimeZone = "America/Los_Angeles") {
  const normalized = normalizeHistoryEvents(events);
  const gaps = normalized.slice(1).map((event, index) => (new Date(event.announced_at) - new Date(normalized[index].announced_at)) / 86400000);
  const sourceHours = normalized.map((event) => localParts(new Date(event.announced_at), sourceTimeZone).hour);
  const recentGaps = gaps.slice(-4);
  return {
    count: normalized.length,
    firstAt: normalized[0]?.announced_at || null,
    lastAt: normalized.at(-1)?.announced_at || null,
    allGapDays: {
      median: median(gaps),
      p25: quantile(gaps, 0.25),
      p75: quantile(gaps, 0.75),
      mean: gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null
    },
    recentGapDays: {
      sample: recentGaps.length,
      median: median(recentGaps),
      p25: quantile(recentGaps, 0.25),
      p75: quantile(recentGaps, 0.75),
      mean: recentGaps.length ? recentGaps.reduce((sum, value) => sum + value, 0) / recentGaps.length : null
    },
    sourceHours,
    sourceHourMedian: median(sourceHours),
    recent: normalized.slice(-5)
  };
}

export async function fetchHistory(url = DEFAULT_HISTORY_URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`历史数据 HTTP ${response.status}`);
  const body = await response.json();
  const events = Array.isArray(body) ? body : body.events || [];
  return {
    sourceUrl: url,
    fetchedAt: new Date().toISOString(),
    updatedAt: body.updated_at || null,
    stale: body.stale ?? null,
    events,
    normalizedEvents: normalizeHistoryEvents(events),
    summary: summarizeHistory(events)
  };
}
