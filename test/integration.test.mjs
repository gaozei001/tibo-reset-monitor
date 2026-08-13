import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Monitor } from "../src/monitor.mjs";

test("ingest stores an alert and an audit record in SQLite", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-reset-monitor-"));
  const monitor = new Monitor({
    rootDir: root,
    token: "",
    config: {
      tiboUsername: "thsottiaux",
      monitorMode: "author",
      sourceTimeZone: "America/Los_Angeles",
      targetTimeZone: "Asia/Shanghai",
      resetKeywords: ["reset"],
      exactToleranceMinutes: 5,
      fuzzyToleranceMinutes: 30,
      notification: { consoleBeep: false, webhookUrl: "" }
    }
  });

  const result = await monitor.ingest({
    data: {
      id: "integration-1",
      author_id: "u1",
      created_at: "2026-08-12T15:20:00.000Z",
      text: "Reset around 10 AM PT.",
      edit_history_tweet_ids: ["integration-1"]
    },
      includes: { users: [{ id: "u1", username: "thsottiaux", name: "Tibo" }] }
  });

  assert.equal(result.alertSent, true);
  assert.equal(monitor.store.counts().posts, 1);
  assert.equal(monitor.store.counts().alerts, 1);
  assert.equal(monitor.store.listPosts(1)[0].analysis.interval.target.startIso, "2026-08-13T00:30:00");
  monitor.stop();
});
