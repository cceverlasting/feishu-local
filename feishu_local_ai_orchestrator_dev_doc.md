# 飞书本地 AI Orchestrator 开发文档

## 1. 项目目标

构建一个以飞书 Bot 为入口、运行在本机或私有机器上的 AI Orchestrator 服务，用于统一接收飞书消息，并根据消息内容自动判断、分流、调用不同服务。

核心目标：

```text
飞书 Bot 接收消息
→ 本机服务通过飞书 SDK 长连接接收事件
→ Orchestrator 判断用户意图
→ 分流到文章分析、合同生成、语音转文字、图片理解、文件处理、Web 编辑等服务
→ 调用 OpenAI / DeepSeek / Qwen / 本地服务 / Gotenberg
→ 将结果以文本、富文本、文件或链接形式返回飞书
```

本项目不依赖公网回调地址，不依赖 Vercel/Cloudflare，不需要备案或云服务器。飞书事件通过 SDK 长连接推送到本机程序。

---

## 2. 总体架构

```text
┌──────────────────────────────┐
│            飞书客户端          │
│ 文本 / 链接 / 图片 / 音频 / 文件 │
└───────────────┬──────────────┘
                │
                │ 飞书长连接事件 im.message.receive_v1
                ▼
┌──────────────────────────────┐
│        feishu-local-bot       │
│ - 飞书 SDK 长连接              │
│ - 消息解析                    │
│ - 飞书资源下载                │
│ - 飞书消息回复                │
└───────────────┬──────────────┘
                ▼
┌──────────────────────────────┐
│        Local Orchestrator     │
│ - 意图识别                    │
│ - 命令路由                    │
│ - 服务分流                    │
│ - 任务状态管理                │
│ - 成本与日志记录              │
└───────┬───────────┬──────────┘
        │           │
        │           │
        ▼           ▼
┌──────────────┐  ┌────────────────────┐
│  本地服务层    │  │  远端 Web / 编辑界面 │
│              │  │ 香港/新加坡部署       │
│ - 文章分析    │  │ - 任务查看           │
│ - 合同生成    │  │ - 草稿编辑           │
│ - 文件处理    │  │ - 人工确认           │
│ - STT/OCR    │  │ - 继续生成/导出       │
│ - Gotenberg  │  └────────────────────┘
└───────┬──────┘
        ▼
┌──────────────────────────────┐
│        Model Router           │
│ OpenAI / DeepSeek / Qwen      │
│ 本地模型 / OpenAI-compatible  │
└──────────────────────────────┘
```

---

## 3. 核心设计原则

1. 飞书只作为入口、通道和结果展示，不承担业务判断。
2. 所有判断、分流、服务编排都由后端 Orchestrator 完成。
3. 飞书适配层与业务逻辑解耦，便于后续接入 Lark、Telegram、Web UI、命令行等入口。
4. 模型调用通过统一 Model Router 完成，不绑定单一供应商。
5. 文档生成和 PDF 转换走现有 Node demo 与 Gotenberg，不直接依赖本机 Word 自动化。
6. 多媒体文件先由 Bot 下载到本地，再交给 STT/OCR/视觉模型/文件处理服务。
7. Web UI 作为可选人工编辑界面，不作为飞书消息入口的必要组件。
8. 长耗时任务必须异步处理，避免飞书事件处理超时。

---

## 4. 组件职责

### 4.1 Feishu Adapter

职责：

- 启动飞书 SDK 长连接。
- 监听 `im.message.receive_v1`。
- 解析飞书消息结构。
- 下载图片、音频、视频、普通文件等资源。
- 回复文本、富文本、交互卡片、文件、图片等消息。
- 处理飞书 token、权限、重试和错误。

不做：

- 不判断业务意图。
- 不直接调用模型。
- 不直接生成合同或分析文章。

### 4.2 Orchestrator

职责：

- 将飞书输入转成统一内部输入格式。
- 识别意图和命令。
- 判断后续调用哪个服务。
- 管理任务状态。
- 控制异步流程。
- 记录日志、成本、错误和结果摘要。

### 4.3 Command Router

职责：

- 根据文本、URL、附件类型、命令前缀判断任务类型。
- 将任务分流到对应 handler。

典型任务类型：

```text
article_precheck     文章预读
article_research     文章深读 / 扩展研究
article_verify       中英文检索/查证
contract_draft       合同起草
contract_review      合同审阅
email_draft          邮件撰写
text_rewrite         文本改写
summarize            总结文本/文件
speech_to_text       音频转文字
image_understanding  图片理解/OCR
file_processing      文件处理
web_edit             推送到 Web UI 编辑
general_chat         普通问答
```

### 4.4 本地 demo Node 服务

当前已有 demo 仍作为独立 Node 服务存在。

职责：

- 合同/文档生成。
- DOCX 输出。
- 根据 `GOTENBERG_URL` 决定是否调用 Gotenberg 做 DOCX → PDF 转换。
- 对外提供本地 HTTP API，供 Orchestrator 调用。

建议不要一开始重写 demo，而是先通过本地 HTTP API 对接。

### 4.5 Gotenberg

职责：

- 作为独立 HTTP 服务。
- 当配置 `GOTENBERG_URL` 时，由 demo 服务调用它完成 DOCX → PDF 转换。

推荐运行方式：

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:8
```

本地环境变量：

```env
GOTENBERG_URL=http://127.0.0.1:3000
```

Docker Compose 内部环境变量：

```env
GOTENBERG_URL=http://gotenberg:3000
```

### 4.6 Web UI

职责：

- 查看任务。
- 编辑合同草稿、摘要、邮件、报告等。
- 人工确认后继续生成 DOCX/PDF 或推送飞书。

Web UI 可以部署在香港、新加坡或其他境外服务器。它不是飞书入口，而是人工编辑界面。

---

## 5. 飞书配置

### 5.1 应用类型

使用：

```text
飞书开放平台 → 企业自建应用 → 机器人能力
```

不要使用普通群自定义 Webhook 机器人作为主入口。Webhook 机器人适合外部系统向群里推送消息，不适合接收用户消息并分析。

### 5.2 事件订阅方式

选择：

```text
使用长连接接收事件
```

不要使用 Request URL / Webhook 回调模式。

原因：

- 不需要公网 IP。
- 不需要 HTTPS 域名。
- 不需要 Vercel/Cloudflare。
- 不需要内网穿透。
- 适合常开电脑或私有主机。

### 5.3 订阅事件

至少订阅：

```text
im.message.receive_v1
```

### 5.4 权限建议

MVP 权限：

```text
读取用户发给机器人的单聊消息
接收群聊中 @ 机器人的消息
以机器人身份发送消息
回复消息
获取消息资源，下载图片/音频/视频/文件
上传图片/文件，用于返回生成物
```

第一版不建议申请“读取群聊全部消息”。群聊场景建议用户显式 @ 机器人。

### 5.5 MacBook Pro 本地开发环境配置

适用场景：

```text
另一台 MacBook Pro 用于本地开发、调试飞书 Bot 和长连接事件接收
```

应安装的软件与工具：

```text
Node.js 24.x
Xcode Command Line Tools
飞书官方 Node 服务端 SDK：@larksuiteoapi/node-sdk
Docker Desktop（可选，用于运行 Gotenberg）
飞书官方 CLI：@larksuite/cli（可选，用于调试和授权）
```

推荐原因：

- 当前仓库是 Node.js + TypeScript 项目，不是 iOS/macOS 原生 App。
- 项目主接入方式已经确定为“飞书 Node SDK + 长连接事件订阅”。
- 长连接模式适合本地机器开发，不需要公网回调地址、域名或内网穿透。

建议安装命令：

```bash
xcode-select --install
npm install
npm install @larksuiteoapi/node-sdk
```

如需调试 Gotenberg：

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:8
```

如需额外安装飞书官方 CLI：

```bash
npm install -g @larksuite/cli
```

飞书开放平台配置步骤：

1. 进入飞书开放平台，创建“企业自建应用”。
2. 在“凭证与基础信息”中记录 `App ID` 与 `App Secret`。
3. 在“添加应用能力”中启用“机器人”。
4. 在“事件与回调”中优先选择“使用长连接接收事件”。
5. 至少订阅 `im.message.receive_v1`。
6. 按本节 5.4 开通 MVP 所需权限。
7. 在“版本管理与发布”中创建版本并发布，等待企业管理员审批生效。

项目侧建议新增的本地环境变量：

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
FEISHU_EVENT_MODE=ws
```

补充约束：

- 不要把普通群 Webhook 机器人作为主入口。
- 不要给整个 Node 进程设置全局 `HTTP_PROXY` / `HTTPS_PROXY`，以免影响飞书长连接。
- `@larksuite/cli` 适合调试和排查，但不是本项目运行所必需的依赖。

---

## 6. 支持的输入类型

飞书 Bot 应支持以下输入：

```ts
type BotInput =
  | { type: "text"; text: string; messageId: string; userId: string }
  | { type: "url"; url: string; rawText?: string; messageId: string; userId: string }
  | { type: "image"; filePath: string; mimeType?: string; messageId: string; userId: string }
  | { type: "audio"; filePath: string; duration?: number; messageId: string; userId: string }
  | { type: "video"; filePath: string; messageId: string; userId: string }
  | { type: "file"; filePath: string; filename: string; mimeType?: string; messageId: string; userId: string };
```

飞书消息中出现图片、音频、视频、文件时，Bot 应先调用飞书资源下载接口，将文件下载到本地临时目录或对象存储，再交给后续服务。

存储策略当前暂未最终决定，可以是：

- 容器外宿主机本地目录挂载。
- 云对象存储。

因此第一版实现应抽象出统一的文件存储接口，不要把业务逻辑绑死到某一种存储介质。

若走本地目录，建议先统一为：

```text
./data/inbox
./data/tmp
./outputs
./data/logs
```

---

## 7. 输出格式设计

飞书回复支持多种消息格式，项目中建议优先使用以下几类：

### 7.1 text

用于短消息、状态提示、错误提示。

示例：

```text
已收到，正在分析。
```

### 7.2 post 富文本

用于主要 AI 分析结果：

- 文章预读卡片。
- 深度总结。
- 合同审阅意见。
- 语音转写摘要。
- 图片理解结果。

### 7.3 interactive 交互卡片

后续增强，用于按钮操作：

```text
深读
查证
收藏
生成 PDF
打开 Web 编辑
重新生成
```

第一版可以暂不实现。

### 7.4 file

用于返回生成物：

- DOCX 合同。
- PDF 合同。
- 长文本总结 TXT/MD。
- 转写结果文件。

### 7.5 image

用于返回图片、图表、截图类结果。

### 7.6 输出策略

```text
短状态：text
主要分析：post
生成物：file
长内容：post 摘要 + file 附件
需要用户选择下一步：interactive
Web 编辑入口：post 链接或 interactive 按钮
```

补充约束：
- 研究链路首发默认优先回飞书 `post`。
- 研究链路第一版先不额外导出 `DOCX/PDF`，待 `post` 阅读体验验证后再决定是否增加文件导出。
- 合同、正式文档等天然文件型结果仍可继续走 `file` 或 `mixed`。

---

## 8. 飞书会话分层设计

飞书层面可以通过“一个自建应用 Bot + 多个不同群聊”完成任务分层。

### 8.1 推荐方案：一个 Bot，多群聊，多工作区

创建一个统一的自建应用机器人，例如：

```text
AI 工作台
```

然后创建多个飞书群聊：

```text
AI 阅读室
AI 合同室
AI 写作室
AI 文件处理室
AI 研究室
AI 草稿编辑室
```

这些群聊可以由完全相同的成员构成，例如每个群都只有：

```text
用户本人
AI 工作台 Bot
```

飞书会将每个群视为独立会话，因此它们会有不同的 `chat_id`。后端可以通过 `chat_id` 将不同会话绑定到不同工作区。

示例：

```text
AI 阅读室      → 默认文章预读 / 深读 / 查证
AI 合同室      → 默认合同起草 / 合同审阅 / 转 PDF
AI 写作室      → 默认邮件 / 文案 / 改写 / 翻译
AI 文件处理室  → 默认 PDF / DOCX / 图片 / 音频处理
AI 研究室      → 默认中英文检索 / 资料整理 / 报告生成
AI 草稿编辑室  → 默认推送到 Web UI 做人工编辑
```

这种方式可以在飞书使用层面完成清晰分层，同时后端只需要维护一个 Bot、一套 App ID/App Secret 和一条长连接。

### 8.2 不同群聊可以成员相同

不同群聊可以由相同的人和同一个 Bot 构成。即使成员完全相同，只要是不同群，它们的 `chat_id` 就不同。

推荐创建如下群：

```text
AI 阅读室：你 + AI 工作台 Bot
AI 合同室：你 + AI 工作台 Bot
AI 写作室：你 + AI 工作台 Bot
AI 文件处理室：你 + AI 工作台 Bot
```

后端只需要维护一张会话绑定表：

```ts
const chatBindings = {
  "chat_reader_xxx": {
    mode: "article_precheck",
    jobType: "article",
    providerHint: "deepseek",
    promptProfile: "reading",
    replyMode: "post"
  },
  "chat_contract_xxx": {
    mode: "contract_draft",
    jobType: "contract",
    providerHint: "openai",
    replyMode: "mixed"
  },
  "chat_writer_xxx": {
    mode: "general_chat",
    jobType: "general",
    providerHint: "qwen",
    promptProfile: "management",
    replyMode: "text"
  },
  "chat_files_xxx": {
    mode: "file_processing",
    jobType: "file",
    providerHint: "qwen",
    replyMode: "mixed"
  }
};
```

说明：

- 当前代码中的 canonical schema 为 `mode / jobType / providerHint / promptProfile / replyMode`。
- 早期讨论中出现过 `workspace / defaultIntent / allowedCommands / defaultModel` 这套写法，后续不再作为正式实现结构。

### 8.3 路由优先级

本节只说明设计原则；正式路由规则以第 9 节为准。

设计上的优先级思路如下：

```text
1. 明确命令优先，例如 /合同、/深读、/总结
2. chat_id 绑定的默认 route config
3. 内容类型，例如 URL、图片、音频、文件
4. AI 意图识别（仅作为兜底，不作为第一优先级）
5. fallback 到普通问答
```

当前版本以 `chat_id` 路由为主设计。也就是说，不同飞书会话先绑定到不同 route config，再由显式命令覆盖默认行为。

这样可以兼顾“群聊默认任务”和“显式命令覆盖”，并避免把所有判断都压到 AI classifier 上。

示例：

```text
在 AI 合同室中发送：
起草一份软件开发服务合同……

→ 默认走 contract_draft
```

```text
在 AI 合同室中发送：
/读 https://mp.weixin.qq.com/...

