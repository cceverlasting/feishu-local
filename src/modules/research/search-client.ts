import type { Env } from "../../config/env.js";
import { ExternalServiceError } from "../../utils/errors.js";
import { fetchJson, fetchText } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";
import { ArticleFetcher, type ArticleDocument } from "./article-fetcher.js";

type SearchPlanningProvider = "openai-compatible" | "ollama" | "none";
type SearchSourceKind = "web" | "wechat";
type SearchSourceTier = "official" | "news" | "wechat" | "general";

export interface SearchExpansionRequest {
  jobId: string;
  mode: string;
  prompt: string;
  promptProfile?: string;
  providerHint?: string;
  urls?: string[];
  directDocuments: ArticleDocument[];
  imageResearchSummaries: string[];
}

export interface SearchDocument {
  query: string;
  sourceKind: SearchSourceKind;
  sourceTier: SearchSourceTier;
  title?: string;
  sourceUrl: string;
  snippet?: string;
  source?: string;
  fetchedDocument?: ArticleDocument;
  accountName?: string;
  wechatBiz?: string;
  publishTimeRaw?: string;
  publishTimestamp?: string;
  rankingScore: number;
}

export interface SearchExpansionResult {
  enabled: boolean;
  provider: string;
  plannedQueries: string[];
  planReason?: string;
  documents: SearchDocument[];
  inaccessibleSourceNotes: string[];
  warnings: string[];
}

interface QueryPlanResponse {
  queries?: string[];
  rationale?: string;
  inaccessible_source_notes?: string[];
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
}

interface SearchApiResponse {
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    source?: string;
  }>;
  items?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    source?: string;
  }>;
  data?: Array<{
    title?: string;
    url?: string;
    content?: string;
    source?: string;
  }>;
}

interface WeixinSearchResult {
  title?: string;
  link?: string;
  real_url?: string;
  publish_time?: string;
  page?: string;
}

interface WeixinSearchApiResponse {
  results?: WeixinSearchResult[];
  data?: WeixinSearchResult[];
}

interface ParsedWeixinMetadata {
  accountName?: string;
  wechatBiz?: string;
  publishTimestamp?: string;
}

export class ResearchSearchClient {
  private readonly articleFetcher: ArticleFetcher;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {
    this.articleFetcher = new ArticleFetcher(env, logger);
  }

  isEnabled() {
    return this.env.RESEARCH_SEARCH_ENABLED && (Boolean(this.env.SEARCH_API_URL) || this.isWeixinEnabled());
  }

  async expand(request: SearchExpansionRequest): Promise<SearchExpansionResult> {
    if (!this.isEnabled() || request.mode !== "article_research") {
      return {
        enabled: false,
        provider: "none",
        plannedQueries: [],
        documents: [],
        inaccessibleSourceNotes: inferClosedSourceNotes(request),
        warnings: this.isEnabled() ? [] : ["search_not_configured"]
      };
    }

    const queryPlan = await this.generateQueryPlan(request);
    if (queryPlan.queries.length === 0) {
      return {
        enabled: true,
        provider: buildProviderLabel(this.env),
        plannedQueries: [],
        ...(queryPlan.rationale ? { planReason: queryPlan.rationale } : {}),
        documents: [],
        inaccessibleSourceNotes: dedupeStrings([
          ...queryPlan.inaccessibleSourceNotes,
          ...inferClosedSourceNotes(request)
        ]),
        warnings: ["search_query_plan_empty"]
      };
    }

    const gathered = await this.searchAndFetch(queryPlan.queries);

    return {
      enabled: true,
      provider: buildProviderLabel(this.env),
      plannedQueries: queryPlan.queries,
      ...(queryPlan.rationale ? { planReason: queryPlan.rationale } : {}),
      documents: gathered.documents,
      inaccessibleSourceNotes: dedupeStrings([
        ...queryPlan.inaccessibleSourceNotes,
        ...inferClosedSourceNotes(request)
      ]),
      warnings: gathered.warnings
    };
  }

  private isWeixinEnabled() {
    return this.env.WEIXIN_SEARCH_ENABLED && Boolean(this.env.WEIXIN_SEARCH_API_URL);
  }

