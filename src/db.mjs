import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export class Store {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS posts (
        id TEXT PRIMARY KEY,
        alert_key TEXT,
        author_id TEXT,
        username TEXT,
        text TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        received_at_utc TEXT NOT NULL,
        source_url TEXT,
        analysis_json TEXT,
        raw_json TEXT,
        alert_sent_at TEXT,
        updated_at_utc TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_posts_received ON posts(received_at_utc DESC);
      CREATE INDEX IF NOT EXISTS idx_posts_alert_key ON posts(alert_key);
      CREATE TABLE IF NOT EXISTS alerts (
        alert_key TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        created_at_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notifications (
        notification_key TEXT PRIMARY KEY,
        post_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        sent_at_utc TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
    `);
  }

  savePost({ post, username, sourceUrl, analysis, receivedAt = new Date(), alertKey }) {
    const now = receivedAt.toISOString();
    const createdAt = new Date(post.created_at || receivedAt).toISOString();
    const statement = this.db.prepare(`
      INSERT INTO posts (
        id, alert_key, author_id, username, text, created_at_utc, received_at_utc,
        source_url, analysis_json, raw_json, alert_sent_at, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        alert_key = excluded.alert_key,
        username = excluded.username,
        text = excluded.text,
        analysis_json = excluded.analysis_json,
        raw_json = excluded.raw_json,
        updated_at_utc = excluded.updated_at_utc
    `);
    statement.run(
      String(post.id),
      alertKey || null,
      post.author_id || null,
      username || null,
      post.text || "",
      createdAt,
      now,
      sourceUrl || null,
      json(analysis),
      json(post),
      null,
      now
    );
  }

  markAlertSent(postId, at = new Date()) {
    this.db.prepare("UPDATE posts SET alert_sent_at = ?, updated_at_utc = ? WHERE id = ?").run(at.toISOString(), at.toISOString(), String(postId));
  }

  insertAlert(alertKey, postId, payload, at = new Date()) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (alert_key, post_id, created_at_utc, payload_json)
      VALUES (?, ?, ?, ?)
    `).run(alertKey, String(postId), at.toISOString(), json(payload) || "{}");
    return Number(result.changes || 0) > 0;
  }

  getAlert(alertKey) {
    const row = this.db.prepare("SELECT * FROM alerts WHERE alert_key = ?").get(alertKey);
    return row ? { ...row, payload: parseJson(row.payload_json, {}) } : null;
  }

  insertNotification(notificationKey, postId, channel, payload, at = new Date()) {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO notifications (notification_key, post_id, channel, sent_at_utc, payload_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(notificationKey, String(postId), channel, at.toISOString(), json(payload) || "{}");
    return Number(result.changes || 0) > 0;
  }

  hasNotification(notificationKey) {
    return Boolean(this.db.prepare("SELECT 1 AS present FROM notifications WHERE notification_key = ?").get(notificationKey));
  }

  listPosts(limit = 50) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = this.db.prepare("SELECT * FROM posts ORDER BY received_at_utc DESC LIMIT ?").all(safeLimit);
    return rows.map((row) => ({
      ...row,
      analysis: parseJson(row.analysis_json, {})
    }));
  }

  counts() {
    return {
      posts: Number(this.db.prepare("SELECT COUNT(*) AS count FROM posts").get().count),
      alerts: Number(this.db.prepare("SELECT COUNT(*) AS count FROM alerts").get().count),
      notifications: Number(this.db.prepare("SELECT COUNT(*) AS count FROM notifications").get().count)
    };
  }

  close() {
    this.db.close();
  }
}