→ 因为明确命令优先，走 article_precheck
```

### 8.4 多 Bot 方案，作为后续增强

后期如果任务域变得更复杂，也可以拆成多个自建应用机器人：

```text
AI 阅读助理
AI 合同助理
AI 写作助理
AI 研究助理
```

多 Bot 的优点：

```text
角色边界更清晰
头像和名称更明确
权限可以更细分
高风险任务可以隔离
```

多 Bot 的缺点：

```text
每个 Bot 都需要单独 App ID / App Secret
每个 Bot 都要配置权限和事件订阅
每个 Bot 都要发布和维护
本机服务要同时管理多条长连接
```

因此推荐策略是：

```text
MVP：一个 Bot + 多群聊 + chat_id 路由
稳定后：将高频或高风险工作区拆成独立 Bot
```

### 8.5 自定义群机器人不作为主入口

飞书自定义群机器人 Webhook 只适合作为结果推送出口，不适合作为本项目主入口。

适合：

```text
后端服务 → 推送通知到某个群
```

不适合：

```text
用户发消息给机器人 → 机器人读取并分析 → 机器人回复
```

主入口应使用“企业自建应用机器人 + 长连接事件订阅”。

---

## 9. 命令与意图设计

### 9.1 显式命令

显式命令在本项目中的定位是“覆盖机制”，不是主要使用方式。

推荐交互方式：

- 主要方式：用户直接把链接、图片、音频、文件分享到不同飞书群，系统按 `chat_id` 默认路由处理。
- 覆盖方式：当用户想临时覆盖默认路由时，再显式输入命令。
- 兜底方式：当系统无法确定任务类型时，可以提示用户补充命令。

因此，第一版应该保留少量显式命令，但不要把“每次都先输入命令”设计成主流程。

建议保留如下命令：

```text
/读 URL
/深读 URL
/研究 URL
/查证 URL
/合同 起草一份……
/审合同 粘贴合同文本或上传文件
/邮件 写一封……
/总结 文本或文件
/改写 文本
/翻译 文本
/转文字 音频
/图片 图片说明或上传图片
/编辑 推送到 Web UI
```

### 9.2 默认规则

没有命令时：

```text
优先读取 chat_id 绑定的 ChatRouteConfig
若当前 chat_id 未绑定，再按内容类型路由
包含 URL → article_precheck
纯文本较短 → general_chat
纯文本较长 → summarize 或 general_chat
图片 → image_understanding
音频 → speech_to_text
文件 → file_processing
```

说明：

- `chat_id` 是当前版本的主要路由依据。
- 显式命令始终高于 `chat_id` 默认路由。
- 当前代码第一版不依赖 AI intent classifier 作为常规路由步骤。
- 分享到飞书的链接、图片、音频、文件，应尽量做到“无需额外输入命令即可处理”。

### 9.3 路由伪代码

```ts
async function routeInput(input: NormalizedInput): Promise<TaskPlan> {
  if (input.command === "/深读") return articleResearchPlan(input);
  if (input.command === "/研究") return articleResearchPlan(input);
  if (input.command === "/查证") return articleVerifyPlan(input);
  if (input.command === "/读") return articlePrecheckPlan(input);
  if (input.command === "/合同") return contractDraftPlan(input);
  if (input.command === "/审合同") return contractReviewPlan(input);
  if (input.command === "/邮件") return emailDraftPlan(input);
  if (input.command === "/总结") return summarizePlan(input);
  if (input.command === "/改写") return textRewritePlan(input);
  if (input.command === "/翻译") return translatePlan(input);
  if (input.command === "/转文字") return speechToTextPlan(input);
  if (input.command === "/图片") return imageUnderstandingPlan(input);
  if (input.command === "/编辑") return webEditPlan(input);

  const routeConfig = getChatRouteConfig(input.chatId);
  if (routeConfig) {
    return routeByChatRouteConfig(routeConfig, input);
  }

  if (input.hasUrl) return articlePrecheckPlan(input);
  if (input.type === "audio") return speechToTextPlan(input);
  if (input.type === "image") return imageUnderstandingPlan(input);
  if (input.type === "file") return fileProcessingPlan(input);
  if (input.type === "text" && input.text.length > LONG_TEXT_THRESHOLD) return summarizePlan(input);

  return generalChatPlan(input);
}
```

其中：

```ts
function routeByChatRouteConfig(route: ChatRouteConfig, input: NormalizedInput): TaskPlan {
  return {
    mode: route.mode,
    jobType: route.jobType ?? inferJobTypeFromMode(route.mode),
    providerHint: route.providerHint,
    promptProfile: route.promptProfile,
    replyMode: route.replyMode ?? "text",
    requiresAsync: true,
    input
  };
}
```

对研究场景，建议先保留一个统一研究群入口，而不是一开始拆成多个 sector/equity 子群。
统一研究群可默认绑定 `mode=article_precheck` 或 `mode=article_research`，`promptProfile` 允许留空，由研究链路基于材料内容自动判断更偏 `sector-research` 还是 `equity-research`。

第一版建议只实现少量稳定 `mode`，不要一开始就做过多隐式推断。

### 9.4 功能清单与分层

建议把功能按“任务域 → 具体模式”来定义，而不是把所有能力都平铺成命令。

推荐第一层任务域：

```text
阅读类
写作类
合同类
图片类
音频类
文件类
Web 编辑类
普通问答类
```

推荐第二层模式：

```text
阅读类：预读 / 深读 / 查证 / 总结
写作类：改写 / 翻译 / 邮件 / 普通写作
合同类：起草 / 审阅 / 导出 DOCX / 导出 PDF
图片类：OCR / 图片理解 / 截图总结
音频类：STT / 转写摘要
文件类：提取文本 / 分类 / 总结 / 转换
Web 编辑类：推送草稿 / 人工编辑 / 编辑后继续处理
普通问答类：general_chat
```

建议的 `mode` 命名可以保持稳定，例如：

```text
article_precheck
article_research
article_verify
summarize
contract_draft
contract_review
text_rewrite
translate
email_draft
image_understanding
image_ocr
speech_to_text
speech_summary
file_processing
web_edit
general_chat
```

### 9.5 MVP 功能边界

建议第一版只做以下能力闭环：

```text
URL 文章预读
URL 深读 / 扩展研究
合同起草
图片 OCR / 图片理解
音频转文字
文件总结 / 文件处理
推送到 Web UI 编辑
```

当前业务优先级中，合同链路应以“合同起草”作为第一目标。

对于合同归档、签名包制作、正式归档文件整理等后续动作：

- 可以后续继续通过独立服务接口调用。
- 可以直接返回本地文件结果。
- 同时保留返回远程 URL 的选项，便于云端继续查看或下载。

建议放到第二期的能力：

```text
查证
合同审阅
改写 / 翻译 / 邮件
图片转文档
转写后二次总结
更复杂的文件格式转换
视频处理
合同归档
签名包制作
```
 
---

## 10. 任务状态模型

建议统一用 Job 管理异步任务。

```ts
type JobStatus =
  | "received"
  | "routing"
  | "queued"
  | "processing"
  | "needs_review"
  | "completed"
  | "failed";

type JobType =
  | "article"
  | "contract"
  | "audio"
  | "image"
  | "file"
  | "email"
  | "general";

interface Job {
  id: string;
  source: "feishu" | "web" | "api";
  sourceMessageId?: string;
  userId?: string;
  chatId?: string;
  type: JobType;
  mode?: string;
  status: JobStatus;
  inputSummary: string;
  rawInputPath?: string;
  attachments?: Array<{
    name: string;
    localPath?: string;
    remoteUrl?: string;
    mimeType?: string;
  }>;
  result?: unknown;
  outputFiles?: Array<{
    name: string;
    localPath: string;
    mimeType?: string;
  }>;
  editUrl?: string;
  provider?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
}
```

MVP 可以用 SQLite 保存 Job。更简单的第一版也可以仅使用 JSONL 日志。

---

## 11. 异步处理要求

飞书长连接事件 handler 不应直接执行长耗时任务。

建议流程：

```text
收到消息
→ 立即创建 Job
→ 立即回复“已收到，正在处理”
→ 异步执行任务
→ 完成后再次回复结果
```

第一版即使采用单进程实现，也应保持“先创建 Job，再由 Worker 执行”的异步模型；可以简化为单进程、单 worker、内联消费，但不建议保留同步直执路径。

异步实现选项：

```text
MVP：内存队列
稳定版：SQLite job queue
增强版：BullMQ / Redis
```

### 11.1 为什么必须异步

如果把“收消息”和“真正执行任务”放在同一个同步流程中，会有几个明显问题：

- 网页抓取、模型调用、OCR、STT、PDF 转换都可能耗时较长。
- 飞书事件处理链路容易阻塞甚至超时。
- 失败任务不容易重试。
- Web UI 人工编辑这类长生命周期任务无法管理。

因此，飞书只负责“接单”，真正执行交给 Job Worker。

### 11.2 角色分工

建议拆成两段：

```text
Feishu Adapter：接收消息、归一化、创建 Job、立即回执
Job Worker：取出 Job、执行模块、更新状态、回传结果
```

推荐主流程：

```text
收到飞书消息
→ 归一化为 NormalizedInput
→ 路由得到 TaskPlan
→ 创建 Job(status=received)
→ 立即回复“已收到，正在处理”
→ Job 入队
→ Worker 取出 Job
→ 执行模块
→ 更新 Job 状态
→ 将结果回传飞书
```

### 11.3 Job 生命周期

建议状态流转如下：

```text
received
→ routing
→ queued
→ processing
→ needs_review
→ completed
```

失败分支：

```text
received / queued / processing / needs_review
→ failed
```

说明：

- `received`：刚收到消息，Job 已创建。
- `routing`：正在决定走哪个 plan。
- `queued`：已进入队列，等待 Worker 处理。
- `processing`：正在调用模块执行。
- `needs_review`：已生成草稿，等待 Web UI 或人工确认。
- `completed`：结果已产出，并已发送或可发送。
- `failed`：任务失败，需要记录可读错误。

### 11.4 推荐 Job 结构补充

在现有 `Job` 结构基础上，建议补充以下字段：

```ts
interface Job {
  plan?: TaskPlan;
  attempt?: number;
  maxAttempts?: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  replyMode?: "text" | "post" | "file" | "mixed";
}
```

这些字段的作用：

- `plan`：保存路由结果，避免 Worker 重新推断。
- `attempt` / `maxAttempts`：支持简单重试。
- `queuedAt` / `startedAt` / `completedAt`：方便计算排队时间与执行时间。
- `replyMode`：统一回飞书策略。

### 11.5 队列实现建议

第一版建议最小实现：

```text
jobs: Map<jobId, Job>
queue: string[]
workerLoop: 单进程异步消费
```

这样就够支撑 MVP，不要一开始就上 Redis。

后续升级路径：

```text
MVP：内存队列 + JSONL / SQLite
稳定版：SQLite 持久化队列
增强版：BullMQ / Redis
```

### 11.6 重试与幂等

第一版建议只做非常保守的重试：

- 网络超时、临时 provider 错误：允许自动重试 1-2 次。
- OCR/STT/网页抓取失败：允许有限重试。
- 合同生成、文件上传等有副作用步骤：不要盲目无限重试。

幂等建议：

- 用 `messageId` + `chatId` 生成或索引 `jobId`，避免同一消息被重复处理。
- 飞书回消息前，先检查 Job 是否已经完成并已回传。
- Worker 重启后，如果发现同一 Job 已经 `completed`，不要重复发送文件。

### 11.7 回飞书时机

建议分三次机会：

```text
1. 收到消息后：立即回“已收到，正在处理”
2. 长任务处理中：可选回状态更新，例如“正在转写音频”
3. 完成后：回摘要 / post / file / editUrl
```

第一版可以只实现第 1 次和第 3 次，保持简单。

### 11.8 Worker 伪代码

```ts
async function onFeishuMessage(input: NormalizedInput) {
  const plan = await routeInput(input);

  const job = createJob({
    inputSummary: summarizeInput(input),
    source: "feishu",
    sourceMessageId: input.messageId,
    userId: input.userId,
    chatId: input.chatId,
    type: plan.jobType,
    mode: plan.mode,
    plan,
    status: "received",
    attempt: 0,
    maxAttempts: 2
  });

  await replyText(input.chatId, "已收到，正在处理");
  updateJob(job.id, { status: "queued", queuedAt: new Date().toISOString() });
  queue.push(job.id);
}

