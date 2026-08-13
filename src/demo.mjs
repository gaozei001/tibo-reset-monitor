import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzePost } from "./logic.mjs";
import { formatZoned } from "./time.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = {
  tiboUsername: "thsottiaux",
  monitorMode: "author",
  sourceTimeZone: "America/Los_Angeles",
  targetTimeZone: "Asia/Shanghai",
  resetKeywords: ["reset", "restart", "reboot", "refresh", "reset window", "reset soon"],
  fuzzyToleranceMinutes: 30,
  exactToleranceMinutes: 5
};

const fixtures = [
  {
    id: "demo-explicit-range",
    author_id: "demo-tibo",
    created_at: "2026-08-12T15:20:00.000Z",
    text: "Reset between 10 and 11 AM PT."
  },
  {
    id: "demo-relative",
    author_id: "demo-tibo",
    created_at: "2026-08-12T15:20:00.000Z",
    text: "Reset in 2-3 hours."
  },
  {
    id: "demo-negative",
    author_id: "demo-tibo",
    created_at: "2026-08-12T15:20:00.000Z",
    text: "We will not reset today."
  }
];

console.log(`Tibo Reset Monitor 离线演示（项目目录：${rootDir}）`);
for (const post of fixtures) {
  const analysis = analyzePost({ post, username: "thsottiaux", config });
  console.log("\n---");
  console.log(post.text);
  console.log(`发帖（旧金山）：${formatZoned(new Date(post.created_at), config.sourceTimeZone)}`);
  console.log(`发帖（北京）：${formatZoned(new Date(post.created_at), config.targetTimeZone)}`);
  console.log(`报警：${analysis.shouldAlert ? "是" : "否"}；置信度：${analysis.confidence}；信号：${analysis.signal}`);
  if (analysis.interval) {
    console.log(`区间（旧金山）：${analysis.interval.source.start} — ${analysis.interval.source.end}`);
    console.log(`区间（北京）：${analysis.interval.target.start} — ${analysis.interval.target.end}`);
  }
  console.log(`依据：${analysis.reasons.join("；")}`);
}
