import { EventEmitter } from "node:events";
import { formatZoned } from "./time.mjs";
import { analyzePost } from "./logic.mjs";
import { Store } from "./db.mjs";
import { MANAGED_RULE_TAG, XClient } from "./x-client.mjs";
import { fetchHistory } from "./history.mjs";
import { predictResetWindow } from "./predictor.mjs";
import { emailConfigured, renderAlertEmail, sendEmail } from "./email.mjs";
import { qqConfigured, renderQQMessage, sendQQMessage } from "./qq.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function buildUserMap(payload) {
  const users = new Map();
  for (const user of payload?.includes?.users || []) users.set(String(user.id), user);
  return users;
}

export class Monitor extends EventEmitter {
  constructor({ rootDir, config, token = "" }) {
    super();
    this.rootDir = rootDir;
    this.config = config;
    this.token = token;
    this.store = new Store(`${rootDir}/data/tibo-reset-monitor.db`);
    this.running = false;
    this.loopPromise = null;
    this.xClient = null;
    this.history = { events: [], normalizedEvents: [], summary: null, sourceUrl: null, updatedAt: null, stale: null };
    this.historyRefreshTimer = null;
    this.lastProcessedAt = null;
    this.statusState = {
      state: "starting",
      ruleTag: MANAGED_RULE_TAG,
      query: "",
      tokenConfigured: Boolean(token),
      tiboUsername: config.tiboUsername || "",
      monitorMode: config.monitorMode || "author",
      emailEnabled: config.notification?.email?.enabled !== false,
      emailOnEveryMatch: config.notification?.email?.onEveryMatch !== false,
      emailConfigured: emailConfigured(config),
      lastEmailAt: null,
      lastEmailError: null,
      qqEnabled: config.notification?.qq?.enabled !== false,
      qqOnEveryMatch: config.notification?.qq?.onEveryMatch !== false,
      qqConfigured: qqConfigured(config),
      lastQqAt: null,
      lastQqError: null,
      historyReady: false,
      historyCount: 0,
      historySourceUrl: config.history?.sourceUrl || null,
      historyUpdatedAt: null,
      historyStale: null,
      predictionReady: false,
      lastHeartbeatAt: null,
      lastPostAt: null,
      lastAlertAt: null,
      lastError: null,
      startedAt: new Date().toISOString(),
      counts: this.store.counts()
    };
  }

  emitStatus() {
    this.statusState.counts = this.store.counts();
    this.emit("status", this.status());
  }

  status() {
    return { ...this.statusState, counts: this.store.counts() };
  }

  async start() {
    this.running = true;
    await this.refreshHistory();
    const refreshMinutes = Number(this.config.history?.refreshMinutes || 0);
    if (this.config.history?.enabled !== false && refreshMinutes > 0) {
      this.historyRefreshTimer = setInterval(() => {
        this.refreshHistory().catch(() => {});
      }, refreshMinutes * 60000);
    }
    if (!this.token || !this.config.tiboUsername || this.config.tiboUsername === "CHANGE_ME") {
      this.statusState.state = "needs_configuration";
      this.statusState.lastError = "请设置 X_BEARER_TOKEN，并在 config.json 中填写准确的 tibo 用户名";
      this.emitStatus();
      return;
    }

    this.xClient = new XClient({
      token: this.token,
      config: this.config,
      onHeartbeat: () => {
        this.statusState.lastHeartbeatAt = new Date().toISOString();
        this.emitStatus();
      }
    });
    this.statusState.query = this.xClient.query;
    this.statusState.state = "configuring_rule";
    this.emitStatus();

    try {
      await this.xClient.ensureManagedRule();
      if (this.config.catchupOnStart) await this.recoverRecent("启动补漏");
      this.loopPromise = this.runStreamLoop();
    } catch (error) {
      this.setError(error);
    }
  }