async function workerLoop() {
  while (true) {
    const jobId = queue.shift();
    if (!jobId) {
      await sleep(300);
      continue;
    }

    const job = getJob(jobId);
    if (!job || job.status === "completed") continue;

    updateJob(jobId, {
      status: "processing",
      startedAt: new Date().toISOString()
    });

    try {
      const result = await executePlan(job.plan!, job);
      updateJob(jobId, {
        status: result.editUrl ? "needs_review" : "completed",
        result,
        completedAt: result.editUrl ? undefined : new Date().toISOString()
      });
      await replyResultToFeishu(job, result);
    } catch (error) {
      const attempt = (job.attempt ?? 0) + 1;
      if (attempt < (job.maxAttempts ?? 1) && isRetryable(error)) {
        updateJob(jobId, { attempt, status: "queued" });
        queue.push(jobId);
        continue;
      }

      updateJob(jobId, {
        attempt,
        status: "failed",
        error: String(error)
      });
      await replyText(job.chatId!, "处理失败，请稍后重试。");
    }
  }
}
```

---

## 12. 多媒体处理

### 12.1 图片

流程：

```text
飞书图片消息
→ Bot 下载图片
→ OCR 或视觉模型
→ 进入 image_understanding / file_processing
→ 返回 post 或 file
```

可选能力：

- 图片 OCR。
- 截图内容总结。
- 合同照片识别。
- 图表解释。
- 图片转文档。

### 12.2 音频

浏览器自带语音转文字能力不能直接用于飞书 Bot 后端，因为飞书推送的是音频文件，处理环境是 Node 后端，不是浏览器页面。

替代方案：

```text
飞书音频
→ 下载音频
→ ffmpeg 标准化格式
→ STT 服务
→ 得到文本
→ 进入 command router
```

可选 STT：

```text
OpenAI Whisper / 音频转写
阿里云 ASR
腾讯云 ASR
百度语音
科大讯飞
本地 faster-whisper
```

### 12.3 文件

文件处理流程：

```text
飞书文件
→ 下载文件
→ 根据 MIME/扩展名判断处理器
→ PDF/DOCX/TXT/MD/图片/音频分流
→ 解析内容或生成结果
→ 返回 post + file
```

### 12.4 视频

`video` 输入类型保留在长期设计中，但不纳入第一版 MVP。

第一版策略：

```text
接收到视频消息
→ 允许下载并记录 Job
→ 返回“暂不支持视频处理，后续版本再开放”
```

避免第一版在类型层面宣称支持视频，却没有可执行的处理链路。

---

## 13. Web UI 集成

Web UI 可以继续部署在新加坡、香港或其他可访问区域。

职责：

- 展示 Job。
- 编辑 AI 生成的草稿。
- 细节调整。
- 人工确认。
- 触发后续生成 DOCX/PDF/发送飞书。

### 13.1 本地推送到 Web UI

流程：

```text
飞书输入
→ 本地 Orchestrator 创建 Job
→ 初步生成 draft
→ POST 到远端 Web API
→ 远端返回 editUrl
→ Bot 将 editUrl 发回飞书
```

建议 API：

```http
POST /api/jobs
Authorization: Bearer <WEB_API_TOKEN>
Content-Type: application/json
```

请求：

```json
{
  "source": "feishu",
  "localJobId": "job_xxx",
  "type": "contract",
  "title": "软件开发服务合同草稿",
  "draft": {},
  "attachments": [],
  "callback": {
    "type": "feishu",
    "chatId": "xxx",
    "messageId": "xxx"
  }
}
```

响应：

```json
{
  "remoteJobId": "remote_xxx",
  "editUrl": "https://your-web.example.com/jobs/remote_xxx/edit"
}
```

### 13.2 Web UI 完成后回传

Web UI 保存后可以：

1. 只保存远端状态，由用户手动下载。
2. 调用本地服务 API。
3. 通过飞书 API 直接回复用户。
4. 让本地 Bot 轮询远端任务状态。

推荐第一版：本地 Bot 主动推送草稿到 Web UI，Web UI 只负责编辑和保存；本地 Orchestrator 通过轮询远端任务状态感知编辑结果。

### 13.3 本地与云端连接策略

第一版推荐网络模型：

```text
本地 Orchestrator → 主动访问云端 Web UI / API
云端 Web UI → 不主动回调本地
```

这样可以满足以下目标：

- 本地无需开放公网端口。
- 本地无需公网 IP。
- 不需要内网穿透。
- 只要求本地机器可以访问云端 Web UI。

明确约束：

- MVP 不做云端回调本地。
- MVP 不做本地与云端长连接同步。
- MVP 如需同步云端编辑状态，优先使用“本地轮询”。

### 13.4 为什么选择本地轮询而不是长连接

两者区别：

```text
本地轮询：本地每隔一段时间主动请求云端状态
长连接：本地主动连云端并长期保持连接，等待云端实时推送状态
```

本项目第一版推荐本地轮询，原因是：

- 实现简单。
- 稳定性更高。
- 不需要处理连接保活、断线重连、心跳等复杂逻辑。
- 更符合“不要内网穿透、不要本地开放端口”的约束。
- 合同草稿编辑本身是分钟级任务，不需要秒级实时通知。

建议轮询策略：

```text
轮询对象：remoteJobId
轮询方向：本地 → 云端
轮询间隔：10~30 秒
终止条件：completed / archived / failed / expired
```

第一版推荐：

```text
创建远端编辑任务后
→ 本地保存 remoteJobId
→ 每 15 秒查询一次远端状态
→ 若远端状态变为 completed
→ 本地继续决定是否回飞书、生成 DOCX/PDF 或调用后续服务
```

### 13.5 合同后续动作策略

当前阶段合同链路以“起草”优先，编辑完成后的后续动作尽量走服务化接口。

推荐策略：

```text
合同起草：本地 Orchestrator / demo-service 主链路
DOCX / PDF 导出：直接服务返回
合同归档：后续独立服务接口
签名包制作：后续独立服务接口
远程查看/下载：保留 remoteUrl 选项
```

这意味着：

- 第一版可以先把起草、编辑、导出打通。
- 归档和签名包不必强耦合到飞书 Bot 主流程。
- 如果后续某个结果已经上传到云端，也可以只把 `remoteUrl` 回给飞书。

---

## 14. 模型路由

### 14.1 Provider

支持：

```text
OpenAI
DeepSeek
Qwen / DashScope
OpenAI-compatible endpoint
本地模型，可选
```

### 14.2 推荐路由

```text
文章预读：低成本模型，例如 DeepSeek/Qwen/OpenAI mini
文章深读：中高能力模型
合同起草：稳定中文模型或 OpenAI
合同审阅：推理能力更强模型
英文检索/复杂分析：OpenAI 可选
语音转写：STT 专用模型或服务
图片理解：多模态模型或 OCR + 文本模型
```

### 14.3 Proxy 策略

推荐：

```text
飞书 SDK：直连
OpenAI API：显式代理
DeepSeek/Qwen：优先直连，失败再代理
网页抓取：按目标域名规则决定
```

不要给整个 Node 进程设置全局 `HTTP_PROXY` / `HTTPS_PROXY`，以免影响飞书长连接。

OpenAI provider 可使用独立代理配置：

```env
OPENAI_PROXY_URL=http://127.0.0.1:7890
```

Docker 中访问宿主机代理：

```env
OPENAI_PROXY_URL=http://host.docker.internal:7890
```

---

## 15. 本地服务与 Docker 部署

### 15.1 本机直接运行

推荐进程：

```text
feishu-bot
existing-demo-node-service
gotenberg
```

Mac：

```text
PM2 / launchd
Docker Desktop
```

Windows：

```text
PM2 / NSSM / 任务计划程序
Docker Desktop + WSL2
```

### 15.2 Docker Compose 推荐结构

```yaml
services:
  feishu-bot:
    build:
      context: ./feishu-bot
    restart: unless-stopped
    env_file:
      - .env
    environment:
      DEMO_BASE_URL: http://demo-service:8787
    volumes:
      - ./data:/app/data
      - ./outputs:/app/outputs
    depends_on:
      - demo-service

  demo-service:
    build:
      context: ./demo-service
    restart: unless-stopped
    env_file:
      - .env
    environment:
      GOTENBERG_URL: http://gotenberg:3000
    volumes:
      - ./outputs:/app/outputs
    depends_on:
      - gotenberg

  gotenberg:
    image: gotenberg/gotenberg:8
    restart: unless-stopped
    ports:
      - "3000:3000"
```

注意：容器内部不要使用 `127.0.0.1` 访问另一个容器。应使用服务名，例如：

```text
http://gotenberg:3000
http://demo-service:8787
```

---

## 16. 环境变量

```env
# Feishu
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu

# Local services
DEMO_BASE_URL=http://127.0.0.1:8787
GOTENBERG_URL=http://127.0.0.1:3000
DATA_DIR=./data
OUTPUT_DIR=./outputs

# Web UI integration
WEB_UI_BASE_URL=https://your-web.example.com
WEB_API_TOKEN=xxx
ENABLE_WEB_EDIT=true

# Model routing
MODEL_DEFAULT_PROVIDER=deepseek
MODEL_FALLBACK_PROVIDER=openai
MODEL_PRECHECK_PROVIDER=deepseek
MODEL_DEEP_PROVIDER=openai

# OpenAI
OPENAI_API_KEY=sk_xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_PROXY_URL=http://127.0.0.1:7890
OPENAI_DEFAULT_MODEL=gpt-5.4-mini
OPENAI_DEEP_MODEL=gpt-5.4

# DeepSeek
DEEPSEEK_API_KEY=xxx
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_DEFAULT_MODEL=deepseek-chat

# Qwen
QWEN_API_KEY=xxx
QWEN_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
QWEN_DEFAULT_MODEL=qwen-plus

# Features
ENABLE_AUDIO_STT=true
ENABLE_IMAGE_UNDERSTANDING=true
ENABLE_CONTRACT_SERVICE=true
ENABLE_ARTICLE_READER=true
ENABLE_DAILY_SUMMARY=false
```

---

## 17. 目录结构建议

```text
src/
  index.ts
  config/
    env.ts
  adapters/
    feishu/
      client.ts
      ws.ts
      message-parser.ts
      resource-downloader.ts
      reply.ts
      renderers/
        text.ts
        post.ts
        card.ts
        file.ts
  orchestrator/
    normalize-input.ts
    command-router.ts
    job-manager.ts
    queue.ts
  modules/
    article-reader/
      index.ts
      extract-url.ts
      fetch-article.ts
      precheck.ts
      deep-summary.ts
    contract/
      index.ts
      demo-client.ts
      draft.ts
      review.ts
    document/
      file-detector.ts
      pdf.ts
      docx.ts
    audio/
      index.ts
      transcribe.ts
      ffmpeg.ts
    image/
      index.ts
      ocr.ts
      vision.ts
    web-ui/
      client.ts
      create-edit-job.ts
  models/
    router.ts
    types.ts
    providers/
      openai.ts
      deepseek.ts
      qwen.ts
      compatible.ts
  storage/
    sqlite.ts
    jsonl.ts
  utils/
    logger.ts
    ids.ts
    timeout.ts
    errors.ts
```

---

## 18. MVP 实现顺序

### 18.1 开发原则

按“先打通主链路，再补能力，再补部署”的顺序开发。

推荐主链路优先级：

```text
Feishu 收消息
→ 归一化输入
→ chat_id / command 路由
→ 执行模块
→ 飞书回消息
```

凡是不影响这条主链路打通的能力，都不要前置。

### 18.2 里程碑依赖关系

```text
M0 基础项目
→ M1 飞书长连接
→ M2 统一输入与 chat_id 路由
→ M3 Job 与异步骨架
→ M4 模型路由
→ M5 文章预读
→ M6 对接 demo-service 合同生成
→ M7 飞书文件回传
→ M8 Web UI 推送
→ M9 多媒体资源
→ M10 Docker Compose
```

其中：

- M1-M8 是第一版主功能闭环。
- M8 属于首发范围，但只要求最小可用闭环。
- M9 放在合同与文章主链路之后，不要抢前。
- M10 最后做，避免一开始把时间花在容器编排而不是功能打通。

### M0：基础项目

目标：

- Node.js + TypeScript 项目初始化。
- `tsconfig` strict mode。
- 环境变量 zod 校验。
- 日志模块。
- timeout / error 基础工具。
- 本地启动脚本。

完成标准：

- `npm run dev` 可以启动空服务。
- 缺失关键 env 时能启动失败并给出明确错误。

### M1：飞书长连接

目标：

- 接入飞书 Node SDK。
- 使用长连接接收 `im.message.receive_v1`。
- 实现最小 ping/pong。

完成标准：

- 私聊 `ping` 返回 `pong`。
- 群聊 `@Bot ping` 返回 `pong`。

### M2：统一输入与 `chat_id` 路由

目标：

- 解析文本、URL、图片、音频、文件消息。
- 归一化为统一输入结构。
- 实现显式命令路由。
- 接入 `chat_id` → `ChatRouteConfig` 绑定。

完成标准：

- 同一条消息在 Orchestrator 内部只保留一种统一输入结构。
- `/读`、`/深读`、`/合同` 能路由到不同 plan。
- 未带命令时能按 `chat_id` 默认路由。

### M3：Job 与异步骨架

目标：

- 创建 Job 模型。
- 把飞书事件处理与任务执行解耦。
- 先实现内存队列版本。

完成标准：

- 收到消息后先创建 Job，再异步执行。
- 飞书事件 handler 不直接阻塞长任务。

### M4：模型路由

目标：

- 实现 OpenAI / DeepSeek / Qwen provider adapter。
- 支持 provider 环境变量切换。
- 支持 OpenAI 独立代理。

完成标准：

- 至少一个 provider 可用。
- 切换 provider 不需要修改业务模块代码。

### M5：文章预读

目标：

- 用户发送 URL。
- 抽取网页 metadata / 正文片段。
- 调用模型生成预读卡片。
- 以飞书 post 返回。

完成标准：

- 发送 URL 能返回文章预读卡片。
- `/深读 URL` 不会误路由到 `/读`。

### M6：对接现有 demo-service 合同生成

目标：

- Orchestrator 调用 `DEMO_BASE_URL`。
- 支持 `/合同` 命令。
- 返回合同摘要。
- 处理 Gotenberg 可用 / 不可用两种分支。

完成标准：

- `/合同` 可调用 demo-service。
- 至少能生成摘要 + DOCX。
- Gotenberg 不可用时不会整单失败。

### M7：飞书文件回传

目标：

- 将本地产物或共享存储产物上传回飞书。
- 支持 DOCX / PDF 返回。

完成标准：

- 合同 DOCX 文件能上传回飞书。
- 配置 `GOTENBERG_URL` 后 PDF 能回传。

### M8：Web UI 推送

目标：

- 本地创建 Job 后推送到远端 Web UI。
- 获取 `editUrl`。
- 飞书返回编辑链接。

完成标准：

- `/编辑` 或指定工作区能成功创建远端编辑任务。
- 飞书中能拿到可打开的 `editUrl`。

### M9：多媒体资源

目标：

- 支持图片下载。
- 支持音频下载。
- 接入 STT 或 OCR。
- 视频只记录 Job 并提示暂不支持。

完成标准：

- 图片、音频能下载到统一存储层。
- 图片和音频可进入对应模块。

### M10：Docker Compose

目标：

- 打包 feishu-bot。
- 打包 demo-service。
- 接入 gotenberg 容器。
- Volume 保存 outputs 和 data。

完成标准：

- Docker Compose 能拉起完整主链路。
- 容器内服务之间只通过服务名互相访问。

---

## 19. 错误处理

用户可见错误示例：

```text
我还不能确定你想执行哪种处理。你可以直接把内容发到对应工作区，或者补充一个命令，例如：/读、/合同、/总结。
```

```text
我收到了文件，但暂时不支持这种格式。请发送 PDF、DOCX、图片或纯文本。
```

```text
PDF 转换失败，但 DOCX 已生成。我已先把 DOCX 发给你。
```

```text
语音转文字失败，可能是音频格式不支持或文件过大。
```

```text
Web 编辑任务创建失败，稍后可以重试，当前结果已在飞书中返回。
```

内部错误记录：

- job id
- message id
- user id hash
- module
- provider
- model
- latency
- error code
- stack trace 摘要

不要记录：

- API key
- app secret
- 用户隐私敏感全文，除非用户明确允许本地保存。

---

## 20. 安全要求

- 密钥只放 `.env`，不要提交 Git。
- OpenAI/DeepSeek/Qwen key 不放在飞书消息或前端页面中。
- Web UI API 使用 Bearer Token 或签名鉴权。
- 飞书文件下载后限制文件大小和类型。
- 网页抓取做 SSRF 防护。
- 本地 outputs 目录定期清理或加密备份。
- 合同类输出增加免责声明：仅为草稿，不构成法律意见。
- 如涉及敏感合同/商业文件，优先使用本地存储与受控模型 provider。

---

## 21. 接口规范

### 21.1 总体原则

所有内部接口统一遵循以下原则：

- 输入输出使用显式 JSON 结构，不传“半结构化字符串”。
- 每个任务都带 `jobId`。
- 所有跨模块调用都要有 timeout。
- 所有错误返回都要有稳定的 `code` 和可读的 `message`。
- 所有接口都要区分“用户可见信息”和“内部调试信息”。

推荐错误结构：

```ts
interface ApiErrorShape {
  ok: false;
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}
```

### 21.2 Feishu Adapter → Orchestrator

推荐统一输入结构：

```ts
type NormalizedInput =
  | {
      source: "feishu";
      type: "text";
      text: string;
      command?: string;
      hasUrl: boolean;
      urls?: string[];
      userId: string;
      chatId: string;
      messageId: string;
      mentionsBot?: boolean;
    }
  | {
      source: "feishu";
      type: "image" | "audio" | "file" | "video";
      text?: string;
      command?: string;
      hasUrl?: boolean;
      userId: string;
      chatId: string;
      messageId: string;
      fileName?: string;
      mimeType?: string;
      localPath: string;
      mentionsBot?: boolean;
    };
