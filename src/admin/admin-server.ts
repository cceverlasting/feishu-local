import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Env } from "../config/env.js";
import type { ChatRouteConfig, Job, TaskMode } from "../models/types.js";
import {
  isPromptProfileId,
  listPromptProfiles,
  listPromptSpecs
} from "../modules/prompts/prompt-registry.js";
import { ChatRouteService } from "../orchestrator/chat-route-service.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { Logger } from "../utils/logger.js";

interface AdminServerOptions {
  env: Env;
  logger: Logger;
  chatRouteService: ChatRouteService;
  jobRepository: JobRepository;
}

const taskModes: TaskMode[] = [
  "article_precheck",
  "article_research",
  "article_verify",
  "contract_draft",
  "contract_review",
  "email_draft",
  "summarize",
  "speech_to_text",
  "image_understanding",
  "file_processing",
  "web_edit",
  "general_chat"
];

export class AdminServer {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly chatRouteService: ChatRouteService;
  private readonly jobRepository: JobRepository;
  private started = false;

  constructor(options: AdminServerOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.chatRouteService = options.chatRouteService;
    this.jobRepository = options.jobRepository;
  }

  start() {
    if (this.started || this.env.ADMIN_SERVER_PORT === 0) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handle(request, response);
    });

    server.listen(this.env.ADMIN_SERVER_PORT, () => {
      this.logger.info("admin_server.start", {
        port: this.env.ADMIN_SERVER_PORT
      });
    });

    this.started = true;
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

      if (request.method === "GET" && url.pathname === "/health") {
        this.respondJson(response, 200, { ok: true });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/chat-routes") {
        this.respondJson(response, 200, {
          routes: this.chatRouteService.listRoutes(),
          taskModes,
          promptProfiles: listPromptProfiles()
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/prompts") {
        this.respondJson(response, 200, {
          prompts: listPromptSpecs(),
          promptProfiles: listPromptProfiles()
        });
        return;
      }

      if (request.method === "PUT" && url.pathname.startsWith("/api/chat-routes/")) {
        const chatId = decodeURIComponent(url.pathname.replace("/api/chat-routes/", ""));
        const payload = await this.readJsonBody(request);
        const route = validateRoutePayload(payload);
        const routes = await this.chatRouteService.upsertRoute(chatId, route);
        this.respondJson(response, 200, { ok: true, routes });
        return;
      }

      if (request.method === "DELETE" && url.pathname.startsWith("/api/chat-routes/")) {
        const chatId = decodeURIComponent(url.pathname.replace("/api/chat-routes/", ""));
        const routes = await this.chatRouteService.removeRoute(chatId);
        this.respondJson(response, 200, { ok: true, routes });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/jobs") {
        const status = url.searchParams.get("status");
        const jobs = status
          ? this.jobRepository.listByStatus(status as Job["status"])
          : this.jobRepository.listRecent(20);
        this.respondJson(response, 200, { jobs });
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/api/jobs/")) {
        const jobId = decodeURIComponent(url.pathname.replace("/api/jobs/", ""));
        const job = this.jobRepository.getById(jobId);
        if (!job) {
          this.respondJson(response, 404, { ok: false, error: "Job not found" });
          return;
        }
        this.respondJson(response, 200, { job });
        return;
      }

      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/admin/chat-routes")) {
        this.respondHtml(response, renderChatRoutePage(this.env.ADMIN_SERVER_PORT));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/prompts") {
        this.respondHtml(response, renderPromptPage(this.env.ADMIN_SERVER_PORT));
        return;
      }

      if (request.method === "GET" && url.pathname === "/admin/jobs") {
        this.respondHtml(response, renderJobsPage(this.env.ADMIN_SERVER_PORT));
        return;
      }

      this.respondJson(response, 404, { ok: false, error: "Not found" });
    } catch (error) {
      this.logger.error("admin_server.request_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      this.respondJson(response, 500, { ok: false, error: "Internal server error" });
    }
  }

  private respondJson(response: ServerResponse, statusCode: number, body: unknown) {
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(body));
  }

  private respondHtml(response: ServerResponse, body: string) {
    response.statusCode = 200;
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(body);
  }

  private async readJsonBody(request: IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? (JSON.parse(raw) as unknown) : {};
  }
}

