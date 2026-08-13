import test from "node:test";
import assert from "node:assert/strict";
import { analyzePost } from "../src/logic.mjs";
import { predictResetWindow } from "../src/predictor.mjs";

const config = {
  tiboUsername: "thsottiaux",
  monitorMode: "author",
  sourceTimeZone: "America/Los_Angeles",
  targetTimeZone: "Asia/Shanghai",
  resetKeywords: ["reset"],
  fuzzyToleranceMinutes: 30,
  exactToleranceMinutes: 5
};

const historicalEvents = [
  "2026-08-04T23:00:00.000Z",
  "2026-08-05T00:00:00.000Z",
  "2026-08-06T00:00:00.000Z",
  "2026-08-07T01:00:00.000Z",
  "2026-08-08T00:00:00.000Z"
].map((announced_at, index) => ({
  id: `history-${index}`,
  group: "reset",
  preview: false,
  source: "archive",
  announced_at
}));

test("a broad tomorrow hint is narrowed using historical Pacific announcement hours", () => {
  const post = {
    id: "prediction-1",
    author_id: "u1",
    created_at: "2026-08-12T06:20:37.000Z",
    text: "We passed the milestone. Little surprise: reset tomorrow."
  };
  const analysis = analyzePost({ post, username: "thsottiaux", config });
  const prediction = predictResetWindow({
    interval: analysis.interval,
    historyEvents: historicalEvents,
    sourceTimeZone: config.sourceTimeZone,
    targetTimeZone: config.targetTimeZone
  });
  assert.equal(analysis.shouldAlert, true);
  assert.equal(analysis.interval.kind, "vague_window");
  assert.equal(prediction.method, "historical_peak_window");
  assert.equal(prediction.source.startIso, "2026-08-12T16:00:00");
  assert.equal(prediction.source.endIso, "2026-08-12T19:00:00");
  assert.equal(prediction.target.startIso, "2026-08-13T07:00:00");
  assert.equal(prediction.target.endIso, "2026-08-13T10:00:00");
  assert.equal(prediction.confidence, "中");
});