```

要求：

- Feishu Adapter 负责把飞书原始消息清洗成 `NormalizedInput`。
- Orchestrator 不直接依赖飞书原始事件结构。
- `chatId` 在第一版中是关键路由字段，必须始终可用。

### 21.3 Orchestrator → Router / Module

推荐统一任务计划结构：

```ts
interface TaskPlan {
  jobType: "article" | "contract" | "audio" | "image" | "file" | "email" | "general";
  mode:
    | "article_precheck"
    | "article_research"
    | "article_verify"
    | "contract_draft"
    | "contract_review"
    | "email_draft"
    | "summarize"
    | "speech_to_text"
    | "image_understanding"
    | "file_processing"
    | "web_edit"
    | "general_chat";
  providerHint?: string;
  requiresAsync?: boolean;
  input: NormalizedInput;
}
```

模块执行结果建议统一为：

```ts
interface ModuleResult {
  ok: boolean;
  summary?: string;
  richTextBlocks?: unknown;
  outputFiles?: Array<{
    name: string;
    localPath?: string;
    remoteUrl?: string;
    mimeType?: string;
  }>;
  editUrl?: string;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}
```

这样做的目的：

- 文章、合同、OCR、Web 编辑都能复用同一套回消息逻辑。
- Job 存储层只需要保存 `TaskPlan` 和 `ModuleResult` 即可。

### 21.4 Orchestrator → Web UI

建议 API：

```http
POST /api/jobs
Authorization: Bearer <WEB_API_TOKEN>
Content-Type: application/json
```

请求：

```json
{
  "jobId": "job_xxx",
  "source": "feishu",
  "type": "contract",
  "mode": "web_edit",
  "title": "软件开发服务合同草稿",
  "draft": {},
  "summary": "已生成草稿，待人工编辑",
  "attachments": [],
  "callback": {
    "type": "feishu",
    "chatId": "oc_xxx",
    "messageId": "om_xxx"
  }
}
```

成功响应：

```json
{
  "ok": true,
  "remoteJobId": "remote_xxx",
  "editUrl": "https://your-web.example.com/jobs/remote_xxx/edit"
}
```

失败响应：

```json
{
  "ok": false,
  "code": "WEB_UI_CREATE_FAILED",
  "message": "Failed to create remote edit job",
  "retryable": true
}
```

### 21.5 Orchestrator → demo-service

文件产物的存储位置当前保持开放：

- 本地挂载目录。
- 云对象存储。

因此服务契约不要强依赖“必须是 demo-service 容器内私有路径”。

推荐约定：

- 第一版若使用本地挂载目录，则 `docxPath` / `pdfPath` 返回共享可访问路径。
- 若后续切到对象存储，可扩展为返回 `docxUrl` / `pdfUrl`。
- Orchestrator 只依赖“可读取文件并上传回飞书”这一能力，不依赖底层存储形态。

示例：

```http
POST /api/contracts/draft
Content-Type: application/json
```

请求：

```json
{
  "jobId": "job_xxx",
  "userInput": "起草一份软件开发服务合同……",
  "options": {
    "returnDocx": true,
    "returnPdf": true
  }
}
```

响应：

```json
{
  "ok": true,
  "title": "软件开发服务合同",
  "summary": "已生成合同草稿，缺少甲方地址和付款节点。",
  "docxPath": "./outputs/job_xxx/contract.docx",
  "pdfPath": "./outputs/job_xxx/contract.pdf",
  "warnings": ["PDF 转换使用 Gotenberg", "正式签署前请律师审核"]
}
```

建议请求结构：

- `jobId` 必填，便于链路追踪。
- `userInput` 保留原始业务输入。
- `options` 只放生成选项，不混入路由信息。

后续如果扩展到合同归档、签名包制作、云端文件留存，建议统一支持“直接返回文件”与“返回远程 URL”两种结果形态。

如需后续扩展，可增加：

```json
{
  "templateId": "software_dev_v1",
  "variables": {},
  "storage": {
    "mode": "local"
  }
}
```

例如未来可扩展为：

```json
{
  "archive": {
    "enabled": true,
    "returnRemoteUrl": true
  },
  "signedPackage": {
    "enabled": true,
    "returnRemoteUrl": true
  }
}
```

### 21.6 Gotenberg 不可用时

Demo service 应返回：

```json
{
  "ok": true,
  "docxPath": "./outputs/job_xxx/contract.docx",
  "pdfPath": null,
  "warnings": ["PDF 转换服务不可用，已仅生成 DOCX"]
}
```

### 21.7 存储抽象接口

第一版虽然可以先落本地目录，但代码层建议先抽象：

```ts
interface FileStore {
  put(localPath: string, targetKey: string): Promise<{
    key: string;
    localPath?: string;
    remoteUrl?: string;
  }>;
  getReadablePath(file: {
    key?: string;
    localPath?: string;
    remoteUrl?: string;
  }): Promise<string>;
}
```

最低要求：

- Orchestrator 上传飞书文件前，能拿到可读路径。
- 后续切换对象存储时，不需要重写业务模块。

---

## 22. 测试 Checklist

```text
[ ] 飞书 Bot 私聊 ping → pong
[ ] 群聊 @Bot ping → pong
[ ] 发送 URL → 返回文章预读卡片
[ ] 发送 /深读 URL → 返回深度总结
[ ] 发送 /合同 需求 → demo-service 被调用
[ ] 合同 DOCX 文件能上传回飞书
[ ] 配置 GOTENBERG_URL 后 PDF 能返回
[ ] Gotenberg 不可用时仍返回 DOCX
[ ] 发送图片 → 能下载到本地
[ ] 发送音频 → 能下载并进入 STT 流程
[ ] OpenAI 走独立代理，飞书 SDK 直连
[ ] DeepSeek/Qwen provider 可切换
[ ] Web UI 能创建编辑任务并返回 editUrl
[ ] 长任务不会阻塞飞书事件 handler
[ ] Docker Compose 能启动完整服务
[ ] outputs 和 data 通过 volume 持久化
```

---

## 23. 给 Codex 的开发指令

```text
请基于本文档实现一个本地运行的 TypeScript Node.js 项目。

项目目标：
- 使用飞书 Node SDK 长连接接收 im.message.receive_v1 事件。
- 飞书只是入口和输出通道，所有判断和服务分流在本地 Orchestrator 完成。
- 支持文本、URL、图片、音频、文件等输入的统一归一化。
- 第一版必须实现 ping/pong、URL 文章预读、/合同 调用本地 demo-service。
- 模型调用必须通过 Model Router，支持 OpenAI、DeepSeek、Qwen 和 OpenAI-compatible endpoint。
- OpenAI 必须支持独立代理配置 OPENAI_PROXY_URL，不要给整个 Node 进程设置全局代理。
- 支持将结果以飞书 text/post/file 返回。
- 支持将任务推送到远端 Web UI 并返回 editUrl。
- 支持 Docker Compose 运行 feishu-bot、demo-service、gotenberg。

不要实现：
- 不要做飞书 Webhook Request URL 回调。
- 不要做 Vercel/Cloudflare 部署逻辑。
- 不要模拟微信客户端。
- 不要读取微信 cookie/token。
- 不要直接自动化本机 Word App。

