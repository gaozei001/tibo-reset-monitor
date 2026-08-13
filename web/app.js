const state = {
  posts: new Map(),
  browserNotifications: false
};

const $ = (selector) => document.querySelector(selector);

function text(parent, value, className = "") {
  const node = document.createElement("div");
  if (className) node.className = className;
  node.textContent = value ?? "";
  parent.appendChild(node);
  return node;
}

function formatInterval(interval) {
  if (!interval) return null;
  return {
    source: `${interval.source.start} — ${interval.source.end}`,
    target: `${interval.target.start} — ${interval.target.end}`
  };
}

function renderPost(post) {
  const analysis = post.analysis || {};
  const isPrediction = Boolean(analysis.prediction);
  const interval = formatInterval(analysis.prediction || analysis.interval);
  const article = document.createElement("article");
  article.className = `post${analysis.shouldAlert ? " alerted" : ""}`;

  const top = document.createElement("div");
  top.className = "post-top";
  const author = document.createElement("div");
  author.className = "author";
  author.textContent = post.username ? `@${post.username}` : "未知账号";
  top.appendChild(author);
  text(top, `${post.createdAtSource || post.createdAtUtc}\n北京：${post.createdAtTarget || "—"}`, "post-time");
  article.appendChild(top);

  text(article, post.text, "post-text");

  const tags = document.createElement("div");
  tags.className = "tags";
  const tagValues = [
    analysis.shouldAlert ? "已触发报警" : "已记录",
    `置信度：${analysis.confidence || "—"}`,
    `信号：${analysis.signal || "—"}`
  ];
  for (const value of tagValues) {
    const tag = document.createElement("span");
    tag.className = `tag${analysis.shouldAlert ? " alert-tag" : ""}`;
    tag.textContent = value;
    tags.appendChild(tag);
  }
  article.appendChild(tags);

  if (interval) {
    const box = document.createElement("div");
    box.className = "interval";
    text(box, isPrediction ? "历史模型重点窗口" : "原文估算重置窗口", "");
    box.lastChild.className = "interval-title";
    text(box, `旧金山：${interval.source}`);
    text(box, `北京：${interval.target}`);
    article.appendChild(box);
  }

  const times = document.createElement("div");
  times.className = "times";
  const source = document.createElement("div");
  source.className = "time-box";
  text(source, "系统收到", "");
  source.lastChild.className = "time-label";
  text(source, post.receivedAtUtc);
  const reason = document.createElement("div");
  reason.className = "time-box";
  text(reason, "判断依据", "");
  reason.lastChild.className = "time-label";
  text(reason, (analysis.reasons || []).join("；") || "—");
  times.append(source, reason);
  article.appendChild(times);

  const footer = document.createElement("div");
  footer.className = "post-footer";
  text(footer, `帖子 ID：${post.id}`);
  const link = document.createElement("a");
  link.href = post.sourceUrl || "#";
  link.target = "_blank";
  link.rel = "noreferrer noopener";
  link.textContent = "打开原帖";
  footer.appendChild(link);
  article.appendChild(footer);
  return article;
}

function renderFeed() {
  const feed = $("#feed");
  feed.replaceChildren();
  const posts = [...state.posts.values()].sort((a, b) => String(b.received_at_utc || b.receivedAtUtc).localeCompare(String(a.received_at_utc || a.receivedAtUtc)));
  if (!posts.length) {
    text(feed, "等待消息……", "empty");
    return;
  }
  for (const post of posts.slice(0, 50)) feed.appendChild(renderPost(post));
}

function renderStatus(status) {
  const labels = {
    starting: "启动中",
    needs_configuration: "待配置",
    configuring_rule: "配置规则",
    recovering: "补漏中",
    connecting: "连接中",
    streaming: "实时监测",
    backing_off: "等待重连",
    error: "错误",
    stopped: "已停止"
  };
  $("#state").textContent = labels[status.state] || status.state || "—";
  $("#target").textContent = status.tiboUsername ? `@${status.tiboUsername}` : "未设置";
  $("#counts").textContent = `${status.counts?.posts ?? 0} / ${status.counts?.alerts ?? 0}`;
  $("#heartbeat").textContent = status.lastHeartbeatAt || "—";
  $("#emailStatus").textContent = status.emailEnabled === false ? "已关闭" : status.emailConfigured ? "已配置" : "待 SMTP";
  $("#predictionStatus").textContent = status.predictionReady ? `${status.historyCount ?? 0} 条历史` : "不可用";
  $("#query").textContent = status.query || "尚未建立规则";
  const connection = $("#connection");
  connection.textContent = labels[status.state] || status.state || "—";
  connection.className = `pill${status.state === "streaming" ? " ok" : status.state === "error" ? " alert" : ""}`;

  const notice = $("#configNotice");
  if (status.state === "needs_configuration") {
    notice.textContent = `${status.lastError || "请完成配置"}。面板已经启动，但还不会访问 X。`;
    notice.classList.remove("hidden");
  } else if (status.lastError) {
    notice.textContent = `运行提示：${status.lastError}`;
    notice.classList.remove("hidden");
  } else {
    notice.classList.add("hidden");
  }
}

function addPost(post, isAlert = false) {
  state.posts.set(post.id || post.id, post);
  renderFeed();
  if (isAlert && state.browserNotifications && "Notification" in window && Notification.permission === "granted") {
    const interval = post.analysis?.interval?.target;
    new Notification("检测到 tibo 重置消息", {
      body: interval ? `北京时间：${interval.start} — ${interval.end}` : post.text
    });
  }
}

async function refresh() {
  const [statusResponse, postsResponse] = await Promise.all([fetch("/api/status"), fetch("/api/posts?limit=50")]);
  renderStatus(await statusResponse.json());
  const payload = await postsResponse.json();
  state.posts.clear();
  for (const post of payload.data || []) addPost(post);
  renderFeed();
}

$("#notificationButton").addEventListener("click", async () => {
  if (!("Notification" in window)) {
    $("#notificationButton").textContent = "当前浏览器不支持";
    return;
  }
  const result = await Notification.requestPermission();
  state.browserNotifications = result === "granted";
  $("#notificationButton").textContent = state.browserNotifications ? "浏览器提醒已开启" : "浏览器提醒未开启";
});

const events = new EventSource("/events");
events.addEventListener("status", (event) => renderStatus(JSON.parse(event.data)));
events.addEventListener("post", (event) => addPost(JSON.parse(event.data)));
events.addEventListener("alert", (event) => addPost(JSON.parse(event.data), true));
events.onopen = () => { $("#connection").className = "pill ok"; };
events.onerror = () => { $("#connection").className = "pill alert"; };

refresh().catch((error) => {
  $("#configNotice").textContent = `面板读取失败：${error.message}`;
  $("#configNotice").classList.remove("hidden");
});
setInterval(() => refresh().catch(() => {}), 5000);
