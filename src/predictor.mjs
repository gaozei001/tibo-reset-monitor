import { addMinutes, formatInterval, localParts, zonedLocalToDate } from "./time.mjs";
import { summarizeHistory } from "./history.mjs";

function round(value) {
  return value === null || value === undefined ? value : Number(value.toFixed(2));
}

/**
 * Narrow a broad day-level hint using the historical announcement-time cluster.
 * This is deliberately conditional: it never invents a reset when the post has
 * no reset signal, and it never overrides an explicit time from the source post.
 */
export function predictResetWindow({ interval, historyEvents = [], sourceTimeZone, targetTimeZone }) {
  if (!interval || interval.kind !== "vague_window" || !historyEvents.length) return null;
  const summary = summarizeHistory(historyEvents, sourceTimeZone);
  if (!summary.count || summary.sourceHourMedian === null) return null;

  const medianHour = Math.round(summary.sourceHourMedian);
  const startHour = Math.max(0, medianHour - 1);
  const endHour = Math.min(23, medianHour + 2);
  const intervalStart = localParts(new Date(interval.startUtc), sourceTimeZone);
  const start = zonedLocalToDate({ year: intervalStart.year, month: intervalStart.month, day: intervalStart.day, hour: startHour }, sourceTimeZone);
  const end = zonedLocalToDate({ year: intervalStart.year, month: intervalStart.month, day: intervalStart.day, hour: endHour }, sourceTimeZone);
  const formatted = formatInterval(start, end, sourceTimeZone, targetTimeZone);
  return {
    ...formatted,
    method: "historical_peak_window",
    confidence: summary.recentGapDays.sample >= 3 ? "中" : "低",
    historyCount: summary.count,
    sourceHourMedian: summary.sourceHourMedian,
    sourceHourWindow: [startHour, endHour],
    recentMedianGapDays: round(summary.recentGapDays.median),
    allMedianGapDays: round(summary.allGapDays.median),
    explanation: `根据 ${summary.count} 条历史重置公告，旧金山公告时间中位数约为 ${medianHour}:00，窄化为 ${startHour}:00–${endHour}:00；这是条件预测，不是官方时间承诺`
  };
}

export function buildNextResetEstimate({ historyEvents = [], now = new Date(), sourceTimeZone, targetTimeZone }) {
  if (!historyEvents.length) return null;
  const summary = summarizeHistory(historyEvents, sourceTimeZone);
  const latest = summary.recent.at(-1);
  if (!latest) return null;
  const gap = summary.recentGapDays.median || summary.allGapDays.median;
  if (!gap) return null;
  const center = new Date(new Date(latest.announced_at).getTime() + gap * 86400000);
  const hour = Math.round(summary.sourceHourMedian ?? 17);
  const sourceCenter = localParts(center, sourceTimeZone);
  const predictedCenter = zonedLocalToDate({ year: sourceCenter.year, month: sourceCenter.month, day: sourceCenter.day, hour }, sourceTimeZone);
  const start = addMinutes(predictedCenter, -90);
  const end = addMinutes(predictedCenter, 120);
  const formatted = formatInterval(start, end, sourceTimeZone, targetTimeZone);
  return {
    ...formatted,
    method: "historical_cadence_only",
    confidence: "低",
    historyCount: summary.count,
    recentMedianGapDays: round(summary.recentGapDays.median),
    explanation: `仅按最近历史间隔中位数 ${round(gap)} 天和公告时间中位数估算；没有新的 Tibo 时间暗示时只能作为低置信度基线`
  };
}