代码要求：
- TypeScript strict mode。
- env 使用 zod 校验。
- 模块边界清晰：adapters、orchestrator、modules、models、storage、utils。
- 所有外部请求必须设置 timeout。
- 日志中不得输出密钥。
- 长任务应通过 job queue 异步执行。
```

---

## 24. 第一版成功标准

```text
1. 本机启动 feishu-local-bot 后，飞书机器人可以收到私聊消息。
2. 发送 ping，机器人回复 pong。
3. 发送微信/网页链接，机器人返回文章预读卡片。
4. 发送 /合同 需求，机器人调用现有 Node demo，返回摘要和 DOCX/PDF 文件。
5. 配置 GOTENBERG_URL 时可生成 PDF；未配置或失败时仍能返回 DOCX。
6. 发送图片/音频时，Bot 可以下载资源并创建对应 Job。
7. 可将某个 Job 推送到远端 Web UI，并把编辑链接返回飞书。
8. OpenAI、DeepSeek、Qwen 至少能通过环境变量切换一个 provider 成功调用。
9. Docker Compose 可以一键启动 feishu-bot、demo-service、gotenberg。
```

---

## 25. 后续增强方向

- 飞书交互卡片：深读、查证、收藏、生成 PDF、打开编辑页。
- 本地 SQLite 任务库。
- 每日汇总。
- 多用户权限和白名单。
- 文件知识库。
- 合同模板库。
- 语音输入完整闭环。
- 图片 OCR + 合同/票据识别。
- 长文分块总结。
- 任务成本统计。
- 支持 Lark 国际版。
- 支持 Telegram/Web/CLI 多入口。

---

## 26. 复用 `CCmanagement-ios` 的裁剪与风险

`D:\develop\CCmanagement-ios` 可以作为合同起草、DOCX/PDF 导出、模板管理的参考来源，但不建议整套照搬到当前飞书本地 Orchestrator 项目。

推荐按以下原则处理：

- 复用“文档渲染链路”和“模板数据结构”的思路。
- 保留可工作的本地文件导出能力。
- 将 Supabase、站点登录、中间件、后台页面等 Web 应用壳子与 Bot 主链路解耦。
- 对 OCR、存储、任务并发等尚未成熟的部分，单独重做或补强。

### 26.1 建议优先复用的部分

可以重点参考以下能力：

```text
合同草稿数据结构
合同模板定义与模板元数据
DOCX 渲染链路
PDF 导出链路
Gotenberg 调用方式
模板占位符映射与校验规则
合同编号规则
合同渲染 API 边界
```

适合参考的原因：

- 这些部分和当前项目的“合同起草 → DOCX/PDF 导出”目标高度相关。
- 这些部分大多可以在不引入 Supabase 的前提下保留。
- 后续拆成独立 `demo-service` 的成本较低。

### 26.2 不建议直接照搬的部分

以下部分不建议整体迁入当前项目：

```text
Supabase 作为主存储/主鉴权依赖
Next.js 页面层与后台工作台
站点登录态与 middleware
重型合同生命周期后台
模板后台的完整管理界面
待办、签署包、归档等完整业务壳子
```

原因：

- 当前飞书本地 Orchestrator 的重点是“消息驱动 + 本地异步任务”，不是完整 Web SaaS。
- 这些部分会显著增加系统复杂度，并分散第一版注意力。
- 其中不少是“网站型产品”的问题，不是 Bot 编排的核心问题。

### 26.3 当前已发现的主要风险点

#### 1. OCR 目前更像“文本解析”，不是真正的 OCR

现有实现更接近：

```text
读取已有文本
→ 根据证照类型做正则解析
→ 生成结构化字段
```

而不是：

```text
图片 / 扫描 PDF
→ OCR 引擎识别文字
→ 再做结构化解析
```

因此：

- 可以复用“识别后的字段映射逻辑”。
- 不应把当前实现当成成熟的图片 OCR 能力。
- 飞书图片/证照上传场景仍需要真正的 OCR 引擎或多模态识别能力。

#### 2. 合同渲染底层仍隐含 Supabase 依赖

现有合同渲染链路中，模板查找在本地模板未命中时会继续查询 Supabase。

风险：

- 本地化部署时，如果某个模板不在本地配置内，又未配置 Supabase，会在渲染时失败。
- 这种失败是“底层运行时失败”，而不是更清晰的“模板不存在或回退到默认模板”。

建议：

- 当前项目里将模板来源显式拆成 `local` / `remote`。
- `demo-service` 第一版默认只依赖本地模板。
- 若未来允许云端模板，再通过明确配置打开，而不是隐式回退。

#### 3. 本地 JSON 文件存储存在并发覆盖风险

现有本地草稿和 OCR 记录保存方式基本都是：

```text
读取整个 JSON 文件
→ 修改内存数组
→ 整个文件写回
```

风险：

- 多个 Job 并发写入时容易互相覆盖。
- 文件越大，读写越慢。
- 不利于后续飞书 Bot 异步 Worker 并发运行。

建议：

- 第一版若继续使用本地文件，尽量限制为低并发、单进程场景。
- 更稳妥的演进方向是 SQLite。
- 不建议在 Bot Worker 场景下长期依赖“大 JSON 文件整文件回写”。

#### 4. Gotenberg 调用缺少 timeout 控制

现有导出链路可以参考，但当前实现若不加 timeout，容易出现：

- PDF 转换长时间挂起。
- Worker 被阻塞。
- 单个任务拖住整个异步处理队列。

建议：

- 当前项目中所有外部调用都必须统一带 timeout。
- Gotenberg 调用必须使用可中断请求。
- 失败时要返回“DOCX 已可用，PDF 暂不可用”的降级结果。

#### 5. 导出链路存在重复计算

现有 `contracts/render` 风格的 API 在某些格式分支中，会先生成一次文本或渲染中间结果，再进入各自分支继续生成最终输出。

风险：

- 会增加无谓 CPU 消耗。
- 在 Bot 场景下会拉长任务时间。

建议：

- 当前项目里按输出类型精简渲染流程。
- 将“文本草稿生成”“DOCX 生成”“PDF 生成”分成更清晰的阶段。
- 避免无用的前置计算。

#### 6. 本地 / Supabase 双轨逻辑过于分散

当前多个模块各自实现“如果 Supabase 可用就用 Supabase，否则回退本地”。

风险：

- 逻辑重复。
- 本地化改造成本高。
- 后续加第三种存储时会更混乱。

建议：

- 当前项目中尽早抽象统一的 `storage` / `repository` 层。
- 业务模块只依赖抽象接口。
- 不要在每个功能文件里各自判断本地或云端。

### 26.4 推荐迁移策略

建议按下面方式复用：

```text
直接参考：合同渲染、DOCX/PDF、Gotenberg、模板结构
裁剪后参考：合同草稿保存、编号规则、模板校验
仅保留思路：OCR 结构化解析、模板后台、归档/签名包
暂不引入：Supabase 主依赖、站点鉴权、中间件、完整后台页面
```

### 26.5 对当前项目的落地建议

对本项目更合适的做法是：

1. 将 `CCmanagement-ios` 中与合同渲染直接相关的逻辑抽出，整理成独立 `demo-service`。
2. `demo-service` 第一版只依赖本地模板、本地存储、Gotenberg。
3. 飞书 Bot 与 Orchestrator 只调用 `demo-service` 的明确 HTTP API，不感知其内部是否参考了原项目。
4. 云端 Web UI 保留独立鉴权体系，但不要把其登录和权限逻辑混进 Bot 主服务。
5. OCR、证照管理、新增模板能力按独立模块持续完善，不要求第一版一次到位。

---

## 27. 后期开发任务与开发顺序

本节用于描述第一版之后的持续开发任务。原则是：

- 先补“主链路稳定性”，再补“合同深化能力”，最后补“平台化能力”。
- 先做对当前飞书使用最有价值的能力，再做后台和管理能力。
- 任何后续开发都不应破坏“本地主动访问云端、不做内网穿透”的基础架构。

### 27.1 后期开发总顺序

推荐顺序：

```text
P1 主链路加固
→ P2 合同导出与后处理
→ P3 Web UI 同步完善
→ P4 OCR / 证照能力完善
→ P5 模板体系完善
→ P6 存储与数据层升级
→ P7 权限与鉴权完善
→ P8 归档 / 签名包 / 生命周期能力
→ P9 多入口与平台化能力
```

### P1：主链路加固

目标：

- 将 MVP 的 in-memory Job 队列升级为更稳的本地持久化方案。
- 给所有外部请求补 timeout、重试和更清晰的错误码。
- 清理重复渲染和重复路由判断。

建议任务：

```text
引入 SQLite Job 存储
将 Job 状态流转补齐到 queued / processing / completed / failed
统一外部调用 timeout 工具
统一错误结构与日志字段
清理渲染链路中的重复计算
```

与 `CCmanagement-ios` 的关系：

- 主要参考其数据结构，不直接搬其本地 JSON 存储实现。

### P2：合同导出与后处理

目标：

- 在“合同起草”已稳定的基础上，补齐导出后的后处理动作。
- 让 DOCX / PDF / 归档 / 签名包的结果返回方式统一。

建议任务：

```text
统一 docxPath / pdfPath / remoteUrl 返回结构
补充归档服务接口
补充签名包制作服务接口
将导出结果接入 FileStore 抽象
明确“直接返回文件”与“返回远程 URL”的判定策略
```

建议顺序：

1. 先补 PDF / DOCX 结果结构统一
2. 再补归档接口
3. 最后补签名包制作

与 `CCmanagement-ios` 的关系：

- 可参考 `contract-rendering`、`gotenberg`、`signed-package` 的接口边界。
- 不需要照搬其完整合同生命周期页面和交互。

### P3：Web UI 同步完善

目标：

- 让云端 Web UI 从“只收草稿”升级为“可被本地轮询管理的编辑系统”。

建议任务：

```text
定义远端 Job 状态机
新增 GET /api/jobs/:id 查询接口
明确 remoteJobId / editUrl / status / updatedAt 字段
增加 completed / archived / failed / expired 等状态
本地轮询器实现 10~30 秒轮询
轮询完成后触发回飞书或导出动作
```

建议顺序：

1. 先补远端 Job 查询接口
2. 再补本地轮询器
3. 最后补编辑完成后的自动继续处理

鉴权建议：

- Web UI 保持独立鉴权体系。
- 第一版后续增强可考虑飞书登录，但不混入 Bot 主服务。

### P4：OCR / 证照能力完善

目标：

- 将当前“文本解析”升级为真正可用的图片 / 扫描件识别链路。

建议任务：

```text
引入真正的 OCR 引擎或多模态识别
图片 → OCR 文本 → 结构化解析 两段式拆分
支持身份证 / 护照 / 营业执照 / BR 证照
OCR 识别结果进入 party / company 资料库
补充 OCR 失败、低置信度、人工确认机制
```

建议顺序：

1. 先补“图片识别成文本”
2. 再复用现有正则/规则做结构化解析
3. 最后做人工确认与入库

与 `CCmanagement-ios` 的关系：

- 可参考其 `ocr-intake` 结构化解析逻辑。
- 不应把其当前实现误认为成熟 OCR。

### P5：模板体系完善

目标：

- 让模板从“可用”升级成“可维护、可版本化、可发布”。

建议任务：

```text
本地模板 registry
模板元数据 schema 固化
占位符映射校验
模板版本号管理
模板发布前验证
模板导入 / 导出
```

建议顺序：

1. 先固定模板 schema
2. 再做模板校验
3. 最后做模板管理界面

与 `CCmanagement-ios` 的关系：

- 强烈建议参考其 `template-admin` 和模板 metadata 结构。
- 第一版后期仍建议以本地模板为主，云端模板为可选项。

### P6：存储与数据层升级

目标：

- 从分散的本地 JSON 文件写法过渡到更稳定的数据层。

建议任务：

```text
Job 改用 SQLite
OCR 记录改用 SQLite
合同草稿改用 SQLite 或统一 repository
FileStore 抽象支持 local / remote
将 storage 选择从业务模块中剥离
```

建议顺序：

1. 先把 Job 存储切到 SQLite
2. 再迁移 OCR / 合同草稿
3. 最后统一 repository 接口

### P7：权限与鉴权完善

目标：

- 明确飞书侧、Web UI 侧、内部服务侧三套身份边界。

建议任务：

```text
飞书 userId / chatId 白名单
按工作区限制可用能力
Web UI 登录与权限模型
内部服务 Bearer Token / 签名校验
审计日志与操作来源记录
```

建议顺序：

1. 先做飞书白名单和工作区权限
2. 再做 Web UI 登录
3. 最后做更细粒度角色权限

### P8：归档 / 签名包 / 生命周期能力

目标：

- 把“合同起草工具”逐步扩展成“合同处理链路”。

建议任务：

```text
合同归档
签名包制作
签署状态跟踪
归档文件远程 URL 返回
合同版本历史
归档后的待办/提醒
```

建议顺序：

1. 先做归档
2. 再做签名包
3. 最后做完整生命周期状态和历史版本

与 `CCmanagement-ios` 的关系：

- 可参考其 lifecycle 和 signed-package 思路。
- 但应拆成独立服务能力，而不是先做完整后台。

### P9：多入口与平台化能力

目标：

- 在飞书入口稳定后，再考虑平台扩展。

建议任务：

```text
支持 Lark 国际版
支持 Telegram / Web / CLI 入口
文件知识库
每日汇总
任务成本统计
多用户协作
```

建议顺序：

1. Lark 国际版
2. CLI / Web 辅助入口
3. 再考虑 Telegram 等新平台

### 27.2 建议的第一批后续任务单

如果需要立刻开始后续迭代，建议先开以下任务：

```text
Task 1：SQLite Job 存储替换内存队列
Task 2：Web UI 远端 Job 查询接口 + 本地轮询器
Task 3：demo-service 统一导出结果结构（docx/pdf/remoteUrl）
Task 4：补 Gotenberg timeout 与降级逻辑
Task 5：抽象本地模板 registry 与模板校验
Task 6：将 OCR 拆成“识别文本”和“结构化解析”两段
```

这 6 个任务的优先级最高，因为它们最直接决定系统是否能从 MVP 走向稳定可用。

### 27.3 P1 文件级开发任务清单

以下清单用于把 `P1 主链路加固` 进一步细化到文件和模块层面。

#### Task 1：SQLite Job 存储替换内存队列

目标：

- 将 Job 从内存态提升为可持久化存储。
- 为后续 Worker 重启恢复、失败重试、轮询状态同步打基础。

建议新增/修改文件：

```text
src/storage/sqlite.ts
src/storage/job-repository.ts
src/orchestrator/job-manager.ts
src/orchestrator/queue.ts
src/models/types.ts
src/config/env.ts
```

建议内容：

- `sqlite.ts`
  - 初始化 SQLite 数据库连接。
  - 建立 `jobs` 表和必要索引。
- `job-repository.ts`
  - 封装 `createJob / getJob / updateJob / listPendingJobs / claimNextJob`。
- `job-manager.ts`
  - 从直接操作内存对象改为调用 repository。
- `queue.ts`
  - 从数组队列改为“从 SQLite 查待处理任务并 claim”。
- `types.ts`
  - 固定 JobStatus、Job、TaskPlan、ModuleResult 类型。
- `env.ts`
  - 增加 `SQLITE_PATH`、队列轮询间隔等配置项。

建议验收：

- 进程重启后，未完成 Job 仍可恢复。
- 同一 Job 不会被多个 Worker 重复消费。
- Job 状态可从 `received` 正确流转到 `queued` / `processing` / `completed` / `failed`。

#### Task 2：统一外部调用 timeout / retry / error 封装

目标：

- 所有出站调用都有一致的超时、错误码和重试行为。

建议新增/修改文件：

```text
src/utils/timeout.ts
src/utils/errors.ts
src/utils/http.ts
src/models/providers/openai.ts
src/models/providers/deepseek.ts
src/models/providers/qwen.ts
src/modules/web-ui/client.ts
src/modules/contract/demo-client.ts
```

建议内容：

- `timeout.ts`
  - 提供带 `AbortController` 的 timeout 工具。
- `errors.ts`
  - 统一定义 `TimeoutError / RetryableError / ExternalServiceError`。
- `http.ts`
  - 统一封装 `fetchJson / fetchBuffer / fetchText`。
  - 支持 `timeoutMs`、`retryable`、`retryCount`。
- provider / client 文件
  - 不直接裸调 `fetch`。
  - 全部接入统一 HTTP 封装。

建议验收：

- Gotenberg、模型 provider、Web UI API、demo-service 调用全部带 timeout。
- 失败日志能区分“超时”“网络错误”“服务端错误”“业务错误”。

#### Task 3：清理路由与执行链路的重复判断

目标：

- 让“归一化输入 → 路由 → 执行”只做一次关键判断。

建议新增/修改文件：

```text
src/orchestrator/normalize-input.ts
src/orchestrator/command-router.ts
src/orchestrator/job-manager.ts
src/models/types.ts
```

建议内容：

- `normalize-input.ts`
  - 保证 `command`、`chatId`、`hasUrl`、`attachments` 一次性归一化。
- `command-router.ts`
  - 路由结果统一输出 `TaskPlan`。
  - 不在 Worker 阶段重复做意图识别。
- `job-manager.ts`
  - 创建 Job 时保存 `plan`。
  - Worker 执行时直接消费 `plan`。

建议验收：

- 同一消息不会在 Adapter、Router、Worker 三层重复推断任务类型。
- `/深读 URL` 等覆盖命令在任何阶段都不会被默认规则抢走。

#### Task 4：统一日志与链路追踪字段

目标：

- 让每一条消息、每一次 Job、每一个外部服务调用都能被串起来。

建议新增/修改文件：

```text
src/utils/logger.ts
src/utils/ids.ts
src/orchestrator/job-manager.ts
src/adapters/feishu/reply.ts
src/modules/web-ui/client.ts
src/modules/contract/demo-client.ts
```

建议内容：

- `ids.ts`
  - 统一生成 `jobId`、`requestId`、`traceId`。
- `logger.ts`
  - 统一结构化日志格式。
- 各 client / manager
  - 日志中固定带 `jobId`、`chatId`、`messageId`、`provider`、`latencyMs`。

建议验收：

- 可以通过 `jobId` 找到一条任务的完整执行过程。
- 日志不输出密钥、token、完整敏感正文。

#### Task 5：demo-service 渲染链路去冗余

目标：

- 减少不必要的重复计算，缩短合同导出耗时。

建议新增/修改文件：

```text
demo-service/src/rendering/contract-rendering.ts
demo-service/src/routes/contracts-render.ts
demo-service/src/routes/contracts-draft.ts
demo-service/src/types.ts
```

如果第一版仍直接参考旧项目逻辑，则至少对应整理到：

```text
参考 D:\develop\CCmanagement-ios\src\lib\contract-rendering.ts
参考 D:\develop\CCmanagement-ios\src\app\api\contracts\render\route.ts
```

建议内容：

- 区分：
  - `buildDraftText`
  - `buildDocx`
  - `buildPdf`
- 避免一进导出 API 就先生成所有中间结果。
- `pdf` 分支只在确实需要时才生成 `docx` 或文本。

建议验收：

- `txt` 导出不触发 DOCX/PDF 相关计算。
- `docx` 导出不做多余 HTML / PDF 计算。
- `pdf` 导出路径清晰可追踪，并支持 Gotenberg 降级。

#### Task 6：Gotenberg timeout 与降级逻辑

目标：

- 避免 PDF 转换拖死 Worker。
- 保证 “DOCX 可返回、PDF 可降级”。

建议新增/修改文件：

```text
demo-service/src/integrations/gotenberg.ts
demo-service/src/rendering/contract-rendering.ts
demo-service/src/routes/contracts-draft.ts
src/modules/contract/demo-client.ts
```

建议内容：

- `gotenberg.ts`
  - 为 DOCX → PDF 转换增加 timeout。
  - 将 Gotenberg 错误归类为 retryable / non-retryable。
- `contract-rendering.ts`
  - PDF 失败时保留 DOCX 成果。
- `contracts-draft.ts`
  - 明确返回 `warnings`。
- `demo-client.ts`
  - 识别 `pdfPath = null` 为可接受降级，而不是整单报错。

建议验收：

- Gotenberg 停止时仍能成功返回合同摘要和 DOCX。
- Job 最终状态是 `completed_with_warning` 或等价结果，而不是统一记为失败。

#### Task 7：P1 建议参考的现有文件

可以优先参考以下文件，但要“抽思路，不原样照搬”：

```text
D:\develop\CCmanagement-ios\src\lib\contract-rendering.ts
D:\develop\CCmanagement-ios\src\lib\contract-drafts.ts
D:\develop\CCmanagement-ios\src\lib\storage.ts
D:\develop\CCmanagement-ios\src\lib\gotenberg.ts
D:\develop\CCmanagement-ios\src\app\api\contracts\render\route.ts
```

对应处理原则：

- `contract-rendering.ts`：参考渲染分层，不保留隐式 Supabase 回退。
- `contract-drafts.ts`：参考草稿字段，不保留整文件 JSON 回写。
- `storage.ts`：参考本地路径抽象，升级成统一 FileStore。
- `gotenberg.ts`：参考请求格式，补 timeout 与错误分类。
- `contracts/render/route.ts`：参考 API 边界，清理重复中间计算。

#### Task 8：P1 完成标准

当满足以下条件时，可以认为 `P1` 完成：

```text
Job 不再依赖纯内存存储
所有外部服务调用都带 timeout
Gotenberg 不可用时支持降级
路由结果在 Job 中持久化，Worker 不重复推断
日志可按 jobId 追踪完整链路
合同导出链路不再有明显重复计算
```

### 27.4 P2 文件级开发任务清单

`P2 合同导出与后处理` 的重点是统一结果结构，并把归档、签名包、远程 URL 这些后续动作服务化。

#### Task 1：统一导出结果结构

目标：

- 统一 `docxPath`、`pdfPath`、`remoteUrl`、`warnings`、`artifacts` 的返回格式。

建议新增/修改文件：

```text
demo-service/src/types.ts
demo-service/src/routes/contracts-draft.ts
demo-service/src/routes/contracts-render.ts
src/modules/contract/demo-client.ts
src/models/types.ts
```

建议内容：

- 定义统一的 `ContractArtifactsResult`。
- 允许同一任务同时返回本地文件和远程 URL。
- 在 Bot 侧统一解析，不因 `pdfPath = null` 直接视为失败。

建议验收：

- 同一个合同任务可稳定返回摘要、DOCX、PDF、remoteUrl 中的任意组合。

#### Task 2：归档接口服务化

目标：

- 将“归档”从页面逻辑中抽离成独立 API。

建议新增/修改文件：

```text
demo-service/src/routes/contracts-archive.ts
demo-service/src/services/archive-service.ts
demo-service/src/types.ts
src/modules/contract/demo-client.ts
```

建议内容：

- 支持 `POST /api/contracts/archive` 或等价路由。
- 输入为 `jobId`、合同标识、输出文件、归档策略。
- 输出为归档结果和可选 `remoteUrl`。

建议验收：

- 归档动作不依赖 Web UI 页面。
- 飞书 Bot 可调用并得到归档结果。

#### Task 3：签名包制作接口服务化

目标：

- 将签名包制作做成可独立调用的后处理服务。

建议新增/修改文件：

```text
demo-service/src/routes/contracts-signed-package.ts
demo-service/src/services/signed-package-service.ts
demo-service/src/types.ts
src/modules/contract/demo-client.ts
```

建议内容：

- 支持基于 `docx/pdf + 附件` 生成签名包。
- 允许直接返回文件或 `remoteUrl`。

建议验收：

- 签名包制作失败不会影响已生成的合同主文件。

#### Task 4：P2 建议参考文件

```text
D:\develop\CCmanagement-ios\src\lib\contract-rendering.ts
D:\develop\CCmanagement-ios\src\components\contract-signature-packager.tsx
D:\develop\CCmanagement-ios\src\app\api\contracts\signed-package\route.ts
```

### 27.5 P3 文件级开发任务清单

`P3 Web UI 同步完善` 的核心是让本地轮询真正可用。

#### Task 1：远端 Job 状态查询接口

目标：

- 为本地轮询提供稳定的云端查询接口。

建议新增/修改文件：

```text
web-ui/src/app/api/jobs/[jobId]/route.ts
web-ui/src/lib/jobs.ts
web-ui/src/lib/types.ts
```

建议内容：

- 返回 `remoteJobId`、`status`、`editUrl`、`updatedAt`、`artifacts`。
- 状态至少包含 `draft`、`editing`、`completed`、`archived`、`failed`、`expired`。

建议验收：

- 本地可按 `remoteJobId` 稳定轮询状态。

#### Task 2：本地轮询器

目标：

- 在本地 Orchestrator 内实现稳定轮询。

建议新增/修改文件：

```text
src/modules/web-ui/client.ts
src/modules/web-ui/poller.ts
src/orchestrator/job-manager.ts
src/storage/job-repository.ts
src/config/env.ts
```

建议内容：

- 保存 `remoteJobId`。
- 按 10~30 秒轮询。
- 命中 `completed` 后触发后续动作。

建议验收：

- 不需要长连接和回调，本地也能感知云端编辑完成。

#### Task 3：编辑完成后的自动续处理

目标：

- 让轮询完成后自动继续导出、回飞书或归档。

建议新增/修改文件：

```text
src/orchestrator/job-manager.ts
src/modules/web-ui/client.ts
src/modules/contract/demo-client.ts
src/adapters/feishu/reply.ts
```

建议验收：

- 云端编辑完成后，本地可自动进入下一步，无需手工重新投递。

### 27.6 P4 文件级开发任务清单

`P4 OCR / 证照能力完善` 的核心是把“识别”与“解析”拆开。

#### Task 1：OCR 文本识别层

目标：

- 支持图片、扫描 PDF、证照照片提取文字。

建议新增/修改文件：

```text
src/modules/image/ocr.ts
src/modules/document/pdf-ocr.ts
src/modules/image/provider.ts
src/models/types.ts
```

建议内容：

- 输入文件路径，输出纯文本和置信度。
- 与结构化解析完全分离。

建议验收：

- 图片/扫描件可以先得到 OCR 文本，再交给后续解析。

#### Task 2：证照结构化解析层

目标：

- 复用规则逻辑，把 OCR 文本映射成结构化字段。

建议新增/修改文件：

```text
src/modules/ocr/parse-document.ts
src/modules/ocr/document-types.ts
src/modules/ocr/normalizers.ts
```

建议参考：

```text
D:\develop\CCmanagement-ios\src\lib\ocr-intake.ts
```

建议验收：

- 身份证、护照、营业执照、BR 证支持结构化输出。

#### Task 3：人工确认与入库

目标：

- 低置信度识别结果进入人工确认流程。

建议新增/修改文件：

```text
src/modules/ocr/review.ts
src/modules/web-ui/client.ts
src/storage/ocr-repository.ts
```

建议验收：

- OCR 结果可推送到 Web UI 进行人工确认后再入库。

### 27.7 P5 文件级开发任务清单

`P5 模板体系完善` 的核心是“本地模板先稳定，再扩展远端模板”。

#### Task 1：本地模板 registry

目标：

- 把模板从分散配置收敛成统一 registry。

建议新增/修改文件：

```text
demo-service/src/templates/registry.ts
demo-service/src/templates/types.ts
demo-service/src/templates/local-templates.ts
demo-service/src/config/env.ts
```

建议验收：

- 所有本地模板都能通过统一入口被发现和读取。

#### Task 2：模板元数据 schema 与校验

目标：

- 固化模板字段、占位符映射、版本、编号规则。

建议新增/修改文件：

```text
demo-service/src/templates/schema.ts
demo-service/src/templates/validator.ts
demo-service/src/types.ts
```

建议参考：

```text
D:\develop\CCmanagement-ios\src\lib\template-admin.ts
```

建议验收：

- 模板发布前可以进行自动校验。

#### Task 3：模板导入 / 导出

目标：

- 让新增模板不必直接改代码。

建议新增/修改文件：

```text
demo-service/src/routes/templates-import.ts
demo-service/src/routes/templates-export.ts
demo-service/src/templates/importer.ts
```

建议验收：

- 可导入模板文件与 metadata，且校验失败时给出明确原因。

### 27.8 P6 文件级开发任务清单

`P6 存储与数据层升级` 的核心是统一 repository 和 FileStore。

#### Task 1：统一 repository 层

建议新增/修改文件：

```text
src/storage/job-repository.ts
src/storage/ocr-repository.ts
src/storage/contract-repository.ts
src/storage/repository-types.ts
```

建议内容：

- 业务层不直接读写 SQLite / JSON / 文件。
- 统一通过 repository 接口访问。

#### Task 2：FileStore local / remote 双实现

建议新增/修改文件：

```text
src/storage/file-store.ts
src/storage/file-store-local.ts
src/storage/file-store-remote.ts
src/config/env.ts
```

建议验收：

- 业务模块不依赖底层到底是本地目录还是对象存储。

### 27.9 P7 文件级开发任务清单

`P7 权限与鉴权完善` 的核心是明确三类身份边界。

#### Task 1：飞书侧白名单与工作区权限

建议新增/修改文件：

```text
src/config/env.ts
src/adapters/feishu/permission.ts
src/orchestrator/command-router.ts
```

建议内容：

- 支持 userId 白名单。
- 支持 chatId 对应的功能限制。

#### Task 2：Web UI 登录与角色权限

建议新增/修改文件：

```text
web-ui/src/lib/auth.ts
web-ui/src/lib/roles.ts
web-ui/src/middleware.ts
web-ui/src/app/login/page.tsx
```

建议内容：

- Web UI 独立鉴权。
- 可后续考虑飞书登录，但不混进 Bot。

#### Task 3：内部服务鉴权

建议新增/修改文件：

```text
src/modules/web-ui/client.ts
src/modules/contract/demo-client.ts
demo-service/src/middleware/auth.ts
web-ui/src/app/api/_middleware.ts
```

建议验收：

- 内部服务调用都需要 Bearer Token 或签名。

### 27.10 P8 文件级开发任务清单

`P8 归档 / 签名包 / 生命周期能力` 的核心是服务化，不做重后台先行。

#### Task 1：合同生命周期状态模型

建议新增/修改文件：

```text
demo-service/src/types.ts
demo-service/src/services/contract-lifecycle.ts
src/models/types.ts
```

建议内容：

- 定义 `draft / finalized / archived / signed / discarded` 等状态。

#### Task 2：版本历史与归档结果

建议新增/修改文件：

```text
demo-service/src/services/version-history.ts
demo-service/src/routes/contracts-history.ts
src/modules/contract/demo-client.ts
```

建议验收：

- 可查询某个合同的版本历史和归档结果。

#### Task 3：签署后处理

建议新增/修改文件：

```text
demo-service/src/services/post-signing.ts
demo-service/src/routes/contracts-post-sign.ts
```

建议验收：

- 签署完成后可生成归档包或远程下载地址。

### 27.11 P9 文件级开发任务清单

`P9 多入口与平台化能力` 要在飞书入口稳定后再推进。

#### Task 1：Lark 国际版适配

建议新增/修改文件：

```text
src/adapters/lark/client.ts
src/adapters/lark/message-parser.ts
src/adapters/lark/reply.ts
```

#### Task 2：CLI / Web 辅助入口

建议新增/修改文件：

```text
src/adapters/cli/index.ts
src/adapters/webhook-local/index.ts
```

#### Task 3：知识库与日报

建议新增/修改文件：

```text
src/modules/knowledge-base/index.ts
src/modules/daily-summary/index.ts
src/storage/knowledge-repository.ts
```

### 27.12 后续阶段完成判断

推荐按以下标志判断是否进入下一阶段：

```text
P2 完成：导出结果结构统一，归档/签名包具备独立接口
P3 完成：本地轮询云端编辑状态稳定可用
P4 完成：图片/扫描件可完成 OCR + 结构化解析
P5 完成：模板 registry / schema / 校验稳定
P6 完成：核心数据不再依赖整文件 JSON 回写
P7 完成：飞书、Web UI、内部服务三套权限边界清晰
P8 完成：归档、签名包、版本历史可独立运转
P9 完成：新增入口不破坏飞书主链路
```
---

## 28. 图片驱动研究能力补充

这一节用于明确：图片能力不应只被定义为“OCR 后转文字”。

系统至少要支持两类图片研究入口：

1. 飞书直接发送的图片
   例如截图、长图、拍照件、图片型公众号内容、海报、研报截图。

2. URL 页面中包含的图片
   特别是正文很少、主要信息都在图片里的页面，例如：
   - 图片型公众号文章
   - 长图新闻 / 海报页
   - 纯图片公告页
   - 网页正文中嵌入的表格截图 / 结论截图

### 28.1 能力边界

图片相关能力拆成三层：

```text
A. OCR 识别
图片 -> 识别可见文字 -> 返回 OCR 文本

