const DEFAULT_TIMEOUT_MS = 10000;

function normalizeTargetId(value) {
  const target = String(value || "").trim();
  if (!target) return "";
  return /^\d+$/.test(target) ? Number(target) : target;
}

export function normalizeQQConfig(config = {}) {
  const qq = config.notification?.qq || {};
  const targetType = String(qq.targetType || "private").trim().toLowerCase();
  return {
    enabled: qq.enabled !== false,
    onEveryMatch: qq.onEveryMatch !== false,
    apiBase: String(qq.apiBase || "").trim().replace(/\/+$/, ""),
    accessToken: String(qq.accessToken || ""),
    targetType: targetType === "group" ? "group" : "private",
    targetId: String(qq.targetId || "").trim(),
    timeoutMs: Math.max(3000, Number(qq.timeoutMs || DEFAULT_TIMEOUT_MS))
  };
}

export function qqConfigured(config = {}) {
  const qq = normalizeQQConfig(config);
  return Boolean(qq.enabled && qq.apiBase && qq.targetId);
}

function buildPayload(qq, message) {
  const targetId = normalizeTargetId(qq.targetId);
  return qq.targetType === "group"
    ? { group_id: targetId, message }
    : { user_id: targetId, message };
}

export async function sendQQMessage(config, message) {
  const qq = normalizeQQConfig(config);
  if (!qq.enabled) return { sent: false, skipped: true, reason: "disabled" };
  if (!qqConfigured(config)) throw new Error("QQ 通知未配置完整：需要 OneBot 地址和接收目标");

  const action = qq.targetType === "group" ? "send_group_msg" : "send_private_msg";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), qq.timeoutMs);
  try {
    const headers = { "Content-Type": "application/json" };
    if (qq.accessToken) headers.Authorization = `Bearer ${qq.accessToken}`;
    const response = await fetch(`${qq.apiBase}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildPayload(qq, message)),
      signal: controller.signal
    });
    const raw = await response.text();
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 500) }; }
    if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`);
    if (body.retcode !== undefined && Number(body.retcode) !== 0) {
      throw new Error(`OneBot retcode ${body.retcode}: ${body.msg || body.wording || "请求失败"}`);
    }
    if (body.status !== undefined && body.status !== "ok") {
      throw new Error(`OneBot status ${body.status}: ${body.msg || body.wording || "请求失败"}`);
    }
    return { sent: true, action, targetType: qq.targetType };
  } finally {
    clearTimeout(timer);
  }
}

export function renderQQMessage(record = {}) {
  const analysis = record.analysis || {};
  const interval = analysis.prediction?.target || analysis.interval?.target;
  const lines = [
    "【Tibo Reset Monitor】检测到重置相关消息",
    `账号：@${record.username || "thsottiaux"}`,
    `旧金山：${record.createdAtSource || "—"}`,
    `北京：${record.createdAtTarget || "—"}`,
    `信号：${analysis.signal || "reset_related"}`,
    `置信度：${analysis.confidence || "—"}`
  ];
  if (interval?.start && interval?.end) lines.push(`重点窗口：北京时间 ${interval.start} — ${interval.end}`);
  if (analysis.prediction?.explanation) lines.push(`预测说明：${analysis.prediction.explanation}`);
  if (record.sourceUrl) lines.push(`原帖：${record.sourceUrl}`);
  if (record.text) lines.push(`原文：${record.text}`);
  return lines.join("\n");
}