function validateRoutePayload(payload: unknown): ChatRouteConfig {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid route payload.");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.mode !== "string") {
    throw new Error("mode is required.");
  }

  const route: ChatRouteConfig = {
    mode: record.mode as TaskMode
  };

  if (typeof record.jobType === "string" && record.jobType.trim().length > 0) {
    route.jobType = record.jobType as NonNullable<ChatRouteConfig["jobType"]>;
  }
  if (typeof record.providerHint === "string" && record.providerHint.trim().length > 0) {
    route.providerHint = record.providerHint.trim();
  }
  if (typeof record.promptProfile === "string" && record.promptProfile.trim().length > 0) {
    if (!isPromptProfileId(record.promptProfile.trim())) {
      throw new Error("promptProfile is invalid.");
    }
    route.promptProfile = record.promptProfile.trim();
  }
  if (typeof record.replyMode === "string" && record.replyMode.trim().length > 0) {
    route.replyMode = record.replyMode as NonNullable<ChatRouteConfig["replyMode"]>;
  }

  return route;
}

function renderBaseStyles() {
  return `
    :root {
      color-scheme: light;
      --bg: #f4f1ea;
      --panel: #fffdf9;
      --ink: #17212b;
      --accent: #aa5b2f;
      --line: #ded2c4;
      --muted: #5a6773;
      --danger: #a63b26;
      --soft: #fff7ef;
    }
    body {
      margin: 0;
      font-family: "Segoe UI", "PingFang SC", sans-serif;
      background: radial-gradient(circle at top, #fff8ec, var(--bg));
      color: var(--ink);
    }
    main {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px 20px 56px;
    }
    h1 {
      font-size: 28px;
      margin: 0 0 8px;
    }
    h2, h3 {
      margin: 0 0 12px;
    }
    p {
      color: var(--muted);
    }
    nav {
      display: flex;
      gap: 10px;
      margin: 16px 0 24px;
      flex-wrap: wrap;
    }
    nav a {
      text-decoration: none;
      color: var(--ink);
      border: 1px solid var(--line);
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(255, 253, 249, 0.9);
    }
    .grid {
      display: grid;
      grid-template-columns: 1.1fr 1fr;
      gap: 20px;
      align-items: start;
    }
    .wide-grid {
      display: grid;
      grid-template-columns: minmax(320px, 0.9fr) minmax(420px, 1.2fr);
      gap: 20px;
      align-items: start;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 18px;
      padding: 18px;
      box-shadow: 0 14px 30px rgba(74, 51, 29, 0.08);
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 10px 8px;
      border-bottom: 1px solid #efe6db;
      text-align: left;
      vertical-align: top;
      font-size: 14px;
    }
    input, select, button, textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #ccb8a1;
      font: inherit;
    }
    button {
      background: var(--accent);
      color: white;
      border: none;
      cursor: pointer;
      font-weight: 600;
    }
    button.secondary {
      background: #e8ddd0;
      color: var(--ink);
    }
    .row {
      display: grid;
      gap: 10px;
      margin-bottom: 12px;
    }
    .status {
      font-size: 13px;
      min-height: 18px;
      color: var(--muted);
    }
    .job-list {
      max-height: 520px;
      overflow: auto;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: #f1e5d5;
      font-size: 12px;
    }
    .warning-badge {
      background: #f7d9b5;
      color: #6b3f1f;
      margin-right: 6px;
      margin-bottom: 6px;
    }
    .prompt-card {
      padding: 16px;
      border: 1px solid #efe6db;
      border-radius: 16px;
      background: #fffaf3;
      margin-bottom: 14px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      background: #f7f1e7;
      border: 1px solid #eadcc9;
      border-radius: 12px;
      padding: 12px;
      font-size: 13px;
      line-height: 1.55;
      overflow: auto;
    }
    .job-button {
      width: 100%;
      text-align: left;
      border: 1px solid #eadcc9;
      background: transparent;
      color: var(--ink);
      padding: 10px 12px;
      border-radius: 12px;
      margin-bottom: 10px;
    }
    .job-button:hover {
      background: var(--soft);
    }
    .muted {
      color: var(--muted);
      font-size: 13px;
    }
    .kv {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 8px 12px;
      margin-bottom: 14px;
      font-size: 14px;
    }
    .kv strong {
      color: var(--muted);
    }
    .code-block {
      margin-top: 12px;
    }
    details {
      margin-top: 12px;
      border: 1px solid #eadcc9;
      border-radius: 12px;
      background: #fcf6ee;
      overflow: hidden;
    }
    summary {
      cursor: pointer;
      list-style: none;
      padding: 12px 14px;
      font-weight: 600;
      background: #fff7ef;
    }
    details > div {
      padding: 12px 14px 14px;
    }
    @media (max-width: 920px) {
      .grid, .wide-grid {
        grid-template-columns: 1fr;
      }
    }
  `;
}

