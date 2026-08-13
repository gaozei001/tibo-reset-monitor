# Tibo Reset Monitor

一个运行在 Windows / Node.js 上的公开 X 消息监测器：

- 使用 X API v2 Filtered Stream 监测公开帖子；
- 默认监测 `@thsottiaux`（显示名 Tibo）本人发布的 reset / restart / reboot 等消息；
- 识别明确时间、时间区间、相对时间和模糊表达；
- 使用 `America/Los_Angeles` 与 `Asia/Shanghai` 自动处理夏令时；
- 将帖子原始时间、旧金山时间、北京时间、估算区间、置信度和判断依据保存到本地 SQLite；
- 在本地网页面板实时显示；
- 可选向自定义 HTTP Webhook 发送报警；
- 没有 Token 时可以运行离线演示和本地测试，不会访问 X。

## 当前交付状态

已经完成并验证：

- X 查询规则生成；
- Filtered Stream 连接、心跳和重连骨架；
- 近期搜索补漏骨架；
- 帖子去重和编辑历史归并键；
- 英文相对时间、明确时间、明确时间区间；
- `PT / PDT / PST` 的 IANA 时区转换；
- 北京时间区间输出；
- 否定表达过滤；
- 本地 SQLite 记录；
- 浏览器面板和 SSE 实时更新；
- SMTP 邮件通知、UTF-8 邮件正文和重复消息去重；
- 公开历史时间线的历史窗口预测；
- 12 个自动化测试全部通过；
- 离线演示输出符合预期。

尚未在你的 X Developer 账号和收件箱上做完整的真实在线验收，因为交付包中没有、也不应包含你的 Bearer Token、SMTP 密码和收件地址。配置后还需要验证：账号是否准确、X API 访问权限、实际帖子语言和真实邮件到达链路。

2026-08-12 的公开数据核验已经确认目标账号为 `@thsottiaux`，显示名 Tibo。当前快照的历史分析见 [analysis-2026-08-12.md](analysis-2026-08-12.md)。该分析使用公开的 reset 相关时间线做审计，不等同于抓取 Tibo 的全部普通 X 帖子。

## 运行要求

推荐使用 Node.js 24 或更新版本。程序使用 Node 内置的 `node:sqlite`，不需要安装 npm 依赖。

当前版本使用 Node 内置 ICU 时区数据库。如果你的 Node 发行版不包含完整时区数据，请换用官方完整 Node 发行版；程序不会把 PDT/PST 固定写成一个常数。

## 1. 配置监测账号

编辑项目根目录的 `config.json`：

```json
{
  "tiboUsername": "thsottiaux",
  "monitorMode": "author",
  "sourceTimeZone": "America/Los_Angeles",
  "targetTimeZone": "Asia/Shanghai",
  "resetKeywords": [
    "reset",
    "restart",
    "reboot",
    "refresh",
    "reset window",
    "reset soon"
  ]
}
```

当前已核验的目标是 `@thsottiaux`，显示名为 Tibo。`tiboUsername` 必须是准确的 X 用户名，不要写主页 URL，也不要重复写 `@`。如果要监测别人提到 tibo 的公开帖子，将 `monitorMode` 改为 `mentions`。

`config.example.json` 是可复制的完整配置参考。`config.json` 不包含密钥，可以安全地按项目配置修改；密钥只从当前 PowerShell 会话中的 `X_BEARER_TOKEN` 读取。

## 2. 设置 X Bearer Token

在当前 PowerShell 窗口中设置：

```powershell
$env:X_BEARER_TOKEN = '你的 Bearer Token'
```

然后启动：

```powershell
.\run.ps1
```

或者：

```powershell
node .\src\main.mjs
```

打开本地面板：

```text
http://127.0.0.1:8787
```

如果没有配置 Token，程序仍会启动面板，但状态会显示“待配置”，不会连接 X。

## 3. 配置邮件通知

程序会对 `@thsottiaux` 发布的每一条“相关 reset 消息”发送一封邮件，包括只有“明天 / soon”而没有明确时间的提示。相同帖子、重连补漏和编辑版本会按帖子根 ID 去重，不会重复轰炸收件箱。它不是对该账号的每一条普通动态都发邮件。

SMTP 信息只从当前 PowerShell 会话的环境变量读取，不写入 `config.json`，也不打印密码：

```powershell
$env:EMAIL_SMTP_HOST = 'smtp.example.com'
$env:EMAIL_SMTP_PORT = '587'
$env:EMAIL_SMTP_SECURE = 'false'       # 465 通常填 true；587 通常走 STARTTLS
$env:EMAIL_SMTP_USER = '你的 SMTP 用户名'
$env:EMAIL_SMTP_PASSWORD = '你的 SMTP 应用专用密码'
$env:EMAIL_FROM = '发件地址@example.com'
$env:EMAIL_TO = '收件地址@example.com'
$env:EMAIL_ON_EVERY_MATCH = 'true'
.un.ps1
```

邮箱服务商若提供“应用专用密码”，应优先使用它，不要把主账户密码写入项目。当前交付包没有你的真实 SMTP 配置，所以未宣称已经向你的邮箱投递；本地测试使用假 SMTP 服务验证了握手、中文正文、主题和去重逻辑。面板的“邮件通知”状态会显示“待 SMTP / 已配置”。

## 4. 先跑离线演示

没有 Token 时可以先运行：

```powershell
.\run.ps1 -Demo
```

或者：

```powershell
npm run demo
```

