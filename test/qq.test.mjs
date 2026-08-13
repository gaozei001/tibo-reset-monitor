import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Monitor } from "../src/monitor.mjs";
import { sendQQMessage } from "../src/qq.mjs";

function startFakeOneBot() {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer(async (request, response) => {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      requests.push({ action: request.url, body: raw ? JSON.parse(raw) : {} });
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ status: "ok", retcode: 0, data: { message_id: "fake-1" } }));
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

test("OneBot sends a private message to the configured target", async () => {
  const bot = await startFakeOneBot();
  try {
    const result = await sendQQMessage({
      notification: { qq: {
        enabled: true,
        apiBase: `http://127.0.0.1:${bot.port}`,
        targetType: "private",
        targetId: "123456789"
      } }
    }, "检测到 Tibo 重置消息");
    assert.equal(result.sent, true);
    assert.equal(bot.requests.length, 1);
    assert.equal(bot.requests[0].action, "/send_private_msg");
    assert.equal(bot.requests[0].body.user_id, 123456789);
    assert.equal(bot.requests[0].body.message, "检测到 Tibo 重置消息");
  } finally {
    await new Promise((resolve) => bot.server.close(resolve));
  }
});

test("matching posts send QQ once and recovery duplicates do not resend", async () => {
  const bot = await startFakeOneBot();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-qq-monitor-"));
  const monitor = new Monitor({
    rootDir: root,
    token: "",
    config: {
      tiboUsername: "thsottiaux",
      monitorMode: "author",
      sourceTimeZone: "America/Los_Angeles",
      targetTimeZone: "Asia/Shanghai",
      resetKeywords: ["reset"],
      history: { enabled: false },
      notification: {
        consoleBeep: false,
        email: { enabled: false },
        qq: {
          enabled: true,
          onEveryMatch: true,
          apiBase: `http://127.0.0.1:${bot.port}`,
          targetType: "private",
          targetId: "123456789"
        }
      }
    }
  });
  const payload = {
    data: {
      id: "qq-dedup-1",
      author_id: "u1",
      created_at: "2026-08-12T15:20:00.000Z",
      text: "Reset around 10 AM PT.",
      edit_history_tweet_ids: ["qq-dedup-1"]
    },
    includes: { users: [{ id: "u1", username: "thsottiaux", name: "Tibo" }] }
  };
  try {
    const first = await monitor.ingest(payload);
    const second = await monitor.ingest(payload);
    assert.equal(first.record.qqSent, true);
    assert.equal(second.record.qqSent, true);
    assert.equal(monitor.store.counts().notifications, 1);
    assert.equal(bot.requests.length, 1);
    assert.equal(bot.requests[0].action, "/send_private_msg");
  } finally {
    monitor.stop();
    await new Promise((resolve) => bot.server.close(resolve));
  }
});