B. 图片理解
图片 -> 识别版式 / 图表 / 截图语义 / 版面结构 -> 返回结构化描述

C. 图片驱动研究
单图或多图 -> OCR + 图片理解 -> 汇总成研究输入 -> 再进入总结 / 深读 / 查证链路
```

其中：

- `OCR` 是子能力，不应等同于全部图片能力。
- `image_understanding` 应支持“只看图像语义，不依赖完整 OCR 文本”。
- 当图片中既有文字又有图表/版面信息时，系统应尽量同时利用两部分信息。

### 28.2 推荐主链路

#### 场景 A：飞书直接发图片

```text
飞书图片消息
-> Bot 下载图片到本地
-> 创建 image Job
-> 多模态模型执行 OCR + 图片理解
-> 生成：
   - extractedText
   - imageSummary
   - warnings / confidence
-> 根据 chat_id 或显式命令
   - 直接回复摘要
   - 或进入后续研究 / 总结链路
```

#### 场景 B：URL 中图片驱动内容

```text
收到 URL
-> 网页抓取
-> 判断正文是否过短 / 图片占比是否过高
-> 抽取页面主图片或正文图片列表
-> 下载 1..N 张候选图片
-> 对图片执行 OCR + 图片理解
-> 将图片结果与可抓取正文合并
-> 再进入 article_precheck / article_research / article_verify / summarize
```

### 28.3 URL 图片页识别策略

对 URL 页面，建议增加一层“是否为图片驱动页面”判断：

```text
如果满足以下任一条件，可判定为图片驱动内容：
- 页面提取到的正文长度很短
- 正文候选块里图片数量明显多于文字段落
- 页面命中公众号等已知图片型站点特征
- 页面主要内容位于长图 / 大图容器
```

判定为图片驱动后：

- 不应只把残缺正文发给研究模型。
- 应优先补抓图片资源，再把图片识别结果拼进研究输入。

### 28.4 研究输入结构建议

图片驱动研究时，传给研究模型的输入建议统一成：

```ts
{
  urls: string[],
  articleText?: string,
  imageDocuments: [
    {
      sourceUrl?: string,
      localPath?: string,
      extractedText?: string,
      imageSummary?: string,
      confidence?: number,
      warnings?: string[]
    }
  ]
}
```

模型侧拿到的不是“原始图片 URL”，而是已经过本地预处理的图片研究材料。

### 28.5 MVP 与后续边界

MVP 建议先做到：

- 飞书直接发来的单张图片可进入 `image_understanding`
- 图片返回 OCR 文本 + 中文摘要
- 图片结果可进入后续总结链路
- Jobs 页面可查看图片任务输出、warning、provider 尝试链

二期再做：

- URL 页面中自动抽取正文图片
- 多图合并研究
- 图片与网页正文联合总结
- 图表 / 表格截图的更强结构化理解
- 图片低置信度人工确认流程

### 28.6 与现有模块的关系

现有模块建议这样分工：

```text
src/modules/vision/ocr-client.ts
负责图片输入的 OCR + 图片理解调用

src/modules/research/article-fetcher.ts
负责网页抓取、正文抽取，以及后续增加 URL 图片候选抽取