  async refreshHistory() {
    if (this.config.history?.enabled === false) return;
    const sourceUrl = this.config.history?.sourceUrl;
    if (!sourceUrl) return;
    try {
      this.history = await fetchHistory(sourceUrl);
      this.statusState.historyReady = this.history.normalizedEvents.length > 0;
      this.statusState.historyCount = this.history.normalizedEvents.length;
      this.statusState.historySourceUrl = sourceUrl;
      this.statusState.historyUpdatedAt = this.history.updatedAt;
      this.statusState.historyStale = this.history.stale;
      this.statusState.predictionReady = this.statusState.historyReady;
      this.emitStatus();
    } catch (error) {
      this.statusState.historyReady = false;
      this.statusState.predictionReady = false;
      this.statusState.lastError = `历史预测数据更新失败：${error.message}`;
      this.emitStatus();
    }
  }

  async recoverRecent(reason = "断线补漏") {
    if (!this.xClient) return;
    const minutes = Math.max(1, Number(this.config.catchupMinutes || 10));
    const from = this.lastProcessedAt
      ? new Date(new Date(this.lastProcessedAt).getTime() - 60000)
      : new Date(Date.now() - minutes * 60000);
    this.statusState.state = "recovering";
    this.statusState.lastError = null;
    this.emitStatus();
    const result = await this.xClient.recentSearch({ startTime: from });
    const users = buildUserMap(result);
    for (const post of result.data || []) {
      await this.ingest({ data: post, includes: { users: Array.from(users.values()) }, meta: { recovery: reason } });
    }
  }

  async runStreamLoop() {
    let backoffSeconds = 1;
    while (this.running && this.xClient) {
      try {
        this.statusState.state = "connecting";
        this.statusState.lastError = null;
        this.emitStatus();
        await this.xClient.streamOnce({
          onPayload: (payload) => this.ingest(payload),
          onEnd: (error) => {
            if (error) this.statusState.lastError = error.message;
          }
        });
        if (this.running && this.config.catchupOnStart) await this.recoverRecent("流连接结束补漏");
        backoffSeconds = 1;
      } catch (error) {
        this.setError(error);
        if (this.running && this.config.catchupOnStart) {
          try {
            await this.recoverRecent("流连接异常补漏");
          } catch (recoveryError) {
            this.statusState.lastError = `${error.message}; 补漏失败：${recoveryError.message}`;
          }
        }
        backoffSeconds = Math.min(Number(this.config.maxReconnectSeconds || 60), backoffSeconds * 2);
      }

      if (this.running) {
        this.statusState.state = "backing_off";
        this.emitStatus();
        await sleep(backoffSeconds * 1000);
      }
    }
  }

