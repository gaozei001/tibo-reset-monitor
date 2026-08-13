import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { formatZoned } from "./time.mjs";

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendText(response, status, contentType, body) {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function publicConfig(config) {
  return {
    tiboUsername: config.tiboUsername,
    monitorMode: config.monitorMode,
    port: config.port,
    sourceTimeZone: config.sourceTimeZone,
    targetTimeZone: config.targetTimeZone,
    resetKeywords: config.resetKeywords,
    contextKeywords: config.contextKeywords,
    fuzzyToleranceMinutes: config.fuzzyToleranceMinutes,
    exactToleranceMinutes: config.exactToleranceMinutes,
    catchupOnStart: config.catchupOnStart,
    catchupMinutes: config.catchupMinutes
  };
}

function publicPost(row, config) {
  const created = new Date(row.created_at_utc);
  return {
    id: row.id,
    alertKey: row.alert_key,
    authorId: row.author_id,
    username: row.username,
    text: row.text,
    createdAtUtc: row.created_at_utc,
    receivedAtUtc: row.received_at_utc,
    createdAtSource: formatZoned(created, config.sourceTimeZone),
    createdAtTarget: formatZoned(created, config.targetTimeZone),
    sourceTimeZone: config.sourceTimeZone,
    targetTimeZone: config.targetTimeZone,
    sourceUrl: row.source_url,
    analysis: row.analysis || {}
  };
}

export function createServer({ rootDir, monitor, config }) {
  const clients = new Set();
  const webDir = path.join(rootDir, "web");

  const broadcast = (event, payload) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of clients) {
      try {
        response.write(message);
      } catch {
        clients.delete(response);
      }
    }
  };

  monitor.on("status", (payload) => broadcast("status", payload));
  monitor.on("post", (payload) => broadcast("post", payload));
  monitor.on("alert", (payload) => broadcast("alert", payload));

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

    if (url.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, service: "tibo-reset-monitor", time: new Date().toISOString() });
      return;
    }
    if (url.pathname === "/api/status") {
      sendJson(response, 200, monitor.status());
      return;
    }
    if (url.pathname === "/api/config") {
      sendJson(response, 200, publicConfig(config));
      return;
    }
    if (url.pathname === "/api/posts") {
      sendJson(response, 200, {
        data: monitor.store.listPosts(url.searchParams.get("limit") || 50).map((row) => publicPost(row, config))
      });
      return;
    }
    if (url.pathname === "/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      response.write(`event: status\ndata: ${JSON.stringify(monitor.status())}\n\n`);
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    const fileMap = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
      "/style.css": ["style.css", "text/css; charset=utf-8"]
    };
    const file = fileMap[url.pathname];
    if (file) {
      try {
        const content = fs.readFileSync(path.join(webDir, file[0]));
        sendText(response, 200, file[1], content);
      } catch {
        sendJson(response, 404, { error: "not_found" });
      }
      return;
    }
    sendJson(response, 404, { error: "not_found" });
  });

  return { server, broadcast };
}