function renderNav(active: "routes" | "prompts" | "jobs") {
  const items = [
    { href: "/admin/chat-routes", label: "Chat Routes", active: active === "routes" },
    { href: "/admin/prompts", label: "System Prompts", active: active === "prompts" },
    { href: "/admin/jobs", label: "Jobs", active: active === "jobs" }
  ];

  return `<nav>${items
    .map(
      (item) =>
        `<a href="${item.href}" style="${item.active ? "border-color:#aa5b2f;background:#fff1df;" : ""}">${item.label}</a>`
    )
    .join("")}</nav>`;
}

function renderChatRoutePage(port: number) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chat Route Admin</title>
  <style>${renderBaseStyles()}</style>
</head>
<body>
  <main>
    <h1>Chat Route Admin</h1>
    <p>Manage default routing by <code>chat_id</code>. Service address: <code>http://127.0.0.1:${port}</code></p>
    ${renderNav("routes")}
    <div class="grid">
      <section class="panel">
        <h2>Route Config</h2>
        <div class="status" id="status"></div>
        <div class="row"><input id="chatId" placeholder="chat-contract" /></div>
        <div class="row"><select id="mode"></select></div>
        <div class="row"><input id="jobType" placeholder="contract / article / image" /></div>
        <div class="row"><input id="providerHint" placeholder="optional providerHint" /></div>
        <div class="row"><select id="promptProfile">
          <option value="">default</option>
        </select></div>
        <div class="row"><select id="replyMode">
          <option value="">default</option>
          <option value="text">text</option>
          <option value="post">post</option>
          <option value="file">file</option>
          <option value="mixed">mixed</option>
        </select></div>
        <div class="row" style="grid-template-columns: 1fr 1fr;">
          <button id="save">Save Route</button>
          <button id="delete" class="secondary">Delete Route</button>
        </div>
        <table>
          <thead><tr><th>chat_id</th><th>config</th></tr></thead>
          <tbody id="routeRows"></tbody>
        </table>
      </section>
      <section class="panel">
        <h2>Recent Jobs</h2>
        <div class="job-list">
          <table>
            <thead><tr><th>ID</th><th>status</th><th>mode</th><th>summary</th></tr></thead>
            <tbody id="jobRows"></tbody>
          </table>
        </div>
      </section>
    </div>
  </main>
  <script>
    async function load() {
      const [routeRes, jobRes] = await Promise.all([fetch('/api/chat-routes'), fetch('/api/jobs')]);
      const routeData = await routeRes.json();
      const jobData = await jobRes.json();
      document.getElementById('mode').innerHTML = routeData.taskModes.map((item) => '<option value="' + item + '">' + item + '</option>').join('');
      document.getElementById('promptProfile').innerHTML = ['<option value="">default</option>'].concat((routeData.promptProfiles || []).map((item) => '<option value="' + item.id + '">' + escapeHtml(item.displayName) + '</option>')).join('');
      renderRoutes(routeData.routes);
      renderJobs(jobData.jobs);
    }
    function renderRoutes(routes) {
      const rows = document.getElementById('routeRows');
      const entries = Object.entries(routes);
      rows.innerHTML = entries.map(([chatId, route]) => '<tr><td><button class="secondary pick" data-chat="' + chatId + '">' + chatId + '</button></td><td><div><span class="badge">' + route.mode + '</span></div><div>' + (route.jobType || '') + ' ' + (route.replyMode || '') + ' ' + (route.providerHint || '') + ' ' + (route.promptProfile || '') + '</div></td></tr>').join('') || '<tr><td colspan="2">No routes yet</td></tr>';
      document.querySelectorAll('.pick').forEach((button) => {
        button.addEventListener('click', () => {
          const route = routes[button.dataset.chat];
          document.getElementById('chatId').value = button.dataset.chat;
          document.getElementById('mode').value = route.mode;
          document.getElementById('jobType').value = route.jobType || '';
          document.getElementById('providerHint').value = route.providerHint || '';
          document.getElementById('promptProfile').value = route.promptProfile || '';
          document.getElementById('replyMode').value = route.replyMode || '';
        });
      });
    }
    function renderJobs(jobs) {
      const rows = document.getElementById('jobRows');
      rows.innerHTML = jobs.map((job) => '<tr><td><code>' + escapeHtml(job.id.slice(0, 12)) + '</code></td><td>' + escapeHtml(job.status) + '</td><td>' + escapeHtml(job.mode || '') + '</td><td>' + escapeHtml(job.inputSummary) + '</td></tr>').join('') || '<tr><td colspan="4">No jobs yet</td></tr>';
    }
    function setStatus(text, isError) {
      const el = document.getElementById('status');
      el.textContent = text;
      el.style.color = isError ? '#b42318' : '#5d6a75';
    }
    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
    document.getElementById('save').addEventListener('click', async () => {
      const chatId = document.getElementById('chatId').value.trim();
      if (!chatId) return setStatus('Please enter chat_id', true);
      const payload = {
        mode: document.getElementById('mode').value,
        jobType: document.getElementById('jobType').value.trim() || undefined,
        providerHint: document.getElementById('providerHint').value.trim() || undefined,
        promptProfile: document.getElementById('promptProfile').value || undefined,
        replyMode: document.getElementById('replyMode').value || undefined
      };
      const response = await fetch('/api/chat-routes/' + encodeURIComponent(chatId), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) return setStatus('Save failed', true);
      setStatus('Saved route for ' + chatId, false);
      await load();
    });
    document.getElementById('delete').addEventListener('click', async () => {
      const chatId = document.getElementById('chatId').value.trim();
      if (!chatId) return setStatus('Please enter chat_id', true);
      const response = await fetch('/api/chat-routes/' + encodeURIComponent(chatId), { method: 'DELETE' });
      if (!response.ok) return setStatus('Delete failed', true);
      setStatus('Deleted route for ' + chatId, false);
      await load();
    });
    load().catch((error) => setStatus(error.message || 'Load failed', true));
  </script>
</body>
</html>`;
}

