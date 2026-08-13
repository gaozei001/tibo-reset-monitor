const API_BASE = "https://api.x.com/2";
export const MANAGED_RULE_TAG = "tibo-reset-monitor";

function apiHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

async function parseApiResponse(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  if (!response.ok) {
    const detail = body?.detail || body?.errors?.[0]?.message || body?.title || response.statusText;
    throw new Error(`X API ${response.status}: ${detail}`);
  }
  return body;
}

function quoteRuleTerm(term) {
  const value = String(term || "").trim();
  if (!value) return "";
  if (/^[#@$A-Za-z0-9_]+$/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

export function buildQuery(config) {
  const username = String(config.tiboUsername || "").replace(/^@/, "").trim();
  const terms = (config.resetKeywords || []).map(quoteRuleTerm).filter(Boolean);
  const contextTerms = (config.contextKeywords || []).map(quoteRuleTerm).filter(Boolean);
  const keywordPart = terms.length ? `(${terms.join(" OR ")})` : "reset";
  const contextPart = contextTerms.length ? ` (${contextTerms.join(" OR ")})` : "";

  let sourcePart = "";
  if ((config.monitorMode || "author") === "author" && username) sourcePart = `from:${username}`;
  else if ((config.monitorMode || "author") === "mentions" && username) sourcePart = `(@${username} OR "${username}")`;
  else if (username) sourcePart = `(${`from:${username}`} OR @${username})`;

  return [sourcePart, keywordPart, contextPart.trim(), "-is:retweet"].filter(Boolean).join(" ").trim();
}

export class XClient {
  constructor({ token, config, onHeartbeat = () => {} }) {
    this.token = token;
    this.config = config;
    this.onHeartbeat = onHeartbeat;
    this.query = buildQuery(config);
    this.lastStreamEventAt = null;
  }

  async request(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: apiHeaders(this.token, options.headers || {})
    });
    return parseApiResponse(response);
  }

  async ensureManagedRule() {
    const current = await this.request("/tweets/search/stream/rules?max_results=1000");
    const managed = (current.data || []).filter((rule) => rule.tag === MANAGED_RULE_TAG);
    if (managed.length) {
      await this.request("/tweets/search/stream/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delete: { ids: managed.map((rule) => rule.id) } })
      });
    }

    const result = await this.request("/tweets/search/stream/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ add: [{ value: this.query, tag: MANAGED_RULE_TAG }] })
    });

    const rejected = result.errors?.length ? result.errors.map((error) => error.message || error.detail).join("; ") : "";
    if (rejected) throw new Error(`X stream rule rejected: ${rejected}`);
    return { query: this.query, result };
  }

  streamUrl({ backfillMinutes = 0 } = {}) {
    const params = new URLSearchParams({
      "tweet.fields": "created_at,author_id,edit_history_tweet_ids,lang,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username,name,description"
    });
    if (backfillMinutes > 0) params.set("backfill_minutes", String(Math.min(5, backfillMinutes)));
    return `${API_BASE}/tweets/search/stream?${params.toString()}`;
  }

  async streamOnce({ onPayload, onEnd, backfillMinutes = 0 } = {}) {
    const response = await fetch(this.streamUrl({ backfillMinutes }), {
      headers: apiHeaders(this.token)
    });
    if (!response.ok) await parseApiResponse(response);
    if (!response.body) throw new Error("X stream response has no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) {
            this.onHeartbeat();
            continue;
          }
          try {
            const payload = JSON.parse(line);
            this.lastStreamEventAt = new Date().toISOString();
            await onPayload(payload);
          } catch (error) {
            await onEnd?.(new Error(`Invalid stream JSON: ${error.message}`));
          }
        }
      }
      if (buffer.trim()) {
        try {
          await onPayload(JSON.parse(buffer));
        } catch (error) {
          await onEnd?.(new Error(`Invalid final stream JSON: ${error.message}`));
        }
      }
      await onEnd?.(new Error("X stream ended"));
    } finally {
      reader.releaseLock();
    }
  }

  async recentSearch({ startTime } = {}) {
    const params = new URLSearchParams({
      query: this.query,
      max_results: "100",
      "tweet.fields": "created_at,author_id,edit_history_tweet_ids,lang,referenced_tweets",
      expansions: "author_id",
      "user.fields": "username,name,description"
    });
    if (startTime) params.set("start_time", new Date(startTime).toISOString());
    return this.request(`/tweets/search/recent?${params.toString()}`);
  }
}
