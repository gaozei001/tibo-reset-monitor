import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Monitor } from "./monitor.mjs";
import { createServer } from "./server.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(sourceDir, "..");

function loadConfig() {
  const configPath = path.join(rootDir, "config.json");
  const examplePath = path.join(rootDir, "config.example.json");
  let config = {};
  if (fs.existsSync(configPath)) config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  else if (fs.existsSync(examplePath)) config = JSON.parse(fs.readFileSync(examplePath, "utf8"));

  if (process.env.TIBO_USERNAME) config.tiboUsername = process.env.TIBO_USERNAME;
  if (process.env.TIBO_MONITOR_MODE) config.monitorMode = process.env.TIBO_MONITOR_MODE;
  if (process.env.TIBO_MONITOR_PORT) config.port = Number(process.env.TIBO_MONITOR_PORT);

  const history = { ...(config.history || {}) };
  if (process.env.TIBO_HISTORY_ENABLED) history.enabled = process.env.TIBO_HISTORY_ENABLED !== "false";
  if (process.env.TIBO_HISTORY_URL) history.sourceUrl = process.env.TIBO_HISTORY_URL;
  config.history = history;

  const email = { ...(config.notification?.email || {}) };
  if (process.env.EMAIL_ENABLED) email.enabled = process.env.EMAIL_ENABLED !== "false";
  if (process.env.EMAIL_SMTP_HOST) email.host = process.env.EMAIL_SMTP_HOST;
  if (process.env.EMAIL_SMTP_PORT) email.port = Number(process.env.EMAIL_SMTP_PORT);
  if (process.env.EMAIL_SMTP_SECURE) email.secure = process.env.EMAIL_SMTP_SECURE === "true";
  if (process.env.EMAIL_SMTP_USER) email.user = process.env.EMAIL_SMTP_USER;
  if (process.env.EMAIL_SMTP_PASSWORD) email.password = process.env.EMAIL_SMTP_PASSWORD;
  if (process.env.EMAIL_FROM) email.from = process.env.EMAIL_FROM;
  if (process.env.EMAIL_TO) email.to = process.env.EMAIL_TO;
  if (process.env.EMAIL_ON_EVERY_MATCH) email.onEveryMatch = process.env.EMAIL_ON_EVERY_MATCH !== "false";
  config.notification = { ...(config.notification || {}), email };

  const defaults = {
    tiboUsername: "thsottiaux",
    monitorMode: "author",
    port: 8787,
    sourceTimeZone: "America/Los_Angeles",
    targetTimeZone: "Asia/Shanghai",
    resetKeywords: ["reset", "restart", "reboot", "refresh", "reset window", "reset soon"],
    contextKeywords: [],
    fuzzyToleranceMinutes: 30,
    exactToleranceMinutes: 5,
    catchupOnStart: true,
    catchupMinutes: 10,
    maxReconnectSeconds: 60,
    history: { enabled: true, sourceUrl: "https://codex-reset.com/api/timeline", refreshMinutes: 15 },
    notification: {
      consoleBeep: true,
      webhookUrl: "",
      webhookHeaders: {},
      email: { enabled: true, onEveryMatch: true, host: "", port: 587, secure: false, user: "", password: "", from: "", to: "", timeoutMs: 20000 }
    }
  };
  return {
    ...defaults,
    ...config,
    history: { ...defaults.history, ...(config.history || {}) },
    notification: {
      ...defaults.notification,
      ...(config.notification || {}),
      email: { ...defaults.notification.email, ...(config.notification?.email || {}) }
    }
  };
}

const config = loadConfig();
const token = process.env.X_BEARER_TOKEN || "";
const monitor = new Monitor({ rootDir, config, token });
const { server } = createServer({ rootDir, monitor, config });

server.listen(config.port, "127.0.0.1", () => {
  console.log(`Tibo Reset Monitor 面板：http://127.0.0.1:${config.port}`);
  console.log(`监测账号：@${config.tiboUsername}；模式：${config.monitorMode}`);
  console.log(token ? "X Bearer Token：已配置" : "X Bearer Token：未配置（当前仅提供配置状态面板）");
  console.log(config.notification?.email?.enabled === false ? "邮件通知：已关闭" : "邮件通知：等待 SMTP 环境变量");
});

await monitor.start();

const shutdown = () => {
  monitor.stop();
  server.close(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