function renderPromptPage(port: number) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>System Prompts</title>
  <style>${renderBaseStyles()}</style>
</head>
<body>
  <main>
    <h1>System Prompts</h1>
    <p>View local prompt definitions. Service address: <code>http://127.0.0.1:${port}</code></p>
    ${renderNav("prompts")}
    <section class="panel">
      <div id="promptList"></div>
    </section>
  </main>
  <script>
    async function load() {
      const response = await fetch('/api/prompts');
      const data = await response.json();
      const container = document.getElementById('promptList');
      const promptCards = data.prompts.map((prompt) => {
        const body = prompt.systemPrompt
          ? '<pre>' + escapeHtml(prompt.systemPrompt) + '</pre>'
          : '<p>No local system prompt for this capability.</p>';
        const notes = prompt.notes ? '<p><strong>Notes:</strong> ' + escapeHtml(prompt.notes) + '</p>' : '';
        return '<div class="prompt-card"><h2>' + escapeHtml(prompt.title) + '</h2><p><span class="badge">' + escapeHtml(prompt.scope) + '</span> ' + (prompt.mode ? '<code>' + escapeHtml(prompt.mode) + '</code>' : '') + '</p>' + body + notes + '</div>';
      }).join('');
      const profileCards = (data.promptProfiles || []).map((profile) => {
        const lines = [
          profile.answerStyle ? 'answerStyle: ' + profile.answerStyle : '',
          profile.outputFormat ? 'outputFormat: ' + profile.outputFormat : '',
          profile.tone ? 'tone: ' + profile.tone : '',
          Array.isArray(profile.focus) && profile.focus.length ? 'focus: ' + profile.focus.join(', ') : '',
          profile.maxOutputLength ? 'maxOutputLength: ' + profile.maxOutputLength : ''
        ].filter(Boolean).join('\\n');
        return '<div class="prompt-card"><h2>' + escapeHtml(profile.displayName) + '</h2><p><span class="badge">promptProfile</span> <code>' + escapeHtml(profile.id) + '</code></p><pre>' + escapeHtml(lines || 'No profile details available.') + '</pre>' + (profile.notes ? '<p><strong>Notes:</strong> ' + escapeHtml(profile.notes) + '</p>' : '') + '</div>';
      }).join('');
      container.innerHTML = promptCards + profileCards;
    }
    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
    load().catch((error) => {
      document.getElementById('promptList').innerHTML = '<p>Load failed: ' + escapeHtml(error.message || String(error)) + '</p>';
    });
  </script>