  async ingest(payload) {
    const post = payload?.data || payload;
    if (!post?.id || !post?.text) return null;

    const users = buildUserMap(payload);
    const user = users.get(String(post.author_id)) || {};
    const username = user.username || post.username || "";
    const receivedAt = new Date();
    const createdAt = new Date(post.created_at || receivedAt);
    let analysis = analyzePost({ post, username, config: this.config });
    const prediction = predictResetWindow({
      interval: analysis.interval,
      historyEvents: this.history.normalizedEvents,
      sourceTimeZone: this.config.sourceTimeZone,
      targetTimeZone: this.config.targetTimeZone
    });
    if (prediction) analysis = { ...analysis, prediction };
    const editHistory = Array.isArray(post.edit_history_tweet_ids) && post.edit_history_tweet_ids.length
      ? post.edit_history_tweet_ids
      : [String(post.id)];
    const alertKey = String(editHistory[0]);
    const sourceUrl = username
      ? `https://x.com/${encodeURIComponent(username)}/status/${encodeURIComponent(post.id)}`
      : `https://x.com/i/web/status/${encodeURIComponent(post.id)}`;
    const targetUsername = String(this.config.tiboUsername || "").replace(/^@/, "").toLowerCase();
    const relevantMatch = Boolean(
      analysis.candidate &&
      ((this.config.monitorMode || "author") !== "author" || !targetUsername || analysis.isTargetAuthor)
    );

    this.store.savePost({ post, username, sourceUrl, analysis, receivedAt, alertKey });
    this.lastProcessedAt = createdAt.toISOString();
    if (this.xClient) this.statusState.state = "streaming";
    this.statusState.lastPostAt = receivedAt.toISOString();
    this.statusState.lastError = null;

    const record = {
      id: String(post.id),
      alertKey,
      authorId: post.author_id || null,
      username,
      name: user.name || "",
      text: post.text,
      createdAtUtc: createdAt.toISOString(),
      receivedAtUtc: receivedAt.toISOString(),
      createdAtSource: formatZoned(createdAt, this.config.sourceTimeZone),
      createdAtTarget: formatZoned(createdAt, this.config.targetTimeZone),
      sourceTimeZone: this.config.sourceTimeZone,
      targetTimeZone: this.config.targetTimeZone,
      sourceUrl,
      analysis,
      recovery: payload?.meta?.recovery || null,
      relevantMatch,
      emailSent: false,
      emailError: null,
      qqSent: false,
      qqError: null
    };

    this.emit("post", record);
    let alertSent = false;
    if (relevantMatch && this.statusState.emailOnEveryMatch && this.statusState.emailConfigured) {
      const notificationKey = `${alertKey}:email`;
      if (this.store.hasNotification(notificationKey)) {
        record.emailSent = true;
      } else {
      try {
        await sendEmail(this.config, {
          subject: analysis.shouldAlert ? "Tibo 重置消息提醒" : "Tibo 相关消息提醒",
          text: renderAlertEmail(record)
        });
        const inserted = this.store.insertNotification(notificationKey, post.id, "email", record, receivedAt);
        record.emailSent = inserted;
        if (inserted) this.statusState.lastEmailAt = receivedAt.toISOString();
        this.statusState.lastEmailError = null;
      } catch (error) {
        record.emailError = error.message;
        this.statusState.lastEmailError = error.message;
      }
      }
    }
    if (relevantMatch && this.statusState.qqOnEveryMatch && this.statusState.qqConfigured) {
      const notificationKey = `${alertKey}:qq`;
      if (this.store.hasNotification(notificationKey)) {
        record.qqSent = true;
      } else {
        try {
          await sendQQMessage(this.config, renderQQMessage(record));
          const inserted = this.store.insertNotification(notificationKey, post.id, "qq", record, receivedAt);
          record.qqSent = inserted;
          if (inserted) this.statusState.lastQqAt = receivedAt.toISOString();
          this.statusState.lastQqError = null;
        } catch (error) {
          record.qqError = error.message;
          this.statusState.lastQqError = error.message;
        }
      }
    }
    if (analysis.shouldAlert) {
      const inserted = this.store.insertAlert(alertKey, post.id, record, receivedAt);
      if (inserted) {
        alertSent = true;
        this.store.markAlertSent(post.id, receivedAt);
        this.statusState.lastAlertAt = receivedAt.toISOString();
        await this.notify(record);
        this.emit("alert", record);
      }
    }
    this.emitStatus();
    return { record, alertSent };
  }

  async notify(record) {
    if (this.config.notification?.consoleBeep !== false) process.stdout.write("\x07");
    const webhookUrl = this.config.notification?.webhookUrl;
    if (!webhookUrl) return;
    try {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(this.config.notification?.webhookHeaders || {}) },
        body: JSON.stringify({ type: "tibo_reset_alert", record })
      });
      if (!response.ok) this.statusState.lastError = `通知 Webhook 返回 ${response.status}`;
    } catch (error) {
      this.statusState.lastError = `通知 Webhook 失败：${error.message}`;
    }
  }

  setError(error) {
    this.statusState.state = "error";
    this.statusState.lastError = error instanceof Error ? error.message : String(error);
    this.emitStatus();
  }

  stop() {
    this.running = false;
    if (this.historyRefreshTimer) clearInterval(this.historyRefreshTimer);
    this.statusState.state = "stopped";
    this.emitStatus();
    this.store.close();
  }
}
