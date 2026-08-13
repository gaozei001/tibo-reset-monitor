import test from "node:test";
import assert from "node:assert/strict";
import { analyzePost, parseTemporalWindow } from "../src/logic.mjs";
import { formatZoned } from "../src/time.mjs";
import { buildQuery } from "../src/x-client.mjs";

const config = {
  tiboUsername: "thsottiaux",
  monitorMode: "author",
  sourceTimeZone: "America/Los_Angeles",
  targetTimeZone: "Asia/Shanghai",
  resetKeywords: ["reset", "restart", "reboot", "refresh", "reset window", "reset soon"],
  fuzzyToleranceMinutes: 30,
  exactToleranceMinutes: 5
};

test("explicit PT range is converted to a Beijing range", () => {
  const post = {
    id: "1",
    author_id: "u1",
    created_at: "2026-08-12T15:20:00.000Z",
    text: "Reset between 10 and 11 AM PT."
  };
  const result = analyzePost({ post, username: "thsottiaux", config });
  assert.equal(result.shouldAlert, true);
  assert.equal(result.confidence, "高");
  assert.equal(result.interval.kind, "explicit_range");
  assert.equal(result.interval.target.startIso, "2026-08-13T01:00:00");
  assert.equal(result.interval.target.endIso, "2026-08-13T02:00:00");
});

test("relative hours use the X post creation time", () => {
  const post = {
    id: "2",
    created_at: "2026-08-12T15:20:00.000Z",
    text: "Reset in 2-3 hours."
  };
  const interval = parseTemporalWindow(post.text, new Date(post.created_at), config);
  assert.equal(interval.kind, "relative");
  assert.equal(interval.startUtc, "2026-08-12T17:20:00.000Z");
  assert.equal(interval.endUtc, "2026-08-12T18:20:00.000Z");
});

test("winter PT conversion uses PST automatically", () => {
  const post = {
    id: "3",
    created_at: "2026-01-15T15:20:00.000Z",
    text: "Reset at 10 AM PT."
  };
  const result = analyzePost({ post, username: "thsottiaux", config });
  assert.equal(result.interval.source.offsetStart, "UTC-8");
  assert.equal(result.interval.target.startIso, "2026-01-16T01:55:00");
  assert.equal(result.interval.target.endIso, "2026-01-16T02:05:00");
});

test("negative reset language does not alert", () => {
  const result = analyzePost({
    post: { id: "4", created_at: "2026-08-12T15:20:00.000Z", text: "We will not reset today." },
    username: "thsottiaux",
    config
  });
  assert.equal(result.candidate, true);
  assert.equal(result.shouldAlert, false);
  assert.equal(result.signal, "negative");
  assert.equal(result.interval, null);
});

test("historical reset language does not alert just because it has a clock time", () => {
  const result = analyzePost({
    post: { id: "5", created_at: "2026-08-12T15:20:00.000Z", text: "The last reset was at 10 AM PT." },
    username: "thsottiaux",
    config
  });
  assert.equal(result.shouldAlert, false);
  assert.equal(result.interval, null);
  assert.equal(result.signal, "historical");
});

test("author rule is constrained to thsottiaux and excludes retweets", () => {
  const query = buildQuery(config);
  assert.match(query, /from:thsottiaux/);
  assert.match(query, /reset/);
  assert.match(query, /-is:retweet/);
});

test("the post timestamp is shown in both zones", () => {
  const instant = new Date("2026-08-12T15:20:00.000Z");
  assert.match(formatZoned(instant, "America/Los_Angeles"), /08:20:00 PDT/);
  assert.match(formatZoned(instant, "Asia/Shanghai"), /23:20:00 GMT\+8/);
});