</body>
</html>`;
}

function renderJobsPage(port: number) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Jobs</title>
  <style>${renderBaseStyles()}</style>
</head>
<body>
  <main>
    <h1>Jobs</h1>
    <p>Inspect job outputs, article extraction previews, confidence, and warnings. Service address: <code>http://127.0.0.1:${port}</code></p>
    ${renderNav("jobs")}
    <div class="wide-grid">
      <section class="panel">
        <div class="row">
          <select id="statusFilter">
            <option value="">All statuses</option>
            <option value="queued">queued</option>
            <option value="processing">processing</option>
            <option value="needs_review">needs_review</option>
            <option value="completed">completed</option>
            <option value="failed">failed</option>
          </select>
        </div>
        <div class="job-list" id="jobList"></div>
      </section>
      <section class="panel">
        <h2>Job Detail</h2>
        <div id="jobDetail" class="muted">Select a job to inspect extracted article content and prompt preparation.</div>
      </section>
    </div>
  </main>
  <script>
    let currentJobs = [];
    async function loadJobs() {
      const status = document.getElementById('statusFilter').value;
      const url = status ? '/api/jobs?status=' + encodeURIComponent(status) : '/api/jobs';
      const response = await fetch(url);
      const data = await response.json();
      currentJobs = data.jobs || [];
      renderJobs(currentJobs);
      if (currentJobs[0]) {
        loadJobDetail(currentJobs[0].id);
      } else {
        document.getElementById('jobDetail').innerHTML = '<p class="muted">No jobs available for the current filter.</p>';
      }
    }
    function renderJobs(jobs) {
      const list = document.getElementById('jobList');
      list.innerHTML = jobs.map((job) => {
        return '<button class="job-button" data-id="' + escapeHtml(job.id) + '">' +
          '<div><strong>' + escapeHtml(job.mode || job.type || 'job') + '</strong> <span class="badge">' + escapeHtml(job.status) + '</span></div>' +
          '<div class="muted"><code>' + escapeHtml(job.id) + '</code></div>' +
          '<div>' + escapeHtml(job.inputSummary || '') + '</div>' +
        '</button>';
      }).join('') || '<p class="muted">No jobs yet.</p>';

      document.querySelectorAll('.job-button').forEach((button) => {
        button.addEventListener('click', () => loadJobDetail(button.dataset.id));
      });
    }
    async function loadJobDetail(jobId) {
      const response = await fetch('/api/jobs/' + encodeURIComponent(jobId));
      if (!response.ok) {
        document.getElementById('jobDetail').innerHTML = '<p>Failed to load job detail.</p>';
        return;
      }
      const data = await response.json();
      const job = data.job;
      const prepared = job?.result?.metadata?.preparedRequest;
      const extracted = Array.isArray(prepared?.extractedDocuments) ? prepared.extractedDocuments : [];
      const imageResearch = Array.isArray(prepared?.imageResearchDocuments) ? prepared.imageResearchDocuments : [];
      const references = Array.isArray(prepared?.references) ? prepared.references : [];
      const searchExpansion = prepared?.searchExpansion;
      const attemptedProviders = Array.isArray(job?.result?.metadata?.attemptedProviders) ? job.result.metadata.attemptedProviders : [];
      const richTextBlocks = job?.result?.richTextBlocks;
      const warningHtml = extracted.flatMap((item) => Array.isArray(item.warnings) ? item.warnings : []).map((warning) => '<span class="badge warning-badge">' + escapeHtml(warning) + '</span>').join('');

      document.getElementById('jobDetail').innerHTML = [
        '<div class="kv">',
        '<strong>Job ID</strong><div><code>' + escapeHtml(job.id) + '</code></div>',
        '<strong>Status</strong><div>' + escapeHtml(job.status) + '</div>',
        '<strong>Mode</strong><div>' + escapeHtml(job.mode || '') + '</div>',
        '<strong>Provider</strong><div>' + escapeHtml(job?.result?.metadata?.provider || '') + '</div>',
        '<strong>Provider Chain</strong><div>' + escapeHtml(attemptedProviders.join(' -> ') || '') + '</div>',
        '<strong>Prompt Profile</strong><div>' + escapeHtml(prepared?.promptProfile || '') + '</div>',
        '<strong>Profile Selection</strong><div>' + escapeHtml(prepared?.promptProfileSelection || '') + '</div>',
        '<strong>Profile Reason</strong><div>' + escapeHtml(prepared?.promptProfileReason || '') + '</div>',
        '<strong>Created At</strong><div>' + escapeHtml(job.createdAt || '') + '</div>',
        '<strong>Summary</strong><div>' + escapeHtml(job.inputSummary || '') + '</div>',
        '</div>',
        warningHtml ? '<div><strong>Warnings</strong><div style="margin-top:8px;">' + warningHtml + '</div></div>' : '',
        extracted.map((item, index) => renderExtractedDocument(item, index)).join(''),
        imageResearch.map((item, index) => renderImageResearchDocument(item, index)).join(''),
        renderSearchExpansion(searchExpansion),
        renderReferenceSection(references),
        '<details open><summary>System Prompt</summary><div><pre>' + escapeHtml(prepared?.systemPrompt || 'No system prompt metadata available.') + '</pre></div></details>',
        '<details><summary>Answer Requirements</summary><div><pre>' + escapeHtml(prepared?.answerRequirements || 'No answer requirement metadata available.') + '</pre></div></details>',
        '<details><summary>Workspace Preference</summary><div><pre>' + escapeHtml(prepared?.workspacePreference || 'No workspace preference metadata available.') + '</pre></div></details>',
        '<details><summary>Full User Prompt</summary><div><pre>' + escapeHtml(prepared?.userPrompt || 'No user prompt metadata available.') + '</pre></div></details>',
        '<details><summary>Prepared Prompt Preview</summary><div><pre>' + escapeHtml(prepared?.userPromptPreview || 'No prepared prompt preview available.') + '</pre></div></details>',
        '<details><summary>Rich Text Blocks</summary><div><pre>' + escapeHtml(JSON.stringify(richTextBlocks || {}, null, 2)) + '</pre></div></details>',
        '<details><summary>Result Payload</summary><div><pre>' + escapeHtml(JSON.stringify(job.result || {}, null, 2)) + '</pre></div></details>'
      ].join('');
    }
    function renderExtractedDocument(item, index) {
      return [
        '<details open>',
        '<summary>Extracted Document ' + (index + 1) + '</summary>',
        '<div>',
        '<div class="kv">',
        '<strong>Source URL</strong><div>' + escapeHtml(item.sourceUrl || '') + '</div>',
        '<strong>Title</strong><div>' + escapeHtml(item.title || '') + '</div>',
        '<strong>Excerpt</strong><div>' + escapeHtml(item.excerpt || '') + '</div>',
        '<strong>Method</strong><div>' + escapeHtml(item.extractionMethod || '') + '</div>',
        '<strong>Confidence</strong><div>' + escapeHtml(String(item.confidence ?? '')) + '</div>',
        '<strong>Image Driven</strong><div>' + escapeHtml(item.imageDriven ? 'yes' : 'no') + '</div>',
        '<strong>Image Candidates</strong><div>' + escapeHtml(String(item.imageCandidateCount ?? 0)) + '</div>',
        '<strong>Image URLs</strong><div>' + ((item.imageCandidates || []).map((value) => '<div><code>' + escapeHtml(value) + '</code></div>').join('') || '<span class="muted">none</span>') + '</div>',
        '<strong>Warnings</strong><div>' + ((item.warnings || []).map((warning) => '<span class="badge warning-badge">' + escapeHtml(warning) + '</span>').join('') || '<span class="muted">none</span>') + '</div>',
        '</div>',
        '<pre>' + escapeHtml(item.textPreview || '') + '</pre>',
        '</div>',
        '</details>'
      ].join('');
    }
    function renderImageResearchDocument(item, index) {
      return [
        '<details open>',
        '<summary>Image-derived Research ' + (index + 1) + '</summary>',
        '<div>',
        '<div class="kv">',
        '<strong>Source URL</strong><div>' + escapeHtml(item.sourceUrl || '') + '</div>',
        '<strong>Image Count</strong><div>' + escapeHtml(String(item.imageCount ?? '')) + '</div>',
        '<strong>Vision Provider</strong><div>' + escapeHtml(item.provider || '') + '</div>',
        '</div>',
        '<pre>' + escapeHtml(item.summaryPreview || '') + '</pre>',
        '</div>',
        '</details>'
      ].join('');
    }
    function renderReferenceSection(references) {
      if (!references.length) {
        return '';
      }
      return [
        '<details open>',
        '<summary>Saved References</summary>',
        '<div>',
        references.map((item, index) => {
          return [
            '<div style="padding:10px 0;border-bottom:1px solid #efe6db;">',
            '<div><strong>' + escapeHtml(String(index + 1)) + '.</strong> ' + escapeHtml(item.title || item.sourceUrl || '') + '</div>',
            '<div class="muted">' + escapeHtml(item.sourceType || '') + ' ' + escapeHtml(item.sourceKind || '') + ' ' + escapeHtml(item.sourceTier || '') + '</div>',
            (item.accountName || item.wechatBiz || item.publishTimeRaw)
              ? '<div class="muted">account: ' + escapeHtml(item.accountName || '') + ' biz: ' + escapeHtml(item.wechatBiz || '') + ' publish: ' + escapeHtml(item.publishTimeRaw || item.publishTimestamp || '') + '</div>'
              : '',
            '<div><code>' + escapeHtml(item.sourceUrl || '') + '</code></div>',
            '<div style="margin-top:6px;">' + escapeHtml(item.excerpt || item.summaryPreview || '') + '</div>',
            '</div>'
          ].join('');
        }).join(''),
        '</div>',
        '</details>'
      ].join('');
    }
    function renderSearchExpansion(searchExpansion) {
      if (!searchExpansion || !searchExpansion.enabled) {
        return '';
      }
      const documents = Array.isArray(searchExpansion.documents) ? searchExpansion.documents : [];
      const notes = Array.isArray(searchExpansion.inaccessibleSourceNotes) ? searchExpansion.inaccessibleSourceNotes : [];
      const warnings = Array.isArray(searchExpansion.warnings) ? searchExpansion.warnings : [];
      return [
        '<details open>',
        '<summary>Expanded Search</summary>',
        '<div>',
        '<div class="kv">',
        '<strong>Provider</strong><div>' + escapeHtml(searchExpansion.provider || '') + '</div>',
        '<strong>Planned Queries</strong><div>' + escapeHtml((searchExpansion.plannedQueries || []).join(' | ')) + '</div>',
        '<strong>Plan Reason</strong><div>' + escapeHtml(searchExpansion.planReason || '') + '</div>',
        '<strong>Warnings</strong><div>' + escapeHtml(warnings.join(' | ')) + '</div>',
        '</div>',
        notes.length ? '<div><strong>Closed / Inaccessible Notes</strong><pre>' + escapeHtml(notes.join('\\n')) + '</pre></div>' : '',
        documents.map((item, index) => {
          return [
            '<div style="padding:10px 0;border-bottom:1px solid #efe6db;">',
            '<div><strong>' + escapeHtml(String(index + 1)) + '.</strong> ' + escapeHtml(item.title || item.sourceUrl || '') + '</div>',
            '<div class="muted">query: ' + escapeHtml(item.query || '') + '</div>',
            '<div class="muted">kind: ' + escapeHtml(item.sourceKind || '') + ' | tier: ' + escapeHtml(item.sourceTier || '') + ' | score: ' + escapeHtml(String(item.rankingScore || '')) + '</div>',
            (item.accountName || item.wechatBiz || item.publishTimeRaw)
              ? '<div class="muted">account: ' + escapeHtml(item.accountName || '') + ' biz: ' + escapeHtml(item.wechatBiz || '') + ' publish: ' + escapeHtml(item.publishTimeRaw || item.publishTimestamp || '') + '</div>'
              : '',
            '<div><code>' + escapeHtml(item.sourceUrl || '') + '</code></div>',
            item.snippet ? '<div style="margin-top:6px;">snippet: ' + escapeHtml(item.snippet) + '</div>' : '',
            item.fetchedPreview ? '<pre>' + escapeHtml(item.fetchedPreview) + '</pre>' : '<div class="muted">Fetched content unavailable.</div>',
            '</div>'
          ].join('');
        }).join(''),
        '</div>',
        '</details>'
      ].join('');
    }
    function escapeHtml(value) {
      return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
    document.getElementById('statusFilter').addEventListener('change', loadJobs);
    loadJobs().catch((error) => {
      document.getElementById('jobDetail').innerHTML = '<p>Load failed: ' + escapeHtml(error.message || String(error)) + '</p>';
    });
  </script>
</body>
</html>`;
}