  private async generateQueryPlan(request: SearchExpansionRequest) {
    const provider = this.resolvePlanningProvider(request.providerHint);
    const prompt = buildQueryPlanningPrompt(request, this.env.RESEARCH_SEARCH_MAX_QUERIES);

    try {
      const raw =
        provider === "ollama"
          ? await this.planWithOllama(prompt)
          : await this.planWithOpenAi(prompt);

      const parsed = parseQueryPlan(raw, this.env.RESEARCH_SEARCH_MAX_QUERIES);
      return {
        queries: parsed.queries,
        rationale: parsed.rationale,
        inaccessibleSourceNotes: dedupeStrings([
          ...parsed.inaccessibleSourceNotes,
          ...inferClosedSourceNotes(request)
        ])
      };
    } catch (error) {
      this.logger.warn("research_search.query_plan.failed", {
        jobId: request.jobId,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        queries: buildFallbackQueries(request, this.env.RESEARCH_SEARCH_MAX_QUERIES),
        rationale: "fallback_query_heuristics",
        inaccessibleSourceNotes: inferClosedSourceNotes(request)
      };
    }
  }

  private async planWithOpenAi(prompt: string) {
    if (!this.env.AI_BASE_URL || !this.env.AI_API_KEY || !this.env.AI_MODEL) {
      throw new ExternalServiceError(
        "SEARCH_PLAN_PROVIDER_MISSING",
        "Missing OpenAI-compatible config."
      );
    }

    const url = new URL("/v1/chat/completions", this.env.AI_BASE_URL).toString();
    const response = await fetchJson<ChatCompletionResponse>(url, {
      method: "POST",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.env.AI_API_KEY}`
      },
      body: JSON.stringify({
        model: this.env.AI_MODEL,
        messages: [
          {
            role: "system",
            content:
              "You are a research search planner. Output strict JSON with keys queries, rationale, inaccessible_source_notes."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.2
      })
    });

    return extractOpenAiContent(response);
  }

  private async planWithOllama(prompt: string) {
    if (!this.env.OLLAMA_BASE_URL || !this.env.OLLAMA_MODEL) {
      throw new ExternalServiceError("SEARCH_PLAN_PROVIDER_MISSING", "Missing Ollama config.");
    }

    const url = new URL("/api/chat", this.env.OLLAMA_BASE_URL).toString();
    const response = await fetchJson<OllamaChatResponse>(url, {
      method: "POST",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 0,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.env.OLLAMA_MODEL,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "You are a research search planner. Output strict JSON with keys queries, rationale, inaccessible_source_notes."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        options: {
          temperature: 0.2
        }
      })
    });

    return response.message?.content?.trim() ?? "";
  }

  private resolvePlanningProvider(providerHint?: string): SearchPlanningProvider {
    const normalized = providerHint?.trim().toLowerCase();
    if (normalized === "ollama" || normalized === "local") {
      return "ollama";
    }
    if (
      normalized === "openai-compatible" ||
      normalized === "openai" ||
      normalized === "cloud" ||
      normalized === "remote"
    ) {
      return "openai-compatible";
    }
    if (this.env.RESEARCH_PRIMARY_PROVIDER === "ollama") {
      return "ollama";
    }
    return "openai-compatible";
  }

  private async searchAndFetch(queries: string[]) {
    const warnings: string[] = [];
    const rawResults: SearchDocument[] = [];

    for (const query of queries.slice(0, this.env.RESEARCH_SEARCH_MAX_QUERIES)) {
      const providerCalls: Array<Promise<SearchDocument[]>> = [];

      if (this.env.SEARCH_API_URL) {
        providerCalls.push(
          this.searchWebOnce(query).catch((error: unknown) => {
            warnings.push(`web_search_failed:${query}`);
            this.logger.warn("research_search.web.failed", {
              query,
              error: error instanceof Error ? error.message : String(error)
            });
            return [];
          })
        );
      }

      if (this.isWeixinEnabled()) {
        providerCalls.push(
          this.searchWeixinOnce(query).catch((error: unknown) => {
            warnings.push(`weixin_search_failed:${query}`);
            this.logger.warn("research_search.weixin.failed", {
              query,
              error: error instanceof Error ? error.message : String(error)
            });
            return [];
          })
        );
      }

      const results = await Promise.all(providerCalls);
      for (const batch of results) {
        rawResults.push(...batch);
      }
    }

    const ranked = rankAndSortDocuments(rawResults).slice(0, this.env.RESEARCH_SEARCH_MAX_RESULTS);
    const fetchedDocuments = await this.articleFetcher.fetchDocuments(
      ranked.map((item) => item.sourceUrl)
    );
    const fetchedByUrl = new Map(fetchedDocuments.map((item) => [item.sourceUrl, item] as const));

    const hydrated = await Promise.all(
      ranked.map(async (item) => {
        const fetchedDocument = fetchedByUrl.get(item.sourceUrl);
        if (item.sourceKind !== "wechat") {
          return {
            ...item,
            ...(fetchedDocument ? { fetchedDocument } : {})
          };
        }

        const metadata = await this.fetchWeixinMetadata(
          item.sourceUrl,
          fetchedDocument?.title ?? item.title
        ).catch((error: unknown) => {
          warnings.push(`weixin_metadata_failed:${item.sourceUrl}`);
          this.logger.warn("research_search.weixin_metadata.failed", {
            sourceUrl: item.sourceUrl,
            error: error instanceof Error ? error.message : String(error)
          });
          return undefined;
        });

        return {
          ...item,
          ...(fetchedDocument ? { fetchedDocument } : {}),
          ...(metadata?.accountName ? { accountName: metadata.accountName } : {}),
          ...(metadata?.wechatBiz ? { wechatBiz: metadata.wechatBiz } : {}),
          ...(metadata?.publishTimestamp ? { publishTimestamp: metadata.publishTimestamp } : {})
        };
      })
    );

    return {
      documents: rankAndSortDocuments(hydrated),
      warnings: dedupeStrings(warnings)
    };
  }

  private async searchWebOnce(query: string) {
    if (!this.env.SEARCH_API_URL) {
      throw new ExternalServiceError("SEARCH_API_MISSING", "SEARCH_API_URL is not configured.");
    }

    const headers = buildAuthHeaders(this.env.SEARCH_API_AUTH_HEADER, this.env.SEARCH_API_KEY);
    const response = await fetchJson<SearchApiResponse>(this.env.SEARCH_API_URL, {
      method: "POST",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: JSON.stringify({
        query,
        maxResults: this.env.RESEARCH_SEARCH_RESULTS_PER_QUERY,
        languageHints: ["zh-CN", "en"],
        blockedDomains: ["xiaohongshu.com", "weixin.sogou.com"],
        preferOfficialSources: true
      })
    });

    return parseSearchApiResponse(response, query);
  }

  private async searchWeixinOnce(query: string) {
    if (!this.env.WEIXIN_SEARCH_API_URL) {
      throw new ExternalServiceError(
        "WEIXIN_SEARCH_API_MISSING",
        "WEIXIN_SEARCH_API_URL is not configured."
      );
    }

    const headers = buildAuthHeaders(
      this.env.WEIXIN_SEARCH_API_AUTH_HEADER,
      this.env.WEIXIN_SEARCH_API_KEY
    );
    const response = await fetchJson<WeixinSearchApiResponse>(this.env.WEIXIN_SEARCH_API_URL, {
      method: "POST",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        "content-type": "application/json",
        ...headers
      },
      body: JSON.stringify({
        query,
        max_pages: this.env.WEIXIN_SEARCH_MAX_PAGES,
        page: 1
      })
    });

    return parseWeixinSearchApiResponse(response, query);
  }

  private async fetchWeixinMetadata(sourceUrl: string, fallbackTitle?: string) {
    const html = await fetchText(sourceUrl, {
      method: "GET",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 0,
      headers: {
        "user-agent": "Mozilla/5.0 FeishuLocalAI/0.1"
      }
    });

    const accountName = extractWechatVar(html, "nickname");
    const publishTimestamp = extractWechatPublishTimestamp(html);
    const wechatBiz = extractWechatBiz(sourceUrl, html);
    const title = extractWechatVar(html, "msg_title") ?? fallbackTitle;

    return {
      ...(accountName ? { accountName } : {}),
      ...(wechatBiz ? { wechatBiz } : {}),
      ...(publishTimestamp ? { publishTimestamp } : {}),
      ...(title ? { title } : {})
    } as ParsedWeixinMetadata & { title?: string };
  }
}

function buildQueryPlanningPrompt(request: SearchExpansionRequest, maxQueries: number) {
  const directContext = request.directDocuments
    .slice(0, 2)
    .map((document, index) =>
      [
        `Document ${index + 1}: ${document.title ?? document.sourceUrl}`,
        document.excerpt ?? document.text.slice(0, 400)
      ].join("\n")
    )
    .join("\n\n");

  const imageContext = request.imageResearchSummaries.slice(0, 2).join("\n\n");

  return [
    "Please generate search queries for secondary research.",
    `Return JSON only. At most ${maxQueries} concise queries.`,
    "Prefer authoritative and open-web sources such as company IR pages, filings, official docs, standards bodies, papers, major media, and public technical blogs.",
    "For Chinese topics, include query variants that are likely to surface high-signal public WeChat articles, but do not assume closed ecosystems are fully searchable.",
    "If the topic is Chinese and some high-value sources may be inside closed ecosystems, mention that in inaccessible_source_notes.",
    `Mode: ${request.mode}`,
    `Prompt profile: ${request.promptProfile ?? "auto"}`,
    `User request:\n${request.prompt}`,
    request.urls?.length ? `Referenced URLs:\n${request.urls.join("\n")}` : "",
    directContext ? `Fetched direct context:\n${directContext}` : "",
    imageContext ? `Image-derived context:\n${imageContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function parseQueryPlan(raw: string, maxQueries: number) {
  const jsonBlock = extractJsonObject(raw);
  const parsed = jsonBlock ? (JSON.parse(jsonBlock) as QueryPlanResponse) : {};
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter(Boolean)
        .slice(0, maxQueries)
    : [];

  return {
    queries,
    ...(typeof parsed.rationale === "string" && parsed.rationale.trim().length > 0
      ? { rationale: parsed.rationale.trim() }
      : {}),
    inaccessibleSourceNotes: Array.isArray(parsed.inaccessible_source_notes)
      ? parsed.inaccessible_source_notes
          .map((item) => (typeof item === "string" ? item.trim() : ""))
          .filter(Boolean)
      : []
  };
}

function extractJsonObject(raw: string) {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const match = trimmed.match(/\{[\s\S]*\}/);
  return match?.[0];
}

function buildFallbackQueries(request: SearchExpansionRequest, maxQueries: number) {
  const cleanedPrompt = request.prompt.replace(/^\/\S+\s*/, "").trim();
  const seed = cleanedPrompt || request.directDocuments[0]?.title || "research topic";
  const profileQueries =
    request.promptProfile === "equity-research"
      ? [
          `${seed} company outlook`,
          `${seed} earnings guidance`,
          `${seed} investor relations`
        ]
      : [
          `${seed} industry chain`,
          `${seed} technology roadmap`,
          `${seed} official report`
        ];

  return profileQueries.slice(0, maxQueries);
}

function parseSearchApiResponse(response: SearchApiResponse, query: string) {
  const normalized: SearchDocument[] = [];
  const pushIfValid = (item: SearchDocument | undefined) => {
    if (!item || !/^https?:\/\//i.test(item.sourceUrl)) {
      return;
    }
    normalized.push(item);
  };

  for (const item of response.results ?? []) {
    pushIfValid(buildWebSearchDocument(query, item.url, item.title, item.snippet, item.source));
  }
  for (const item of response.items ?? []) {
    pushIfValid(buildWebSearchDocument(query, item.link, item.title, item.snippet, item.source));
  }
  for (const item of response.data ?? []) {
    pushIfValid(buildWebSearchDocument(query, item.url, item.title, item.content, item.source));
  }

  return normalized;
}

function buildWebSearchDocument(
  query: string,
  sourceUrl: string | undefined,
  title?: string,
  snippet?: string,
  source?: string
) {
  if (!sourceUrl) {
    return undefined;
  }

  const sourceTier = inferSourceTier(sourceUrl, source);
  return {
    query,
    sourceKind: "web" as const,
    sourceTier,
    sourceUrl,
    ...(title ? { title } : {}),
    ...(snippet ? { snippet } : {}),
    ...(source ? { source } : {}),
    rankingScore: baseRankingScore("web", sourceTier)
  };
}

function parseWeixinSearchApiResponse(response: WeixinSearchApiResponse, query: string) {
  const results = [...(response.results ?? []), ...(response.data ?? [])];
  const normalized: SearchDocument[] = [];

  for (const item of results) {
    const sourceUrl = item.real_url?.trim() || item.link?.trim();
    if (!sourceUrl || !/^https?:\/\//i.test(sourceUrl)) {
      continue;
    }

    const publishTimeRaw = item.publish_time?.trim();
    const wechatBiz = extractWechatBiz(sourceUrl);
    normalized.push({
      query,
      sourceKind: "wechat",
      sourceTier: "wechat",
      sourceUrl,
      ...(item.title?.trim() ? { title: item.title.trim() } : {}),
      ...(publishTimeRaw ? { publishTimeRaw } : {}),
      ...(wechatBiz ? { wechatBiz } : {}),
      rankingScore: baseRankingScore("wechat", "wechat")
    });
  }

  return normalized;
}

function inferSourceTier(sourceUrl: string, source?: string): SearchSourceTier {
  const host = safeHostname(sourceUrl);
  const combined = `${host} ${source ?? ""}`.toLowerCase();

  if (
    /\.gov(\.|$)|\.edu(\.|$)|sec\.gov$|arxiv\.org$|nature\.com$|science\.org$|who\.int$|nih\.gov$/.test(
      host
    ) ||
    /official|investor relations|ir|sec filing/.test(combined)
  ) {
    return "official";
  }

  if (/reuters|bloomberg|ft\.com|wsj\.com|nytimes|caixin|36kr|the information|techcrunch/.test(combined)) {
    return "news";
  }

  return "general";
}

function baseRankingScore(sourceKind: SearchSourceKind, sourceTier: SearchSourceTier) {
  let score = 0;
  if (sourceKind === "web") score += 30;
  if (sourceKind === "wechat") score += 18;
  if (sourceTier === "official") score += 50;
  if (sourceTier === "news") score += 28;
  if (sourceTier === "wechat") score += 16;
  if (sourceTier === "general") score += 10;
  return score;
}

function rankAndSortDocuments(items: SearchDocument[]) {
  const deduped = dedupeSearchDocuments(items);
  return deduped.sort((left, right) => {
    const timeCompare = comparePublishTime(right, left);
    if (timeCompare !== 0) {
      return timeCompare;
    }
    return right.rankingScore - left.rankingScore;
  });
}

function comparePublishTime(left: SearchDocument, right: SearchDocument) {
  const leftValue = normalizePublishSortValue(left);
  const rightValue = normalizePublishSortValue(right);
  if (leftValue === rightValue) {
    return 0;
  }
  return leftValue > rightValue ? 1 : -1;
}

function normalizePublishSortValue(document: SearchDocument) {
  if (document.publishTimestamp) {
    const parsed = Date.parse(document.publishTimestamp);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  if (document.publishTimeRaw) {
    const parsedRaw = parseChinesePublishTime(document.publishTimeRaw);
    if (typeof parsedRaw === "number") {
      return parsedRaw;
    }
  }

  return 0;
}

function parseChinesePublishTime(value: string) {
  const normalized = value.trim();
  const absolute = Date.parse(normalized);
  if (!Number.isNaN(absolute)) {
    return absolute;
  }

  const now = Date.now();
  const minuteMatch = normalized.match(/(\d+)\s*分钟前/);
  if (minuteMatch?.[1]) {
    return now - Number(minuteMatch[1]) * 60_000;
  }
  const hourMatch = normalized.match(/(\d+)\s*小时前/);
  if (hourMatch?.[1]) {
    return now - Number(hourMatch[1]) * 3_600_000;
  }
  const dayMatch = normalized.match(/(\d+)\s*天前/);
  if (dayMatch?.[1]) {
    return now - Number(dayMatch[1]) * 86_400_000;
  }
  const monthDayMatch = normalized.match(/(\d{1,2})[-/月](\d{1,2})日?/);
  if (monthDayMatch?.[1] && monthDayMatch[2]) {
    const year = new Date().getFullYear();
    const candidate = Date.parse(
      `${year}-${monthDayMatch[1].padStart(2, "0")}-${monthDayMatch[2].padStart(2, "0")}`
    );
    if (!Number.isNaN(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function dedupeSearchDocuments(items: SearchDocument[]) {
  const seen = new Map<string, SearchDocument>();

  for (const item of items) {
    const key = item.wechatBiz
      ? `wechat:${item.wechatBiz}:${item.title ?? item.sourceUrl}`
      : item.sourceUrl;
    const existing = seen.get(key);
    if (!existing || item.rankingScore > existing.rankingScore) {
      seen.set(key, item);
    }
  }

  return Array.from(seen.values());
}

function inferClosedSourceNotes(request: SearchExpansionRequest) {
  const combined = [request.prompt, ...(request.urls ?? [])].join("\n").toLowerCase();
  const notes: string[] = [];

  if (/公众号|微信|mp\.weixin|小红书|xiaohongshu|知识星球|星球|朋友圈/.test(combined)) {
    notes.push(
      "中文高价值内容常分布在微信公众号、小红书、知识星球等封闭或半封闭环境，无法依赖开放搜索稳定覆盖。"
    );
    notes.push("对这类来源，优先让用户直接转发 URL、截图、长图或文本摘录，再走 OCR/研究链。");
  }

  return notes;
}

function dedupeStrings(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)));
}

function extractOpenAiContent(response: ChatCompletionResponse) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function buildAuthHeaders(headerName: string, apiKey?: string) {
  if (!apiKey) {
    return {};
  }

  return {
    [headerName]:
      headerName.toLowerCase() === "authorization" && !/^bearer\s/i.test(apiKey)
        ? `Bearer ${apiKey}`
        : apiKey
  };
}

function buildProviderLabel(env: Env) {
  const providers: string[] = [];
  if (env.SEARCH_API_URL) providers.push("web_search");
  if (env.WEIXIN_SEARCH_ENABLED && env.WEIXIN_SEARCH_API_URL) providers.push("weixin_search");
  return providers.join("+") || "none";
}

function safeHostname(sourceUrl: string) {
  try {
    return new URL(sourceUrl).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function extractWechatBiz(sourceUrl: string, html?: string) {
  try {
    const url = new URL(sourceUrl);
    const fromUrl = url.searchParams.get("__biz");
    if (fromUrl) {
      return fromUrl;
    }
  } catch {
    // ignore
  }

  if (!html) {
    return undefined;
  }

  const match = html.match(/var\s+biz\s*=\s*"([^"]+)"/i) ?? html.match(/"biz":"([^"]+)"/i);
  return match?.[1]?.trim() || undefined;
}

function extractWechatVar(html: string, variableName: string) {
  const patterns = [
    new RegExp(`var\\s+${variableName}\\s*=\\s*"([^"]*)"`, "i"),
    new RegExp(`var\\s+${variableName}\\s*=\\s*'([^']*)'`, "i"),
    new RegExp(`"${variableName}"\\s*:\\s*"([^"]*)"`, "i")
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return decodeWechatString(match[1]);
    }
  }

  return undefined;
}

function extractWechatPublishTimestamp(html: string) {
  const matches = [
    html.match(/var\s+ct\s*=\s*"?(\\d{10})"?/i),
    html.match(/"publish_time"\s*:\s*"?(\\d{10})"?/i),
    html.match(/publish_time\s*=\s*"?(\\d{10})"?/i)
  ];

  for (const match of matches) {
    const raw = match?.[1];
    if (!raw) {
      continue;
    }
    const millis = Number(raw) * 1000;
    if (!Number.isNaN(millis)) {
      return new Date(millis).toISOString();
    }
  }

  return undefined;
}

function decodeWechatString(value: string) {
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    )
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
