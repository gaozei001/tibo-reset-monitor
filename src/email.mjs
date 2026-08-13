import net from "node:net";
import tls from "node:tls";

const DEFAULT_TIMEOUT_MS = 20000;

function bufferToBase64(value) {
  return Buffer.from(String(value), "utf8").toString("base64");
}

function encodeHeader(value) {
  const text = String(value || "");
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  return `=?UTF-8?B?${bufferToBase64(text)}?=`;
}

function wrapBase64(value) {
  const encoded = Buffer.from(String(value || ""), "utf8").toString("base64");
  return encoded.match(/.{1,76}/g)?.join("\r\n") || "";
}

function parseRecipients(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function responseCode(response) {
  return Number(String(response).slice(0, 3));
}

function assertResponse(response, expected, command) {
  const code = responseCode(response);
  const accepted = Array.isArray(expected) ? expected : [expected];
  if (!accepted.includes(code)) throw new Error(`SMTP ${command} failed: ${response.trim()}`);
}

class SmtpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.buffer = "";
    this.lines = [];
    this.waiters = [];
    this.closed = false;

    socket.setTimeout(timeoutMs, () => this.fail(new Error("SMTP connection timed out")));
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => {
      if (!this.closed) this.fail(new Error("SMTP connection closed"));
    });
  }

  receive(chunk) {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter(line);
      else this.lines.push(line);
    }
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(Promise.reject(error));
    try { this.socket.destroy(); } catch { /* best effort */ }
  }

  readLine() {
    if (this.closed) return Promise.reject(new Error("SMTP connection is closed"));
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    return new Promise((resolve, reject) => {
      const settle = (line) => {
        if (line instanceof Promise) line.catch(reject);
        else resolve(line);
      };
      this.waiters.push(settle);
    });
  }

  async readResponse() {
    let response = "";
    while (true) {
      const line = await this.readLine();
      response += `${line}\n`;
      if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) return response;
    }
  }

  async command(command, expected) {
    this.socket.write(`${command}\r\n`);
    const response = await this.readResponse();
    assertResponse(response, expected, command.split(" ")[0]);
    return response;
  }

  async raw(payload, expected) {
    this.socket.write(payload);
    const response = await this.readResponse();
    assertResponse(response, expected, "DATA");
    return response;
  }

  close() {
    this.closed = true;
    try { this.socket.end(); } catch { /* best effort */ }
  }
}

