# Development Status

## 1. 用途

这个文件用于记录：

- 当前开发进度
- 已实现能力
- 已知问题
- 下一步待修改项

设计目标、长期架构和接口规范仍放在 `feishu_local_ai_orchestrator_dev_doc.md` 中；阶段性状态和待办不再混入主设计文档。

---

## 2. 当前状态

截至当前代码状态，项目已具备以下基础能力：

- Node.js + TypeScript 项目骨架
- SQLite Job 存储
- 本地队列、Job 恢复、Review Poller
- `chat_id` 路由配置持久化
- 管理页可维护 `chat_id` 路由
- Research / OCR / demo-service / Web UI 客户端骨架
- 管理页可查看 Jobs、Prompt Profile、路由配置
- 已新增 `sector-research` 与 `equity-research` Prompt Profile，分别覆盖主题研究与股票/投资逻辑研究
- 统一研究群已支持在未显式指定 `promptProfile` 时自动判断更适合 `sector-research` 还是 `equity-research`
- 研究结果已同步产出结构化 `richTextBlocks`，可直接作为飞书 `post` / 前端展示的基础载荷
- `preparedRequest.references` 已保存文章来源、图片派生材料与摘要预览，便于后续展示与检索增强
- 已新增可插拔扩展搜索框架：AI 先生成检索 query，再调用配置化 search API 拉开放网页结果，并把可抓取正文并回研究链
- 管理页已可查看扩展搜索的 query 规划、结果列表与封闭来源覆盖提示
- 扩展搜索已支持“通用网页搜索 + 公众号文章搜索”双路并行，并统一去重、排序和回灌研究链
- 公众号结果会尽量补充 `wechatBiz`、公众号名称、发布时间与来源层级，但仍受搜狗结果覆盖和反爬限制影响
- 扩展搜索策略已升级为“先提炼扩展点（含理由）-> 再按扩展点生成定向 query -> 抓取后做质量打分筛选”，减少只做格式化总结的问题
- 通用网页搜索除 `SEARCH_API_URL` 外，已支持直接使用 Google Custom Search API（`GOOGLE_SEARCH_API_KEY` + `GOOGLE_SEARCH_CX`）
- 日志已新增扩展搜索阶段节点（`research_search.expand.start/query.start/expand.complete`），方便观察是否已进入扩展分析

当前已确认的 `chat_id` 路由 canonical schema：

```ts
type ChatRouteConfig = {
  mode: TaskMode;
  jobType?: JobType;
  providerHint?: string;
  promptProfile?: string;
  replyMode?: "text" | "post" | "file" | "mixed";
};
```

当前本地配置示例：

```json
{
  "chat-contract": {
    "mode": "contract_draft",
    "jobType": "contract",
    "replyMode": "mixed"
  }
}
```

---

## 3. 文档已统一的决定

- 正式文章深读 mode 统一为 `article_research`
- `article_deep` 已从当前代码与配置入口中清理
- 历史数据库中的 `article_deep` 记录已迁移为 `article_research`
- Web UI 推送属于首发范围
- 执行链保持异步 Job 模型，不再建议同步直执
- `chat_id` 配置以 `mode / jobType / providerHint / promptProfile / replyMode` 为准
- 研究链路首发优先走飞书 `post`，暂不为研究结果额外导出 `DOCX/PDF`

---

## 4. 已知待清理项

### P2

- `promptProfile` 目前主要在 research 链路中发挥作用，图片、合同等链路尚未完全统一
- 文档中仍有少量阶段性“当前实现状态”文字，后续可继续迁移到本文件
- 路由说明虽然已统一，但后续增量章节仍应引用单一规范，避免再次分叉
- “可信内容扩展搜索”已具备可插拔接入框架，但默认环境尚未绑定生产级 search provider；未配置时仍只依赖本轮输入和抓取到的原文/图片派生来源
- 中文高价值内容仍大量分布在微信公众号、小红书、知识星球等封闭或半封闭环境；这部分不能依赖开放搜索稳定覆盖，仍需用户直投 URL、截图或 OCR 材料
- 公众号搜索结果会做本地时间重排和去重，但这不等于搜狗结果本身按时间完整返回，因此不能承诺“严格增量、不漏更”

---

## 5. 首发范围

首发按以下闭环推进：

- 飞书收消息
- 统一输入归一化
- `chat_id` / command 路由
- Job 异步执行
- URL 文章预读
- URL 深读 / 扩展研究
- 合同起草
- 图片 OCR / 图片理解
- 音频转文字
- 文件总结 / 文件处理
- 推送到 Web UI 编辑
- 飞书回传文本 / 文件 / 编辑链接
- 研究结果优先回飞书 `post`

---

## 6. 下一步建议

优先继续做：

1. 核对所有模块的 `replyMode` 使用是否一致
2. 验证 Web UI 首发闭环：创建任务、返回 `editUrl`、轮询状态、编辑后续处理
3. 补强 `chat_id` 路由管理页与实际运行配置的一致性检查
4. 继续把新增实现进展记录到本文件，而不是回写到主设计文档