演示包含：

- `Reset between 10 and 11 AM PT.`
- `Reset in 2-3 hours.`
- `We will not reset today.`

演示会展示旧金山时间、北京时间、是否报警、估算窗口和判断依据。

## 5. 运行测试

```powershell
npm test
```

测试覆盖：

- 夏令时下的 PDT → 北京时间；
- 冬令时下的 PST → 北京时间；
- 明确时间区间；
- 相对时间必须以 X 帖子发布时间为基准；
- 否定表达不报警；
- `from:thsottiaux` 规则和转发排除；
- 帖子显示的两个时区。

另外，测试会启动本地假 SMTP 服务，确认相关消息会发邮件且同一帖子只发一次；历史预测测试会确认历史高峰窗口能从旧金山时间转换到北京时间。

## 估算规则

### 明确区间

```text
Reset between 10 and 11 AM PT.
```

直接将两个端点转换为北京时间。

### 模糊时间

```text
Reset around 10 AM PT.
```

默认采用前后 30 分钟的区间，可由 `fuzzyToleranceMinutes` 调整。

### 精确时间

```text
Reset at 10 AM PT.
```

默认采用前后 5 分钟的操作容差，可由 `exactToleranceMinutes` 调整。这个容差是系统策略，不是 tibo 原文明确承诺的误差范围。

### 相对时间

```text
Reset in 2-3 hours.
```

以 X 的 `created_at` 作为基准，不以本地系统收到消息的时间作为基准。

### 没有时间

```text
Reset soon.
```

会报警，但面板会显示“未提取到可计算的具体时间区间”。程序不会凭空制造一个精确时间。

## 历史预测

程序启动后会读取公开的 reset 时间线，排除尚未确认的预告和重复回复，再统计历史事件之间的间隔以及旧金山发布时间的小时分布。对于“明天 / soon / surprise”这类只有模糊窗口的消息，程序会把原文解析出的宽窗口收窄到历史高峰时段，并同时输出旧金山时间和北京时间；如果原文给出明确的时刻或区间，则保留原文区间，不用历史模型覆盖它。

因此，这个功能是“根据当前信号和历史发布时段安排重点值守窗口”，不是官方承诺，也不是确定性预言。历史数据来自独立的公开追踪页面及其时间线接口，当前程序会把来源和历史样本数写入状态与记录，便于复核。当天的公开回放验证脚本位于 `work/verify-live-prediction.mjs`，交付包内的自动化测试不依赖网络。

## API 设计

程序只访问以下公开 X API v2 能力：

- Filtered Stream：实时接收匹配的公开帖子；
- Stream Rules：创建和维护本项目自己管理的规则；
- Recent Search：启动或断线后的短时间补漏。

程序只删除 `tag` 等于 `tibo-reset-monitor` 的规则，不会删除其他标签的 X 流规则。重连、补漏和搜索重复结果通过帖子 ID 与编辑历史根 ID 去重。

官方文档：

- [Filtered Stream](https://docs.x.com/x-api/posts/filtered-stream/introduction)
- [Filtered Stream Quickstart](https://docs.x.com/x-api/posts/filtered-stream/quickstart)
- [Search Operators](https://docs.x.com/x-api/posts/search/integrate/operators)
- [Search Posts](https://docs.x.com/x-api/posts/search/introduction)
- [Recovery and redundancy](https://docs.x.com/x-api/fundamentals/recovery-and-redundancy)
- [X API rate limits](https://docs.x.com/x-api/fundamentals/rate-limits)

X Developer 账号的具体权限、计费和速率限制由 X 当前控制台为准。`catchupOnStart` 会调用 Recent Search 做启动补漏；如果希望尽量减少搜索调用，可以设为 `false`，但断线后的漏报恢复能力会降低。

## Webhook 通知

可在 `config.json` 中填写：

```json
{
  "notification": {
    "consoleBeep": true,
    "webhookUrl": "https://你的通知服务/endpoint",
    "webhookHeaders": {
      "Authorization": "Bearer 你的通知服务密钥"
    }
  }
}
```

报警时会发送：

```json
{
  "type": "tibo_reset_alert",
  "record": {
    "id": "...",
    "username": "thsottiaux",
    "text": "...",
    "createdAtUtc": "...",
    "createdAtSource": "...",
    "createdAtTarget": "...",
    "sourceUrl": "...",
    "analysis": {
      "confidence": "高",
      "interval": {}
    }
  }
}
```

不要把通知密钥提交到 Git 或发给别人。生产部署时应将通知配置放在本机受保护的配置位置，而不是公开分享的项目包中。

## 本地数据

运行后会在 `data/tibo-reset-monitor.db` 创建 SQLite 数据库，保存：

- 帖子 ID、作者和原文；
- X 原始 UTC 发布时间；
- 系统收到时间；
- 原帖链接；
- 解析结果、区间、置信度和判断依据；
- 已发送报警记录。

数据库默认被 `.gitignore` 忽略。它只包含公开帖子内容，但仍建议按你的隐私和保留周期要求定期清理。

## 当前边界

- 只监测公开帖子，不绕过私密账号、私信或平台访问控制；
- X 实时流是近实时，不承诺零延迟；
- 图片中的文字尚未接 OCR；
- 没有时间的“soon / later”只能触发无区间提醒；
- 真实在线捕获、X 权限、Webhook 到达和手机端呈现，需要在配置 Token 后单独验收；
- 程序目前只做检测和估算，不会自动执行任何外部重置动作。