function connectPlain(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP connection timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function connectTls(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP TLS connection timed out"));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function upgradeToTls(connection, host, timeoutMs) {
  const oldSocket = connection.socket;
  oldSocket.removeAllListeners("data");
  oldSocket.removeAllListeners("error");
  oldSocket.removeAllListeners("close");
  oldSocket.setTimeout(0);

  const secureSocket = await new Promise((resolve, reject) => {
    const socket = tls.connect({ socket: oldSocket, servername: host });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP STARTTLS upgrade timed out"));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return new SmtpConnection(secureSocket, timeoutMs);
}

export function normalizeEmailConfig(config = {}) {
  const email = config.notification?.email || {};
  const recipients = parseRecipients(email.to);
  return {
    enabled: email.enabled !== false,
    onEveryMatch: email.onEveryMatch !== false,
    host: String(email.host || "").trim(),
    port: Number(email.port || 587),
    secure: Boolean(email.secure),
    user: String(email.user || "").trim(),
    password: String(email.password || ""),
    from: String(email.from || email.user || "").trim(),
    to: recipients,
    timeoutMs: Math.max(5000, Number(email.timeoutMs || DEFAULT_TIMEOUT_MS))
  };
}

export function emailConfigured(config = {}) {
  const email = normalizeEmailConfig(config);
  return Boolean(email.enabled && email.host && email.from && email.to.length && email.user && email.password);
}

export function buildEmailMessage({ from, to, subject, text }) {
  const recipients = Array.isArray(to) ? to : parseRecipients(to);
  const headers = [
    `From: ${from}`,
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "X-Tibo-Reset-Monitor: 1"
  ];
  return `${headers.join("\r\n")}\r\n\r\n${wrapBase64(text)}\r\n`;
}

export async function sendEmail(config, { subject, text }) {
  const email = normalizeEmailConfig(config);
  if (!email.enabled) return { sent: false, skipped: true, reason: "disabled" };
  if (!emailConfigured(config)) throw new Error("邮件未配置完整：需要 SMTP 主机、账号、密码、发件人和收件人");

  const initialSocket = email.secure
    ? await connectTls(email.host, email.port, email.timeoutMs)
    : await connectPlain(email.host, email.port, email.timeoutMs);
  let connection = new SmtpConnection(initialSocket, email.timeoutMs);

  try {
    assertResponse(await connection.readResponse(), 220, "GREETING");
    let ehlo = await connection.command("EHLO tibo-reset-monitor", 250);
    if (!email.secure && email.port !== 465 && /STARTTLS/i.test(ehlo)) {
      await connection.command("STARTTLS", 220);
      connection = await upgradeToTls(connection, email.host, email.timeoutMs);
      ehlo = await connection.command("EHLO tibo-reset-monitor", 250);
    }

    const authPlain = `\0${email.user}\0${email.password}`;
    let authenticated = false;
    try {
      await connection.command(`AUTH PLAIN ${bufferToBase64(authPlain)}`, 235);
      authenticated = true;
    } catch (plainError) {
      if (!/SMTP AUTH|535|504|502|command/i.test(plainError.message)) throw plainError;
    }
    if (!authenticated) {
      await connection.command("AUTH LOGIN", 334);
      await connection.command(bufferToBase64(email.user), 334);
      await connection.command(bufferToBase64(email.password), 235);
    }

    await connection.command(`MAIL FROM:<${email.from}>`, 250);
    for (const recipient of email.to) await connection.command(`RCPT TO:<${recipient}>`, [250, 251]);
    await connection.command("DATA", 354);
    const message = buildEmailMessage({ ...email, subject, text });
    const stuffed = message.split("\r\n").map((line) => line.startsWith(".") ? `.${line}` : line).join("\r\n");
    await connection.raw(`${stuffed}\r\n.\r\n`, 250);
    try { await connection.command("QUIT", 221); } catch { /* delivery already succeeded */ }
    return { sent: true, recipients: email.to };
  } finally {
    connection.close();
  }
}

export function renderAlertEmail(record) {
  const analysis = record.analysis || {};
  const interval = analysis.prediction?.target || analysis.interval?.target;
  const lines = [
    "检测到 Tibo 的公开 X 重置相关消息",
    "",
    `账号：@${record.username || "未知"}`,
    `帖子时间（UTC）：${record.createdAtUtc}`,
    `帖子时间（旧金山）：${record.createdAtSource || "—"}`,
    `帖子时间（北京）：${record.createdAtTarget || "—"}`,
    `置信度：${analysis.confidence || "—"}`,
    `信号类型：${analysis.signal || "—"}`,
    `关键词：${(analysis.keywordHits || []).join(", ") || "—"}`,
    ""
  ];
  if (analysis.prediction) {
    lines.push("基于历史时间聚类的预测窗口：");
    lines.push(`旧金山：${analysis.prediction.source.start} — ${analysis.prediction.source.end}`);
    lines.push(`北京：${analysis.prediction.target.start} — ${analysis.prediction.target.end}`);
    lines.push(`预测方法：${analysis.prediction.explanation}`);
    lines.push("");
  } else if (interval) {
    lines.push("从原文解析出的时间窗口：");
    lines.push(`旧金山：${interval.start || interval.startIso} — ${interval.end || interval.endIso}`);
    lines.push(`北京：${record.analysis.interval.target.start} — ${record.analysis.interval.target.end}`);
    lines.push("");
  } else {
    lines.push("本条消息未能提取出具体时间窗口。", "");
  }
  lines.push("原文：", record.text || "", "", `原帖：${record.sourceUrl || "—"}`, "", `判断依据：${(analysis.reasons || []).join("；") || "—"}`);
  return lines.join("\n");
}

export { parseRecipients };