src/modules/research/ai-client.ts
负责将正文材料与图片材料合并后，发送给研究模型
```

### 28.7 当前实现状态说明

本节只保留方向性说明。阶段性实现进度、已知问题和待修改项统一记录到 `DEVELOPMENT_STATUS.md`，避免主设计文档持续混入版本状态信息。

当前与图片研究相关的后续重点仍包括：

- URL 页面内图片自动抽取
- 多图合并研究
- 图片结果自动并入文章深读 / 查证链路

这三项后续应按正式开发任务推进，而不应继续被视为“可选增强”。
## 29. 飞书主交互规范

这一节用于明确：

1. 员工的主要操作界面是飞书
2. 管理页是管理员和开发调试工具，不是员工主入口
3. “重试”“深读”“查证”“重新识别”等动作的语义必须统一
4. `chat_id` 路由、显式命令、二次操作三者的优先级必须固定

### 29.1 总体原则

交互层面应固定为以下原则：

1. 飞书是员工唯一主入口  
   员工不应被要求进入本地 Jobs 页面或后台页面来完成日常操作。

2. 默认自动处理，命令只做覆盖  
   用户主要通过“分享到不同飞书群”触发处理，不要求每次显式输入命令。

3. 结果消息必须支持继续操作  
   Bot 返回结果后，不应是一次性终点，而应允许员工基于结果继续发起下一步动作。

4. 管理页只面向管理员和开发  
   管理页负责排障、查看任务详情、查看 provider 尝试链、调试抽取质量、维护 `chat_id` 配置，不承担员工主交互。

5. 员工看到的是业务动作，不是技术概念  
   员工侧应看到“深读 / 查证 / 重新总结 / 重新识别 / 提取文字 / 继续研究”等动作，不应暴露 `job`、`provider`、`attempt`、`fallback` 等内部术语。

### 29.2 主交互入口

员工在飞书中的主要输入动作应固定为以下几类：

1. 直接分享 URL  
   例如从微信、浏览器、公众号文章页直接分享到飞书群。

2. 直接发送图片  
   例如截图、长图、证照、图文公告、图片型公众号内容。

3. 直接发送文件  
   例如 PDF、DOCX、TXT、PPT、扫描件。

4. 直接发送音频  
   例如语音、会议片段、录音。

5. 对上一条结果继续操作  
   例如“深读”“查证”“重新总结”“重新识别”。

### 29.3 路由优先级

员工交互遵循第 9 节定义的正式路由规则；本节只从员工视角总结其表现形式。

员工侧看到的优先级可理解为：

```text
1. 显式命令覆盖
2. chat_id 默认工作区路由
3. 输入类型兜底路由
```

解释如下：

- 如果用户显式输入 `/深读`、`/查证`、`/合同` 等命令，则命令优先。
- 如果没有显式命令，则优先按当前会话的 `chat_id` 绑定工作区和默认意图。
- 如果当前 `chat_id` 没有绑定规则，则再按输入类型和内容做兜底判断。

因此推荐交互应是：

- 大多数情况下：直接分享，不额外输入命令
- 少数需要覆盖默认行为的情况：再输入显式命令

### 29.4 结果消息规范

Bot 返回飞书结果时，应把每次返回视为“阶段性结果”，而不是最终终点。

返回消息建议至少包含：

1. 当前结果摘要  
   例如文章预读摘要、图片识别摘要、文件总结摘要。

2. 当前任务类型  
   便于用户理解当前是“预读结果”“图片识别结果”还是“合同结果”。

3. 下一步可继续动作  
   例如“深读 / 查证 / 重新总结 / 重新识别 / 提取文字 / 继续研究”。

4. 如有必要，可返回文件或链接  
   例如 `editUrl`、DOCX/PDF 文件、远程 `remoteUrl`。

### 29.5 飞书中的二次操作规范

员工侧的二次操作建议固定成业务动作，而不是底层实现动作。

#### A. 文章结果后的二次操作

- `深读`
- `查证`
- `重新总结`
- `继续研究`

#### B. 图片结果后的二次操作

- `提取文字`
- `重新识别`
- `继续研究`
- `总结图片内容`

#### C. 文件结果后的二次操作

- `总结`
- `提取重点`
- `继续分析`

#### D. 失败结果后的二次操作

- `重试`

这些动作在飞书中可以通过以下两种形式实现：

1. 回复短命令  
   例如在结果消息后回复“深读”“查证”“重试”。

2. 交互卡片按钮  
   后续如果接入飞书交互卡片，可把上述动作做成按钮。

第一版可优先采用“回复短命令”方案，后续再演进到交互卡片。

### 29.6 “重试”的语义规范

“重试”必须区分员工视角和管理员视角。

#### A. 员工侧重试

员工在飞书中看到的“重试 / 重新处理”，语义应定义为：

```text
我希望基于同样的原始输入，再得到一次新的处理结果
```

员工侧重试建议实现为：

- 重新创建一个新的 Job
- 保留旧 Job 历史不变
- 新旧两次结果彼此独立

原因：

- 员工不关心内部 attempt
- 新建 Job 更容易保留清晰历史
- 更适合后续做“重新总结 / 深读 / 换模型再试”之类动作

#### B. 管理员侧重试

管理员或开发在 Jobs 页点击 `Retry`，语义应定义为：

```text
对这个已有 Job 再执行一次，用于排障、回归验证或配置修复后的重跑
```

管理员侧重试可实现为：

- 将原 Job 重新置回 `queued`
- 或复制为一个内部重跑 Job

第一版建议：

- 员工侧：统一走“新建 Job”
- 管理员侧：保留“重入队旧 Job”能力

### 29.7 管理页职责边界

管理页只服务管理员和开发，职责固定为：

1. 查看任务列表与状态
2. 查看任务详情
3. 查看 provider 尝试链
4. 查看正文抽取质量
5. 查看图片候选与图片研究摘要
6. 查看失败原因
7. 手动重试
8. 维护 `chat_id` 路由配置
9. 查看系统 prompt 与调试信息

管理页不承担以下职责：

- 员工日常内容投递入口
- 员工主要操作面板
- 员工常规重试入口

### 29.8 员工视角的标准闭环

员工在飞书中的最小标准闭环应是：

```text
分享内容到飞书群
-> Bot 自动处理
-> Bot 返回阶段性结果
-> 员工按需继续回复“深读 / 查证 / 重新识别 / 重试”等动作
-> Bot 继续生成下一步结果
```

也就是说：

- 飞书负责“投递 + 查看结果 + 继续操作”
- 本地 Orchestrator 负责“路由 + 异步执行 + 调模型 + 调服务”
- 管理页负责“后台排障 + 管理配置 + 质量检查”

### 29.9 第一版实现建议

第一版建议先落地以下交互能力：

1. 员工直接分享 URL 到指定飞书群  
   系统按 `chat_id` 默认路由处理。

2. 员工直接发送图片到指定飞书群  
   系统进入 `image_understanding`，必要时继续进入研究链路。

3. 员工对结果消息回复短命令  
   第一批建议支持：
   - `深读`
   - `查证`
   - `重新总结`
   - `重新识别`
   - `重试`

4. Jobs 页保留管理员手动重试能力  
   但不作为员工主操作入口。

5. 后续再考虑飞书交互卡片  
   在主链路稳定后，再把常用动作升级成飞书卡片按钮。
## 30. Prompt 架构与工作区风格配置

这一节用于明确：

1. Prompt 不应只是零散的 system prompt 文本
2. Prompt 应拆成稳定层、任务层、工作区风格层、用户请求层、材料层
3. `chat_id` 可绑定默认 `promptProfile`
4. `promptProfile` 只影响风格和关注重点，不改变任务本质

### 30.1 Prompt 分层模型

建议把发给模型的 Prompt 结构固定为 5 层：

```text
Layer 1: System Prompt
Layer 2: Task / Mode Instructions
Layer 3: Workspace Prompt Profile
Layer 4: User Request
Layer 5: Source Context
```

#### Layer 1：System Prompt

作用：

- 定义模型在当前任务中的角色
- 定义基本原则
- 定义禁止行为
- 定义整体输出约束

例如：

- `article_precheck` 的 system prompt 负责定义“这是预读，不是深读”
- `article_verify` 的 system prompt 负责定义“严格区分已支持和未支持内容”
- `image_understanding` 的 system prompt 负责定义“先 OCR，再总结，再标不确定点”

这一层应尽量稳定，主要按 `mode` 决定，不按 `chat_id` 大量分叉。

#### Layer 2：Task / Mode Instructions

作用：

- 定义这次回答必须包含哪些结构
- 定义各部分顺序
- 定义长短和重点

例如：

- `article_precheck`
  - 主题
  - 核心要点
  - 是否值得深读
  - 建议下一步
  - 不确定点

- `article_research`
  - 核心观点
  - 关键论据
  - 证据与依据
  - 风险与局限
  - 行动建议
  - 待进一步确认

这一层是“任务结构层”，不应与工作区风格层混在一起。

#### Layer 3：Workspace Prompt Profile

作用：

- 定义同一任务在不同工作区中的风格偏好
- 控制输出长度、语气、关注重点和呈现方式
- 不改变任务本身，只改变回答风格

例如：

- `reading`
  - 偏通用摘要
  - 平衡长度
  - 清晰简洁

- `research`
  - 偏证据、争议点、待确认项
  - 结构化
  - 更审慎

- `management`
  - 偏结论、影响、下一步建议
  - 更短
  - 更汇报式

- `image-lab`
  - 偏识别文字、图像结构、可继续研究点
  - 强调不确定区域

这一层由 `chat_id` 默认绑定，必要时也可被命令覆盖。

#### Layer 4：User Request

作用：

- 保留用户本轮真实意图
- 表达用户额外要求
- 承担显式命令带来的覆盖效果

例如：

- “帮我总结”
- “重点看有没有风险”
- “请深读”
- “提取图片里的关键信息”

这一层最动态，不应被 profile 替代。

#### Layer 5：Source Context

作用：

- 提供模型实际依据
- 给出正文材料、图片材料、文件材料
- 标明质量、warning、confidence

例如：

- 抓到的网页正文
- 标题、摘要
- 图片 OCR 文本
- 图片理解摘要
- warnings / confidence

这一层决定模型“看到什么”，是输出质量的关键因素。

### 30.2 Prompt 合成顺序

最终发给模型时，逻辑上应组合为：

```text
System Prompt
+ Task / Mode Instructions
+ Workspace Prompt Profile
+ User Request
+ Source Context
= Final Prompt Package
```

推荐实现方式：

- `system prompt`：通过 `mode` 决定
- `answer requirements`：通过 `mode` 决定
- `workspace preference`：通过 `promptProfile` 决定
- `user request`：来自用户输入或命令覆盖
- `materials`：来自本地预处理后的正文、图片、文件内容

### 30.3 Prompt Profile 字段设计

建议把 `promptProfile` 做成结构化配置，而不是自由文本。

建议字段如下：

```ts
type PromptProfile = {
  id: string;
  displayName: string;
  answerStyle?: "brief" | "standard" | "detailed";
  outputFormat?: "paragraphs" | "bullets" | "decision";
  tone?: "neutral" | "formal" | "executive";
  focus?: string[];
  preferredSections?: string[];
  maxOutputLength?: "short" | "medium" | "long";
  notes?: string;
};
```

字段说明：

- `id`
  - 机器使用的唯一标识
  - 例如 `reading`、`research`、`management`

- `displayName`
  - 给管理员在配置页看到的名称

- `answerStyle`
  - 控制展开程度
  - `brief` 适合管理层
  - `detailed` 适合研究群

- `outputFormat`
  - 控制呈现形式
  - `paragraphs`：自然段
  - `bullets`：要点式
  - `decision`：结论导向

- `tone`
  - 控制措辞风格
  - `neutral`：中性
  - `formal`：正式
  - `executive`：汇报式

- `focus`
  - 控制重点维度
  - 例如：
    - `["evidence", "uncertainty", "risks"]`
    - `["conclusion", "impact", "next_actions"]`

- `preferredSections`
  - 可选
  - 用于轻微影响答案部分顺序
  - 第一版不建议过度使用

- `maxOutputLength`
  - 控制整体长度偏好

- `notes`
  - 仅供管理员查看
  - 不发给模型

### 30.4 推荐内置 Profile

第一版建议内置 4 组 profile：

#### `reading`

- `answerStyle=standard`
- `outputFormat=bullets`
- `tone=neutral`
- `focus=["topic", "key_points", "read_next"]`
- `maxOutputLength=medium`

#### `research`

- `answerStyle=detailed`
- `outputFormat=bullets`
- `tone=formal`
- `focus=["evidence", "uncertainty", "risks"]`
- `maxOutputLength=long`

#### `management`

- `answerStyle=brief`
- `outputFormat=decision`
- `tone=executive`
- `focus=["conclusion", "impact", "next_actions"]`
- `maxOutputLength=short`

#### `image-lab`

- `answerStyle=standard`
- `outputFormat=bullets`
- `tone=neutral`
- `focus=["ocr_text", "visual_structure", "uncertainty"]`
- `maxOutputLength=medium`

### 30.5 与 chat_id 路由配置的结合

当前 `chat route config` 建议从：

```ts
{
  mode,
  jobType,
  providerHint,
  replyMode
}
```

扩展为：

```ts
{
  mode,
  jobType,
  providerHint,
  replyMode,
  promptProfile
}
```

例如：

```json
{
  "chat-reading": {
    "mode": "article_precheck",
    "jobType": "article",
    "providerHint": "openai-compatible",
    "replyMode": "post",
    "promptProfile": "reading"
  },
  "chat-research": {
    "mode": "article_precheck",
    "jobType": "article",
    "providerHint": "openai-compatible",
    "replyMode": "post",
    "promptProfile": "research"
  },
  "chat-management": {
    "mode": "article_precheck",
    "jobType": "article",
    "providerHint": "openai-compatible",
    "replyMode": "post",
    "promptProfile": "management"
  }
}
```

这样可以保证：

- 同一 `mode` 在不同群里有不同风格
- 但底层任务能力仍然统一
- 不需要为每个群复制一套独立 prompt

### 30.6 Prompt Profile 的注入方式

不建议把 `promptProfile` 直接拼成一大段自由文本。

推荐做法：

- 把 profile 转成一段结构化的 `workspace preference`
- 注入到 user prompt 中

示例：

```text
Workspace preference:
- profile: management
- answer style: brief
- output format: decision
- tone: executive
- focus: conclusion, risks, next actions
- max output length: short
```

或中文形式：

```text
工作区偏好：
- 输出风格：简洁
- 输出形式：结论导向
- 语气：管理汇报风格
- 关注重点：结论、风险、下一步建议
```

这样可以做到：

- 对模型可见
- 对管理员可调
- 不污染 system prompt 主体
- 不与任务结构层混淆

### 30.7 管理页配置建议

`chat_id` 管理页建议增加一个新字段：

- `Prompt Profile`

第一版表现形式建议为下拉框：

- `default`
- `reading`
- `research`
- `management`
- `image-lab`

管理员配置一个群时，应至少能设置：

1. `Mode`
2. `Job Type`
3. `Provider Hint`
4. `Reply Mode`
5. `Prompt Profile`

不建议在第一版开放管理员直接编辑完整 prompt 文本，以免破坏统一性。

补充建议：
- 对统一研究群，`promptProfile` 可以留空，交给运行时自动判断。
- 只有当某个群明确长期偏向“主题/行业研究”或“公司/股票研究”时，再把 `promptProfile` 固定为 `sector-research` 或 `equity-research`。

### 30.8 Prepared Request 中应保留的字段

为便于后续调试和 prompt 优化，建议在 `preparedRequest` 中保留：

```ts
preparedRequest: {
  systemPrompt: string,
  answerRequirements: string,
  workspacePreference?: string,
  promptProfile?: string,
  promptProfileSelection?: "configured" | "inferred",
  promptProfileReason?: string,
  userPrompt: string,
  userPromptPreview: string,
  sourceDocumentCount: number,
  extractedDocuments: [...],
  imageResearchDocuments: [...],
  references: [...],
  searchExpansion?: {...}
}
```

这些字段用于：

- 在 Jobs 页查看实际发给模型的完整上下文
- 分析结果质量问题来自 prompt 还是材料
- 对不同 provider 做横向比较
- 在修改 prompt 后做回归验证
- 记录本轮研究究竟是手动指定 profile 还是运行时自动判断
- 保存文章来源、图片派生材料及摘要预览，供后续飞书 `post`、管理页和前端展示复用

### 30.9 第一版实现边界

第一版建议只做到：

1. 定义内置 `promptProfile`
2. 在 `ChatRouteConfig` 中新增 `promptProfile`
3. 在管理页中以枚举方式配置 `promptProfile`
4. 在 user prompt 中追加 `workspace preference`
5. 在 `preparedRequest` 中保存：
   - `promptProfile`
   - `promptProfileSelection`
   - `promptProfileReason`
   - `workspacePreference`
   - `answerRequirements`
   - 完整 `userPrompt`
   - `references`
6. 研究结果先产出结构化 `richTextBlocks`，供飞书 `post` 与前端共用

第一版不建议做：

- 每个群一套完全独立的 system prompt
- 管理页任意自由编辑 prompt 正文
- 让 `promptProfile` 改写底层 `mode` 逻辑
- 研究链路同步维护 `post + DOCX + PDF` 三套输出

也就是说：

- `mode` 决定“做什么”
- `promptProfile` 决定“怎么表达和偏什么重点”
- `user request` 决定“这一轮用户具体要什么”
### 30.10 Prompt 修改能力边界

第一版应明确区分：

#### A. Prompt 查看能力

第一版必须支持：

- 在管理页查看当前 system prompt
- 在 Jobs 页查看某次任务实际发送给模型的：
  - `systemPrompt`
  - `answerRequirements`
  - `workspacePreference`
  - `userPrompt`
  - `userPromptPreview`

也就是说，第一版至少要做到“可见”。

#### B. Prompt 风格配置能力

第一版建议开放的可修改能力仅限于：

- 通过 `chat_id` 配置页设置 `promptProfile`
- 通过 `promptProfile` 影响：
  - 输出长度偏好
  - 语气风格
  - 输出格式
  - 关注重点

也就是说，第一版允许“调风格”，但不允许任意改底层 prompt 正文。

#### C. 基础 Prompt 正文修改

第一版不建议在后台页面开放：

- 任意编辑完整 system prompt
- 任意编辑 mode 级任务结构说明
- 任意编辑图片理解基础 prompt

这些基础 prompt 仍应保留在代码中，由开发修改并版本管理。

原因：

- 基础 prompt 属于系统核心行为
- 任意在线修改风险高
- 容易破坏不同 mode 之间的一致性
- 容易让问题排查复杂化

#### D. 后续增强方向

后续如果确实需要后台修改 prompt，建议分两层推进：

1. 安全层
   - 页面可编辑 `promptProfile` 参数
   - 页面可编辑工作区附加说明
   - 不允许直接改 system prompt 主体

2. 高级层
   - 仅管理员可用
   - 允许编辑 mode 的附加 prompt 片段
   - 必须带版本记录、变更说明和回滚能力

因此，当前版本的正式边界应是：

- 现在：基础 prompt 改代码
- 第一版页面：改 `promptProfile`
- 后续增强：再考虑受控的 prompt 后台配置

## 31. 研究模式与知识沉淀补充

### 31.1 语言策略

系统应支持中文、英文、或中英混合材料输入，但默认研究输出统一为中文。

约束如下：

- 用户分享的文章、图片、截图、文件内容可以是中文、英文、或中英混合
- 模型应直接理解原始材料，不要求先完整翻译全文
- 默认输出必须为中文
- 如果原文中的公司名、技术名、方法名、产品名保留英文更清晰，可以在中文中保留英文原词或加括注
- 只有当用户显式要求英文或其他语言时，才覆盖默认中文输出

这是一条全局策略，不应只零散写在某个单独 prompt 中。

### 31.2 默认文章入口合并策略

默认文章入口应合并“总结”和“是否值得继续阅读”的判断，不建议把二者拆成两个彼此独立的主模式。

因此：

- `article_precheck` 作为默认文章入口
- `article_precheck` 的职责包含：
  - 文章主题与摘要
  - 核心要点提炼
  - 是否值得继续阅读的判断
  - 下一步建议
  - 不确定点说明

也就是说，默认分享一篇文章到飞书后，系统返回的不应只是“总结”，还应包含“值不值得继续投入时间阅读”的判断。

### 31.3 深读模式升级为扩展研究

正式 mode 已统一使用 `article_research`。`article_deep` 不再作为正式命名或代码配置项保留。

`article_research` 的语义不应仅理解为“针对文章本身做更长的深读”，而应升级为更贴近研究工作流的模式。

`article_research` 的目标应包括两部分：

1. 对文章本身做深度理解
2. 围绕文章中的关键线索做延伸研究

所谓关键线索，包括但不限于：

- 公司
- 技术
- 方法
- 产品
- 行业
- 政策
- 机构
- 人物

因此，`article_research` 不应只是“更长的摘要”，而应帮助用户从一篇文章延展出下一步的阅读与研究路径。

### 31.4 `article_research` 建议输出结构

这一节保留为基础结构说明；正式推荐结构以 31.10 为准。

基础结构可理解为：

1. 文章核心观点
2. 关键事实与论据
3. 重要线索提取
4. 线索扩展研究
5. 值得继续追踪的问题
6. 下一步阅读建议
7. 不确定点

其中：

- “重要线索提取”要求列出文中值得追踪的关键对象，并说明为什么重要
- “线索扩展研究”要求在不脱离现有材料边界的前提下，对这些线索给出背景解释和进一步阅读方向
- “下一步阅读建议”要求帮助用户建立后续阅读路径，而不是仅复述原文

### 31.5 扩展研究能力分阶段

扩展研究建议分两阶段推进：

#### 第一阶段：受限扩展研究

模型基于：

- 当前文章正文
- 页面图片识别结果
- 本轮输入上下文
- 模型已有背景知识

给出“围绕线索的背景解释与继续阅读方向”。

这一阶段不要求系统额外抓取更多外部资料。

对第一阶段再补充两点：
- 统一研究群可以先不区分 sector/equity 入口，而是在运行时根据文章标题、摘要、正文片段和用户问题自动判断更适合的研究视角。
- 自动判断只影响研究框架与关注重点，不改变基础 `mode`；因此仍保持“一个研究入口 + 一次合并返回”的交互方式。

#### 第二阶段：检索型扩展研究

系统后续可在关键线索识别后，再针对：

- 公司
- 技术
- 行业
- 政策
- 方法

发起二次检索与补充抓取，再生成更完整的扩展研究结果。

第一版可以先落一个最小可用版本：由 AI 规划 search query，再调用配置化 search API 拉取开放网页结果，并把可抓取正文并回研究链。
对于中文研究，可同时接入公众号文章搜索 provider，与通用网页搜索并行，再在本地做去重、来源分级和时间重排。
但需要明确：公众号搜索结果通常来自第三方检索页，排序和覆盖不保证严格按时间完整返回，因此只适合作为研究扩展源，不应在第一版承诺“严格增量、不漏结果”。
更完整的专题检索、来源分级和多轮扩展仍属于后续增强方向。

### 31.6 研究类任务是否拆成多步

研究类任务不建议一上来做开放式多轮 Agent，但建议按模式区分是否采用“两步式研究”。

建议：

- `article_precheck`：单步执行即可
- `summarize`：单步执行即可
- `general_chat`：单步执行即可
- `article_research`：建议后续升级为两步执行
- `article_verify`：建议后续升级为两步执行

推荐的两步结构：

#### Step 1：结构化研究笔记提取

先从当前材料中提取：

- 主题
- 关键事实
- 关键论点
- 关键线索
- 证据来源
- 不确定点

#### Step 2：最终研究结果合成

再基于结构化研究笔记输出：

- 深读结论
- 扩展研究
- 查证结果
- 后续阅读建议

这样做的目的：

- 提高长文章与多图材料场景下的稳定性
- 更容易控制证据边界
- 便于后续保存中间研究笔记到本地知识库
- 便于不同研究模式复用同一份中间材料

### 31.7 本地知识库方向

系统应支持基于飞书输入内容逐步建立本地知识库。

第一版不要求立即做成完整的 RAG 或复杂知识图谱系统，但需求中应明确“研究沉淀”是长期方向。

建议本地知识库初期沉淀以下三类内容：

#### A. 原始材料

- 原始消息
- URL
- 抓取正文
- 图片 OCR 文本
- 文件抽取文本
- 音频转写文本

#### B. 研究结果

- 预读结果
- 扩展研究结果
- 查证结果
- 图片理解结果
- 结构化研究笔记

#### C. 线索对象

- 公司
- 技术
- 方法
- 行业主题
- 政策主题
- 用户持续追踪的问题

### 31.8 本地知识库的第一版定位

第一版本地知识库定位建议为：

- 可持久化
- 可关联
- 可按消息与主题回溯
- 可作为后续研究的沉淀层

第一版不要求：

- 完整问答检索
- 自动知识图谱可视化
- 复杂实体消歧
- 多跳推理

也就是说，第一版应先把“消息、材料、研究结果、线索对象”沉下来，而不是急着把知识库做成复杂搜索引擎。

### 31.9 `article_research` 的扩面研究要求

`article_research` 不应只停留在“文章本身的深读”或“更长的摘要”。

对于很多投资、产业、技术、方法论相关内容，用户真正希望得到的是：

1. 对文章本身的理解
2. 对文章中关键线索的扩展研究
3. 对相关行业、公司、技术路线、产业链位置的扩面扫描

因此，`article_research` 的目标应明确升级为：

- 文章深度理解
- 线索提取
- 线索扩展研究
- 行业与公司扩面
- 初步研究判断
- 后续研究路径建议

补充要求：
- 当材料明显更像行业、赛道、技术路线或政策文章时，优先按 `sector-research` 视角组织结果。
- 当材料明显更像个股、公司、财报、估值、目标价或卖方点评时，优先按 `equity-research` 视角组织结果。
- 如果用户或 `chat_id` 已显式指定 `promptProfile`，则显式指定优先于自动判断。
- 第一版的“可信内容保存”至少应覆盖：当前轮输入、抓取到的原文材料、图片派生摘要，以及扩展搜索得到的开放网页 / 公众号文章来源链接与摘要预览。

### 31.10 `article_research` 输出结构升级

建议将以下结构作为 `article_research` 的正式标准输出结构：

1. 文章核心观点
2. 关键事实与论据
3. 重要线索提取
4. 线索扩展研究
5. 行业与公司扩面
6. 初步结论与研究判断
7. 值得继续追踪的问题
8. 下一步阅读与研究路径
9. 不确定点

返回策略建议：
- 首发默认一次性返回合并后的研究结果，而不是先发 sector 再发 equity 两条独立消息。
- 主题/行业研究为主体结构；当材料自然映射到公司、股票或头部厂商路线时，再在对应段落中补充公司与股票映射。
- 返回体除 `summary` 外，还应同步生成结构化 `richTextBlocks`，用于飞书 `post` 和前端展示复用。
- `richTextBlocks` 中应包含：研究模式、采用的研究视角、来源链接与摘要预览、正文研究结果。
- 当来源属于扩展搜索时，建议同时保留来源类型、来源层级、公众号账号信息（如可得）、原始发布时间文本等调试字段，便于后续前端展示和可信度判断。

各段落职责建议如下：

#### 1. 文章核心观点

- 用简洁中文概括文章最核心的判断或论点
- 不要求长，但要抓住主轴

#### 2. 关键事实与论据

- 提取文章中最重要的事实、数据、论据、案例
- 明确哪些内容是文章直接给出的

#### 3. 重要线索提取

- 抽取文中值得继续追踪的关键对象或主题
- 线索可以包括：
  - 公司
  - 技术
  - 方法
  - 产品
  - 行业
  - 政策
  - 机构
  - 人物
- 每个线索应简要说明“为什么重要”

#### 4. 线索扩展研究

- 不只是复述原文
- 应围绕上一段提取出的线索，给出背景解释、相关上下游、相关技术路线、相关应用场景或竞争格局的初步延展
- 但必须保持边界意识，不能把未经支持的推测写成事实

#### 5. 行业与公司扩面

这是 `article_research` 新增的重点能力。

如果文章自然映射到某个行业、细分赛道、产业链环节、技术路线或公司群体，模型不应只给一两个例子，而应尽量扩展出一个更有研究价值的样本池。

建议优先覆盖以下维度中的可得部分：

- 行业总量 / 市场空间
- 行业壁垒
- 关键技术
- 产业链位置
- 主要头部企业
- 可比公司
- 是否上市
- 市值
- 销售额 / 营收
- 利润 / 盈利能力

要求：

- 优先“扩面”，再逐步深入
- 不要只给 1 到 2 家代表公司就停止
- 如果无法给出精确数据，也应至少给出：
  - 候选公司池
  - 细分环节划分
  - 后续应查哪些关键数据
- 对不确定或可能过时的信息要显式标注

#### 6. 初步结论与研究判断

这部分允许输出相对表层、但对用户有用的阶段性判断。

例如：

- 这个方向更像主题机会还是基本面机会
- 更偏技术驱动、政策驱动还是需求驱动
- 更值得跟踪龙头、上游、设备、材料还是应用端
- 当前研究价值高低的初步判断

要求：

- 可以给结论，但要保持“初步判断”的语气
- 不应伪装成已经完成了完整专题研究

#### 7. 值得继续追踪的问题

- 输出后续值得持续追踪的关键问题
- 这些问题应有助于用户未来建立自己的知识库和研究列表

#### 8. 下一步阅读与研究路径

这一段不应只给“下一步阅读建议”，还应给“下一步研究路径”。

建议分层表达：

- 先补什么背景
- 再看哪些公司 / 技术 / 环节
- 再查哪些关键指标
- 再比较哪些竞争对手

这样用户拿到的不只是“去看什么”，而是一条更像研究路线图的建议。

#### 9. 不确定点

- 显式说明材料不足、OCR 不清、图片歧义、信息可能过时、扩展判断不够稳的地方
- 这是控制幻觉和边界的重要段落

### 31.11 扩面研究的 Prompt 要求

为了避免模型只给出极少量样本，`article_research` 的 prompt 应明确包含以下原则：

- 当主题自然对应一组公司、技术路线、产业链环节或行业参与者时，不要只停留在一两个例子
- 优先扩展出一个“代表性样本池”
- 优先 breadth first，再 deep dive
- 即使精确数据不足，也应先给：
  - 研究框架
  - 样本池
  - 细分环节
  - 后续应核查的数据点

也就是说，这个模式的目标不再只是“回答这一篇文章”，而是借这篇文章为入口，把用户的研究面和参考面先铺开一层。

### 31.12 第一阶段与第二阶段的边界

需要明确一点：

仅依赖当前文章材料和模型已有知识，仍然很难稳定产出完整、最新、覆盖充分的：

- 行业总量
- 公司池
- 上市状态
- 市值
- 营收
- 利润

因此，`article_research` 应分两阶段理解：

#### 第一阶段：Prompt 增强的扩面研究

基于：

- 当前文章正文
- 图片识别内容
- 本轮用户输入
- 模型已有背景知识

先产出：

- 研究框架
- 线索对象
- 扩展研究方向
- 初步行业/公司池
- 初步研究判断

这是当前版本应优先实现的目标。

#### 第二阶段：检索增强的专题研究

后续系统可进一步在关键线索识别后，针对：

- 公司
- 行业
- 技术
- 方法
- 政策

发起二次抓取、补充检索、专题聚合，再生成更完整的行业与公司研究结果。

对于你当前的目标，第一阶段先把“扩面意识”和“研究路径”写进 prompt 与输出结构，第二阶段再逐步把检索增强接上，是更稳妥的演进路径。
