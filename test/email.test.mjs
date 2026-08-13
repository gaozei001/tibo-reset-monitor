import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Monitor } from "../src/monitor.mjs";
import { buildEmailMessage, sendEmail } from "../src/email.mjs";

function startFakeSmtp() {
  return new Promise((resolve) => {
    const received = [];
    const server = net.createServer((socket) => {
      let buffer = "";
      let inData = false;
      socket.write("220 fake.smtp.test ESMTP\r\n");
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        while (true) {
          if (inData) {
            const end = buffer.indexOf("\r\n.\r\n");
            if (end < 0) return;
            received.push(buffer.slice(0, end));
            buffer = buffer.slice(end + 5);
            inData = false;
            socket.write("250 2.0.0 queued\r\n");
            continue;
          }
          const newline = buffer.indexOf("\r\n");
          if (newline < 0) return;
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 2);
          const upper = line.toUpperCase();
          if (upper.startsWith("EHLO") || upper.startsWith("HELO")) socket.write("250-fake.smtp.test\r\n250 AUTH PLAIN LOGIN\r\n");
          else if (upper.startsWith("AUTH")) socket.write("235 2.7.0 authenticated\r\n");
          else if (upper.startsWith("MAIL FROM")) socket.write("250 2.1.0 ok\r\n");
          else if (upper.startsWith("RCPT TO")) socket.write("250 2.1.5 ok\r\n");
          else if (upper === "DATA") {
            inData = true;
            socket.write("354 end with <CRLF>.<CRLF>\r\n");
          } else if (upper === "QUIT") {
            socket.write("221 2.0.0 bye\r\n");
            socket.end();
          } else socket.write("250 2.0.0 ok\r\n");
        }
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, received }));
  });
}

test("SMTP sender delivers a UTF-8 email to a local fake server", async () => {
  const smtp = await startFakeSmtp();
  try {
    const result = await sendEmail({
      notification: {
        email: {
          enabled: true,
          host: "127.0.0.1",
          port: smtp.port,
          secure: false,
          user: "sender@example.com",
          password: "test-password",
          from: "sender@example.com",
          to: "receiver@example.com"
        }
      }
    }, { subject: "Tibo 重置测试", text: "北京时间 2026-08-13 07:00–10:00" });
    assert.equal(result.sent, true);
    assert.equal(smtp.received.length, 1);
    assert.match(smtp.received[0], /Subject: =\?UTF-8\?B\?/);
    assert.match(smtp.received[0], /X-Tibo-Reset-Monitor: 1/);
  } finally {
    await new Promise((resolve) => smtp.server.close(resolve));
  }
});

test("each matched post emails once and recovery duplicates do not resend", async () => {
  const smtp = await startFakeSmtp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tibo-email-monitor-"));
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
        email: {
          enabled: true,
          onEveryMatch: true,
          host: "127.0.0.1",
          port: smtp.port,
          secure: false,
          user: "sender@example.com",
          password: "test-password",
          from: "sender@example.com",
          to: "receiver@example.com"
        }
      }
    }
  });

  const payload = {
    data: {
      id: "email-dedup-1",
      author_id: "u1",
      created_at: "2026-08-12T15:20:00.000Z",
      text: "Reset around 10 AM PT.",
      edit_history_tweet_ids: ["email-dedup-1"]
    },
    includes: { users: [{ id: "u1", username: "thsottiaux", name: "Tibo" }] }
  };
  const first = await monitor.ingest(payload);
  const second = await monitor.ingest(payload);
  assert.equal(first.record.emailSent, true);
  assert.equal(second.record.emailSent, true);
  assert.equal(monitor.store.counts().notifications, 1);
  assert.equal(smtp.received.length, 1);
  monitor.stop();
  await new Promise((resolve) => smtp.server.close(resolve));
});

test("email body contains an audit-safe plain-text message", () => {
  const message = buildEmailMessage({ from: "a@example.com", to: ["b@example.com"], subject: "Test", text: "hello" });
  assert.match(message, /Content-Type: text\/plain; charset=UTF-8/);
  assert.doesNotMatch(message, /password|Bearer/i);
});
