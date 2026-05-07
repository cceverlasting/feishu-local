import type { Env } from "../../config/env.js";
import type { ModuleResult, TaskMode } from "../../models/types.js";
import {
  ExternalServiceError,
  RetryableError,
  TimeoutError
} from "../../utils/errors.js";
import { fetchJson } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";
import {
  buildWorkspacePreference,
  getSystemPromptForMode
} from "../prompts/prompt-registry.js";
import { ArticleFetcher, type ArticleDocument } from "./article-fetcher.js";
import {
  ResearchSearchClient,
  type SearchDocument,
  type SearchExpansionResult
} from "./search-client.js";
import { OcrClient } from "../vision/ocr-client.js";

type ResearchProvider = "openai-compatible" | "ollama" | "none";

interface ResearchRequest {
  jobId: string;
  mode: TaskMode;
  prompt: string;
  urls?: string[];
  providerHint?: string;
  promptProfile?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OllamaChatResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

interface PreparedResearchRequest {
  systemPrompt: string;
  userPrompt: string;
  userPromptPreview: string;
  sourceDocumentCount: number;
  extractedDocuments: Array<{
    sourceUrl: string;
    title?: string;
    excerpt?: string;
    textPreview: string;
    extractionMethod: string;
    confidence: number;
    warnings: string[];
    imageCandidateCount: number;
    imageDriven: boolean;
    imageCandidates: string[];
  }>;
  imageResearchDocuments: Array<{
    sourceUrl: string;
    imageCount: number;
    provider?: string;
    summaryPreview: string;
  }>;
  answerRequirements: string;
  workspacePreference?: string;
  promptProfile?: string;
  promptProfileSelection?: "configured" | "inferred";
  promptProfileReason?: string;
  references: Array<{
    sourceType: "article" | "image" | "search";
    sourceUrl: string;
    title?: string;
    excerpt?: string;
    summaryPreview: string;
    query?: string;
    sourceKind?: "web" | "wechat";
    sourceTier?: "official" | "news" | "wechat" | "general";
    accountName?: string;
    wechatBiz?: string;
    publishTimeRaw?: string;
    publishTimestamp?: string;
  }>;
  searchExpansion?: {
    enabled: boolean;
    provider: string;
    plannedQueries: string[];
    expansionPoints: Array<{
      point: string;
      reason?: string;
      priority: number;
      queries: string[];
    }>;
    planReason?: string;
    inaccessibleSourceNotes: string[];
    warnings: string[];
    documents: Array<{
      query: string;
      expansionPoint?: string;
      sourceUrl: string;
      title?: string;
      snippet?: string;
      source?: string;
      sourceKind: "web" | "wechat";
      sourceTier: "official" | "news" | "wechat" | "general";
      accountName?: string;
      wechatBiz?: string;
      publishTimeRaw?: string;
      publishTimestamp?: string;
      rankingScore: number;
      fetchedTitle?: string;
      fetchedExcerpt?: string;
      fetchedPreview?: string;
    }>;
  };
}

interface ProviderExecutionResult {
  summary: string;
  usage?: {
    totalTokens?: number;
  };
}

interface FeishuPostTagText {
  tag: "text";
  text: string;
}

interface FeishuPostTagLink {
  tag: "a";
  text: string;
  href: string;
}

type FeishuPostElement = FeishuPostTagText | FeishuPostTagLink;

interface FeishuPostBlocks {
  zh_cn: {
    title: string;
    content: FeishuPostElement[][];
  };
}

export class ResearchClient {
  private readonly articleFetcher: ArticleFetcher;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly ocrClient: OcrClient,
    private readonly searchClient: ResearchSearchClient
  ) {
    this.articleFetcher = new ArticleFetcher(env, logger);
  }

  isConfigured(provider?: ResearchProvider): boolean {
    if (provider) {
      return this.getMissingConfigKeys(provider).length === 0;
    }
    return this.resolveConfiguredProviders().length > 0;
  }

  logConfiguration() {
    const configuredProviders = this.resolveConfiguredProviders();
    this.logger.info("research_ai.config", {
      primaryProvider: this.env.RESEARCH_PRIMARY_PROVIDER,
      fallbackProvider: this.env.RESEARCH_FALLBACK_PROVIDER ?? null,
      configuredProviders,
      openAiBaseUrl: this.env.AI_BASE_URL,
      openAiModel: this.env.AI_MODEL,
      ollamaBaseUrl: this.env.OLLAMA_BASE_URL,
      ollamaModel: this.env.OLLAMA_MODEL
    });
  }

  async run(request: ResearchRequest): Promise<ModuleResult> {
    const documents = request.urls?.length
      ? await this.articleFetcher.fetchDocuments(request.urls, request.jobId)
      : [];
    if (request.mode === "article_research" && request.urls?.length && documents.length === 0) {
      return {
        ok: true,
        summary:
          "文章链接已收到，但当前无法稳定抓取正文。请补充以下任一材料后再研究：1) 复制文章正文（建议>=300字）；2) 发送长截图；3) 发送可直接访问的网页链接。",
        metadata: {
          jobId: request.jobId,
          mode: request.mode,
          blockedReason: "article_fetch_unavailable",
          urlCount: request.urls.length
        }
      };
    }
    const imageResearchDocuments = await this.collectImageResearchDocuments(request, documents);
    const profileResolution = resolvePromptProfile(request, documents);
    const searchExpansion = await this.searchClient.expand({
      jobId: request.jobId,
      mode: request.mode,
      prompt: request.prompt,
      ...(profileResolution.promptProfile ? { promptProfile: profileResolution.promptProfile } : {}),
      ...(request.providerHint ? { providerHint: request.providerHint } : {}),
      ...(request.urls ? { urls: request.urls } : {}),
      directDocuments: documents,
      imageResearchSummaries: imageResearchDocuments.map((item) => item.summaryPreview)
    });
    const prepared = prepareResearchRequest(
      request,
      documents,
      imageResearchDocuments,
      searchExpansion,
      profileResolution,
      this.env.AI_SOURCE_TEXT_MAX_CHARS,
      this.env.AI_USER_PROMPT_MAX_CHARS
    );
    const providerChain = this.resolveProviderChain(request.providerHint);

    if (providerChain.length === 0) {
      return this.buildFallbackResult(
        request,
        prepared,
        "no_provider_configured",
        []
      );
    }

    const attemptedProviders: ResearchProvider[] = [];
    let lastError: unknown;

    for (const provider of providerChain) {
      attemptedProviders.push(provider);

      if (!this.isConfigured(provider)) {
        lastError = new ExternalServiceError(
          "PROVIDER_NOT_CONFIGURED",
          `Research provider ${provider} is not configured.`
        );
        this.logger.warn("research_ai.provider.skip_unconfigured", {
          jobId: request.jobId,
          provider,
          missingKeys: this.getMissingConfigKeys(provider)
        });
        continue;
      }

      this.logger.info("research_ai.request.start", {
        jobId: request.jobId,
        mode: request.mode,
        provider,
        providerHint: request.providerHint ?? null,
        urlCount: request.urls?.length ?? 0,
        fetchedDocumentCount: prepared.sourceDocumentCount,
        userPromptLength: prepared.userPrompt.length
      });

      try {
        const response = await this.executeProvider(provider, prepared, request);
        this.logger.info("research_ai.request.complete", {
          jobId: request.jobId,
          mode: request.mode,
          provider,
          fetchedDocumentCount: prepared.sourceDocumentCount,
          totalTokens: response.usage?.totalTokens
        });

        return {
          ok: true,
          summary: response.summary.trim(),
          richTextBlocks: buildResearchPostBlocks(request, prepared, response.summary.trim()),
          metadata: {
            jobId: request.jobId,
            mode: request.mode,
            provider,
            providerHint: request.providerHint ?? null,
            attemptedProviders,
            usedFallback: attemptedProviders.length > 1,
            fetchedDocumentCount: prepared.sourceDocumentCount,
            totalTokens: response.usage?.totalTokens,
            preparedRequest: buildPreparedRequestMetadata(prepared)
          }
        };
      } catch (error) {
        lastError = normalizeAiError(error, request, provider);
        this.logger.warn("research_ai.request.failed", {
          jobId: request.jobId,
          mode: request.mode,
          provider,
          error: lastError instanceof Error ? lastError.message : String(lastError)
        });
      }
    }

    if (!lastError) {
      return this.buildFallbackResult(
        request,
        prepared,
        "provider_chain_exhausted",
        attemptedProviders
      );
    }

    throw lastError;
  }

  private async executeProvider(
    provider: ResearchProvider,
    prepared: PreparedResearchRequest,
    request: ResearchRequest
  ): Promise<ProviderExecutionResult> {
    switch (provider) {
      case "openai-compatible":
        return this.executeOpenAiCompatible(prepared, {
          jobId: request.jobId,
          mode: request.mode,
          provider
        });
      case "ollama":
        return this.executeOllama(prepared, {
          jobId: request.jobId,
          mode: request.mode,
          provider
        });
      case "none":
        return this.buildFallbackResultAsExecution(request, prepared, provider);
      default:
        throw new ExternalServiceError(
          "UNSUPPORTED_PROVIDER",
          `Unsupported research provider: ${String(provider)}`
        );
    }
  }

  private async executeOpenAiCompatible(
    prepared: PreparedResearchRequest,
    trace: { jobId: string; mode: TaskMode; provider: ResearchProvider }
  ): Promise<ProviderExecutionResult> {
    const url = new URL("/v1/chat/completions", this.env.AI_BASE_URL).toString();
    const startedAt = Date.now();
    this.logger.info("research_ai.openai.http_request_sent", {
      jobId: trace.jobId,
      mode: trace.mode,
      provider: trace.provider,
      endpoint: url,
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      model: this.env.AI_MODEL,
      promptLength: prepared.userPrompt.length
    });
    const heartbeat = setInterval(() => {
      this.logger.info("research_ai.openai.in_flight", {
        jobId: trace.jobId,
        mode: trace.mode,
        provider: trace.provider,
        elapsedMs: Date.now() - startedAt
      });
    }, 5000);
    let response: ChatCompletionResponse;
    try {
      response = await fetchJson<ChatCompletionResponse>(url, {
        method: "POST",
        timeoutMs: this.env.HTTP_TIMEOUT_MS,
        retryCount: 1,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.env.AI_API_KEY ?? ""}`
        },
        body: JSON.stringify({
          model: this.env.AI_MODEL,
          messages: [
            {
              role: "system",
              content: prepared.systemPrompt
            },
            {
              role: "user",
              content: prepared.userPrompt
            }
          ],
          temperature: 0.3
        })
      });
    } finally {
      clearInterval(heartbeat);
    }
    this.logger.info("research_ai.openai.http_response_received", {
      jobId: trace.jobId,
      mode: trace.mode,
      provider: trace.provider,
      endpoint: url,
      elapsedMs: Date.now() - startedAt,
      totalTokens: response.usage?.total_tokens
    });

    const content = extractOpenAiContent(response);
    if (!content) {
      throw new ExternalServiceError("AI_EMPTY_RESPONSE", "AI response content was empty.");
    }

    return {
      summary: content,
      ...(typeof response.usage?.total_tokens === "number"
        ? { usage: { totalTokens: response.usage.total_tokens } }
        : {})
    };
  }

  private async executeOllama(
    prepared: PreparedResearchRequest,
    trace: { jobId: string; mode: TaskMode; provider: ResearchProvider }
  ): Promise<ProviderExecutionResult> {
    const url = new URL("/api/chat", this.env.OLLAMA_BASE_URL).toString();
    const startedAt = Date.now();
    this.logger.info("research_ai.ollama.http_request_sent", {
      jobId: trace.jobId,
      mode: trace.mode,
      provider: trace.provider,
      endpoint: url,
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      model: this.env.OLLAMA_MODEL,
      promptLength: prepared.userPrompt.length
    });
    const heartbeat = setInterval(() => {
      this.logger.info("research_ai.ollama.in_flight", {
        jobId: trace.jobId,
        mode: trace.mode,
        provider: trace.provider,
        elapsedMs: Date.now() - startedAt
      });
    }, 5000);
    let response: OllamaChatResponse;
    try {
      response = await fetchJson<OllamaChatResponse>(url, {
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
              content: prepared.systemPrompt
            },
            {
              role: "user",
              content: prepared.userPrompt
            }
          ],
          options: {
            temperature: 0.3
          }
        })
      });
    } finally {
      clearInterval(heartbeat);
    }
    this.logger.info("research_ai.ollama.http_response_received", {
      jobId: trace.jobId,
      mode: trace.mode,
      provider: trace.provider,
      endpoint: url,
      elapsedMs: Date.now() - startedAt
    });

    const content = response.message?.content?.trim();
    if (!content) {
      throw new ExternalServiceError("OLLAMA_EMPTY_RESPONSE", "Ollama response content was empty.");
    }

    return {
      summary: content,
      usage: {
        totalTokens: safeNumber(response.prompt_eval_count) + safeNumber(response.eval_count)
      }
    };
  }

  private buildFallbackResult(
    request: ResearchRequest,
    prepared: PreparedResearchRequest,
    reason: string,
    attemptedProviders: ResearchProvider[]
  ): ModuleResult {
    return {
      ok: true,
      summary: buildLocalPreparationNotice(request, prepared),
      richTextBlocks: buildResearchPostBlocks(
        request,
        prepared,
        buildLocalPreparationNotice(request, prepared)
      ),
      metadata: {
        jobId: request.jobId,
        mode: request.mode,
        provider: "none",
        providerHint: request.providerHint ?? null,
        attemptedProviders,
        usedFallback: true,
        fallbackReason: reason,
        urlCount: request.urls?.length ?? 0,
        fetchedDocumentCount: prepared.sourceDocumentCount,
        preparedRequest: buildPreparedRequestMetadata(prepared)
      }
    };
  }

  private buildFallbackResultAsExecution(
    request: ResearchRequest,
    prepared: PreparedResearchRequest,
    provider: ResearchProvider
  ): ProviderExecutionResult {
    this.logger.warn("research_ai.provider.none", {
      jobId: request.jobId,
      provider
    });
    return {
      summary: buildLocalPreparationNotice(request, prepared)
    };
  }

  private resolveProviderChain(providerHint?: string): ResearchProvider[] {
    const ordered: ResearchProvider[] = [];
    const pushIfValid = (provider: ResearchProvider | undefined) => {
      if (!provider || provider === "none" || ordered.includes(provider)) {
        return;
      }
      ordered.push(provider);
    };

    pushIfValid(normalizeProviderHint(providerHint));
    pushIfValid(this.env.RESEARCH_PRIMARY_PROVIDER);
    pushIfValid(this.env.RESEARCH_FALLBACK_PROVIDER);

    return ordered;
  }

  private resolveConfiguredProviders(): ResearchProvider[] {
    return (["openai-compatible", "ollama"] as const).filter((provider) => this.isConfigured(provider));
  }

  private getMissingConfigKeys(provider: ResearchProvider) {
    const missing: string[] = [];

    if (provider === "openai-compatible") {
      if (!this.env.AI_BASE_URL) missing.push("AI_BASE_URL");
      if (!this.env.AI_API_KEY) missing.push("AI_API_KEY");
      if (!this.env.AI_MODEL) missing.push("AI_MODEL");
    }

    if (provider === "ollama") {
      if (!this.env.OLLAMA_BASE_URL) missing.push("OLLAMA_BASE_URL");
      if (!this.env.OLLAMA_MODEL) missing.push("OLLAMA_MODEL");
    }

    return missing;
  }

  private async collectImageResearchDocuments(
    request: ResearchRequest,
    documents: ArticleDocument[]
  ) {
    const imageBasedDocuments = documents
      .filter((document) => document.imageCandidates && document.imageCandidates.length > 0)
      .filter((document) => document.imageDriven || document.text.length < 900)
      .slice(0, 2);

    const results: PreparedResearchRequest["imageResearchDocuments"] = [];

    for (const document of imageBasedDocuments) {
      try {
        const imageUrls = document.imageCandidates?.slice(0, 3) ?? [];
        const imageResult = await this.ocrClient.analyzeRemoteImages({
          jobId: `${request.jobId}:image:${results.length + 1}`,
          imageUrls,
          ...(request.providerHint ? { providerHint: request.providerHint } : {}),
          prompt: [
            "These images come from a webpage that will be summarized later.",
            "Extract the visible text and describe the key informational content in Chinese.",
            "Keep the result concise and focused on facts that can support later article research.",
            document.title ? `Page title: ${document.title}` : ""
          ]
            .filter(Boolean)
            .join("\n")
        });

        const provider =
          typeof imageResult.metadata?.provider === "string"
            ? imageResult.metadata.provider
            : undefined;

        results.push({
          sourceUrl: document.sourceUrl,
          imageCount: imageUrls.length,
          ...(provider ? { provider } : {}),
          summaryPreview: truncateText(imageResult.summary ?? "", 700)
        });
      } catch (error) {
        this.logger.warn("research_ai.image_context.failed", {
          jobId: request.jobId,
          sourceUrl: document.sourceUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return results;
  }
}

function normalizeProviderHint(value?: string): ResearchProvider | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (
    normalized === "openai-compatible" ||
    normalized === "openai" ||
    normalized === "cloud" ||
    normalized === "remote"
  ) {
    return "openai-compatible";
  }
  if (normalized === "ollama" || normalized === "local") {
    return "ollama";
  }
  if (normalized === "none") {
    return "none";
  }
  return undefined;
}

function prepareResearchRequest(
  request: ResearchRequest,
  documents: ArticleDocument[],
  imageResearchDocuments: PreparedResearchRequest["imageResearchDocuments"],
  searchExpansion: SearchExpansionResult,
  profileResolution: ReturnType<typeof resolvePromptProfile>,
  sourceTextMaxChars: number,
  userPromptMaxChars: number
): PreparedResearchRequest {
  const systemPrompt = getSystemPromptForMode(request.mode) ?? defaultSystemPrompt();
  const answerRequirements = buildModeSpecificInstructions(request.mode);
  const workspacePreference = buildWorkspacePreference(profileResolution.promptProfile, request.mode);
  const rawUserPrompt = buildUserPrompt(
    request,
    documents,
    imageResearchDocuments,
    searchExpansion,
    answerRequirements,
    workspacePreference,
    sourceTextMaxChars
  );

  return {
    systemPrompt,
    userPrompt: truncateText(rawUserPrompt, userPromptMaxChars),
    userPromptPreview: truncateText(rawUserPrompt, Math.min(userPromptMaxChars, 1_500)),
    answerRequirements,
    ...(workspacePreference ? { workspacePreference } : {}),
    ...(profileResolution.promptProfile ? { promptProfile: profileResolution.promptProfile } : {}),
    promptProfileSelection: profileResolution.selection,
    ...(profileResolution.reason ? { promptProfileReason: profileResolution.reason } : {}),
    sourceDocumentCount: documents.length,
    extractedDocuments: documents.map((document) => ({
      sourceUrl: document.sourceUrl,
      ...(document.title ? { title: document.title } : {}),
      ...(document.excerpt ? { excerpt: document.excerpt } : {}),
      textPreview: truncateText(document.text, Math.min(sourceTextMaxChars, 600)),
      extractionMethod: document.extractionMethod,
      confidence: document.confidence,
      warnings: document.warnings,
      imageCandidateCount: document.imageCandidates?.length ?? 0,
      imageDriven: Boolean(document.imageDriven),
      imageCandidates: document.imageCandidates?.slice(0, 3) ?? []
    })),
    imageResearchDocuments,
    references: buildResearchReferences(
      documents,
      imageResearchDocuments,
      searchExpansion.documents,
      sourceTextMaxChars
    ),
    searchExpansion: buildSearchExpansionMetadata(searchExpansion, sourceTextMaxChars)
  };
}

function buildUserPrompt(
  request: ResearchRequest,
  documents: ArticleDocument[],
  imageResearchDocuments: PreparedResearchRequest["imageResearchDocuments"],
  searchExpansion: SearchExpansionResult,
  answerRequirements: string,
  workspacePreference: string | undefined,
  sourceTextMaxChars: number
) {
  const cleanedPrompt = cleanUserPrompt(request.prompt);
  const sections = [
    `Mode: ${request.mode}`,
    `User request:\n${cleanedPrompt || request.prompt}`,
    `Answer requirements:\n${answerRequirements}`
  ];

  if (workspacePreference) {
    sections.push(workspacePreference);
  }

  if (request.urls?.length) {
    sections.push(`Referenced URLs:\n${request.urls.join("\n")}`);
  }

  if (documents.length > 0) {
    sections.push(
      [
        "Fetched article material:",
        ...documents.map((document, index) => {
          const titleLine = document.title ? `Title: ${document.title}\n` : "";
          const excerptLine = document.excerpt ? `Excerpt: ${document.excerpt}\n` : "";
          const qualityLine = `Extraction: ${document.extractionMethod} | Confidence: ${document.confidence} | Warnings: ${document.warnings.join(", ") || "none"}\n`;
          return [
            `Document ${index + 1}`,
            `URL: ${document.sourceUrl}`,
            `${titleLine}${excerptLine}${qualityLine}Text:\n${truncateText(document.text, sourceTextMaxChars)}`
          ].join("\n");
        })
      ].join("\n\n")
    );
  } else if (request.urls?.length) {
    sections.push("Fetched article material:\nNo readable article text was extracted from the URLs.");
  }

  if (imageResearchDocuments.length > 0) {
    sections.push(
      [
        "Image-derived material:",
        ...imageResearchDocuments.map((document, index) =>
          [
            `Image set ${index + 1}`,
            `Source URL: ${document.sourceUrl}`,
            `Image count: ${document.imageCount}`,
            `Vision provider: ${document.provider ?? "unknown"}`,
            `Summary:\n${document.summaryPreview}`
          ].join("\n")
        )
      ].join("\n\n")
    );
  }

  if (searchExpansion.enabled) {
    sections.push(
      [
        "Expanded web research:",
        `Search provider: ${searchExpansion.provider}`,
        `Planned queries: ${searchExpansion.plannedQueries.join(" | ") || "none"}`,
        ...(searchExpansion.expansionPoints.length > 0
          ? [
              "Expansion points:",
              ...searchExpansion.expansionPoints.map((point) =>
                [
                  `- P${point.priority}: ${point.point}`,
                  point.reason ? `  reason: ${point.reason}` : "",
                  `  queries: ${point.queries.join(" | ")}`
                ]
                  .filter(Boolean)
                  .join("\n")
              )
            ]
          : []),
        ...(searchExpansion.planReason ? [`Plan reason: ${searchExpansion.planReason}`] : []),
        ...searchExpansion.documents.slice(0, 6).map((document, index) =>
          [
            `Search result ${index + 1}`,
            `Query: ${document.query}`,
            document.expansionPoint ? `Expansion point: ${document.expansionPoint}` : "",
            `Source kind: ${document.sourceKind}`,
            `Source tier: ${document.sourceTier}`,
            `URL: ${document.sourceUrl}`,
            document.title ? `Title: ${document.title}` : "",
            document.accountName ? `Account: ${document.accountName}` : "",
            document.wechatBiz ? `WeChat biz: ${document.wechatBiz}` : "",
            document.publishTimeRaw ? `Publish time: ${document.publishTimeRaw}` : "",
            document.snippet ? `Snippet: ${truncateText(document.snippet, 300)}` : "",
            document.fetchedDocument
              ? `Fetched content:\n${truncateText(
                  document.fetchedDocument.excerpt ?? document.fetchedDocument.text,
                  sourceTextMaxChars
                )}`
              : "Fetched content: unavailable"
          ]
            .filter(Boolean)
            .join("\n")
        ),
        ...(searchExpansion.inaccessibleSourceNotes.length > 0
          ? [
              "Inaccessible source notes:",
              ...searchExpansion.inaccessibleSourceNotes.map((item) => `- ${item}`)
            ]
          : [])
      ].join("\n\n")
    );
  }

  return sections.join("\n\n");
}

function buildPreparedRequestMetadata(prepared: PreparedResearchRequest) {
  return {
    sourceDocumentCount: prepared.sourceDocumentCount,
    systemPrompt: prepared.systemPrompt,
    answerRequirements: prepared.answerRequirements,
    workspacePreference: prepared.workspacePreference,
    promptProfile: prepared.promptProfile,
    promptProfileSelection: prepared.promptProfileSelection,
    promptProfileReason: prepared.promptProfileReason,
    userPrompt: prepared.userPrompt,
    userPromptPreview: prepared.userPromptPreview,
    extractedDocuments: prepared.extractedDocuments,
    imageResearchDocuments: prepared.imageResearchDocuments,
    references: prepared.references,
    searchExpansion: prepared.searchExpansion
  };
}

function buildResearchPostBlocks(
  request: ResearchRequest,
  prepared: PreparedResearchRequest,
  summary: string
): FeishuPostBlocks {
  const title = inferResearchPostTitle(request, prepared);
  const content: FeishuPostElement[][] = [];
  const profileLabel = formatPromptProfileLabel(prepared.promptProfile);
  const profileSelection =
    prepared.promptProfileSelection === "configured" ? "手动指定" : "自动判断";

  pushTextParagraph(content, `研究模式：${formatModeLabel(request.mode)}`);
  pushTextParagraph(
    content,
    `研究视角：${profileLabel}${prepared.promptProfile ? `（${profileSelection}）` : ""}`
  );

  if (prepared.promptProfileReason) {
    pushTextParagraph(content, `判断依据：${prepared.promptProfileReason}`);
  }

  if (prepared.extractedDocuments.length > 0 || prepared.imageResearchDocuments.length > 0) {
    pushSectionHeader(content, "参考材料");
    for (const reference of prepared.references.slice(0, 8)) {
      pushReferenceBlock(content, reference);
    }
  }

  pushSectionHeader(content, "研究结果");
  for (const paragraph of splitSummaryIntoParagraphs(summary)) {
    pushTextParagraph(content, paragraph);
  }

  return {
    zh_cn: {
      title,
      content
    }
  };
}

function resolvePromptProfile(request: ResearchRequest, documents: ArticleDocument[]) {
  if (request.promptProfile) {
    return {
      promptProfile: request.promptProfile,
      selection: "configured" as const,
      reason: "explicit_prompt_profile"
    };
  }

  const combined = [
    cleanUserPrompt(request.prompt),
    ...documents.flatMap((document) => [document.title ?? "", document.excerpt ?? "", document.text.slice(0, 2400)])
  ]
    .join("\n")
    .toLowerCase();

  const equitySignals = [
    /目标价|买入|增持|减持|跑赢|跑输|估值|市盈率|pe\b|pb\b|eps\b|roe\b|营收|净利润|利润预测|业绩|财报|股价|市值|个股|股票|标的|仓位|盈利预测/i,
    /\b[a-z]{1,5}\b.{0,6}(nasdaq|nyse|hkex|上交所|深交所)/i,
    /\b\d{6}\b/,
    /公司点评|个股点评|公司深度|公司研究|覆盖公司|首次覆盖/i
  ];
  const sectorSignals = [
    /产业链|行业|赛道|技术路线|供需|渗透率|资本开支|政策|监管|上游|中游|下游|生态|基础设施|装机|产能|路线选择/i,
    /ai|人工智能|算力|服务器|光模块|铜连接|稀土|永磁|新能源|储能|核电|油气|生物医药|创新药|glp-1|adc|细胞治疗/i
  ];

  const equityHits = equitySignals.reduce((count, pattern) => count + Number(pattern.test(combined)), 0);
  const sectorHits = sectorSignals.reduce((count, pattern) => count + Number(pattern.test(combined)), 0);

  if (equityHits >= 2 && equityHits >= sectorHits) {
    return {
      promptProfile: "equity-research",
      selection: "inferred" as const,
      reason: `equity_signals=${equityHits};sector_signals=${sectorHits}`
    };
  }

  return {
    promptProfile: "sector-research",
    selection: "inferred" as const,
    reason: `sector_default;equity_signals=${equityHits};sector_signals=${sectorHits}`
  };
}

function buildResearchReferences(
  documents: ArticleDocument[],
  imageResearchDocuments: PreparedResearchRequest["imageResearchDocuments"],
  searchDocuments: SearchDocument[],
  sourceTextMaxChars: number
) {
  const articleReferences = documents.map((document) => ({
    sourceType: "article" as const,
    sourceUrl: document.sourceUrl,
    ...(document.title ? { title: document.title } : {}),
    ...(document.excerpt ? { excerpt: document.excerpt } : {}),
    summaryPreview: truncateText(document.excerpt ?? document.text, Math.min(sourceTextMaxChars, 400))
  }));

  const imageReferences = imageResearchDocuments.map((document) => ({
    sourceType: "image" as const,
    sourceUrl: document.sourceUrl,
    summaryPreview: truncateText(document.summaryPreview, 400)
  }));

  const searchReferences = searchDocuments.map((document) => ({
    sourceType: "search" as const,
    sourceUrl: document.sourceUrl,
    ...(document.title ? { title: document.title } : {}),
    ...(document.snippet ? { excerpt: document.snippet } : {}),
    ...(document.query ? { query: document.query } : {}),
    sourceKind: document.sourceKind,
    sourceTier: document.sourceTier,
    ...(document.accountName ? { accountName: document.accountName } : {}),
    ...(document.wechatBiz ? { wechatBiz: document.wechatBiz } : {}),
    ...(document.publishTimeRaw ? { publishTimeRaw: document.publishTimeRaw } : {}),
    ...(document.publishTimestamp ? { publishTimestamp: document.publishTimestamp } : {}),
    summaryPreview: truncateText(
      document.fetchedDocument?.excerpt ??
        document.fetchedDocument?.text ??
        document.snippet ??
        document.sourceUrl,
      400
    )
  }));

  return [...articleReferences, ...imageReferences, ...searchReferences];
}

function buildSearchExpansionMetadata(
  searchExpansion: SearchExpansionResult,
  sourceTextMaxChars: number
) {
  return {
    enabled: searchExpansion.enabled,
    provider: searchExpansion.provider,
    plannedQueries: searchExpansion.plannedQueries,
    expansionPoints: searchExpansion.expansionPoints,
    ...(searchExpansion.planReason ? { planReason: searchExpansion.planReason } : {}),
    inaccessibleSourceNotes: searchExpansion.inaccessibleSourceNotes,
    warnings: searchExpansion.warnings,
    documents: searchExpansion.documents.map((document) => ({
      query: document.query,
      ...(document.expansionPoint ? { expansionPoint: document.expansionPoint } : {}),
      sourceUrl: document.sourceUrl,
      ...(document.title ? { title: document.title } : {}),
      ...(document.snippet ? { snippet: truncateText(document.snippet, 240) } : {}),
      ...(document.source ? { source: document.source } : {}),
      sourceKind: document.sourceKind,
      sourceTier: document.sourceTier,
      ...(document.accountName ? { accountName: document.accountName } : {}),
      ...(document.wechatBiz ? { wechatBiz: document.wechatBiz } : {}),
      ...(document.publishTimeRaw ? { publishTimeRaw: document.publishTimeRaw } : {}),
      ...(document.publishTimestamp ? { publishTimestamp: document.publishTimestamp } : {}),
      rankingScore: document.rankingScore,
      ...(document.fetchedDocument?.title ? { fetchedTitle: document.fetchedDocument.title } : {}),
      ...(document.fetchedDocument?.excerpt ? { fetchedExcerpt: document.fetchedDocument.excerpt } : {}),
      ...(document.fetchedDocument
        ? {
            fetchedPreview: truncateText(
              document.fetchedDocument.excerpt ?? document.fetchedDocument.text,
              Math.min(sourceTextMaxChars, 400)
            )
          }
        : {})
    }))
  };
}

function inferResearchPostTitle(
  request: ResearchRequest,
  prepared: PreparedResearchRequest
) {
  const sourceTitle = prepared.extractedDocuments[0]?.title?.trim();
  if (sourceTitle) {
    return truncateText(sourceTitle, 60);
  }

  const cleanedPrompt = cleanUserPrompt(request.prompt);
  if (cleanedPrompt) {
    return truncateText(cleanedPrompt, 60);
  }

  return formatModeLabel(request.mode);
}

function formatModeLabel(mode: TaskMode) {
  switch (mode) {
    case "article_precheck":
      return "文章预读";
    case "article_research":
      return "统一研究";
    case "article_verify":
      return "查证";
    case "summarize":
      return "总结";
    case "general_chat":
      return "问答";
    default:
      return mode;
  }
}

function formatPromptProfileLabel(profileId?: string) {
  switch (profileId) {
    case "sector-research":
      return "主题/行业研究";
    case "equity-research":
      return "公司/股票研究";
    case "reading":
      return "阅读";
    case "research":
      return "研究";
    case "management":
      return "管理摘要";
    case "image-lab":
      return "图像研究";
    default:
      return profileId ?? "默认";
  }
}

function splitSummaryIntoParagraphs(summary: string) {
  return summary
    .split(/\r?\n+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function pushSectionHeader(content: FeishuPostElement[][], text: string) {
  content.push([{ tag: "text", text: `【${text}】` }]);
}

function pushTextParagraph(content: FeishuPostElement[][], text: string) {
  const normalized = text.trim();
  if (!normalized) {
    return;
  }
  content.push([{ tag: "text", text: normalized }]);
}

function pushReferenceBlock(
  content: FeishuPostElement[][],
  reference: PreparedResearchRequest["references"][number]
) {
  const labelParts = [reference.title ?? reference.sourceUrl];
  if (reference.sourceKind === "wechat") {
    labelParts.push("公众号");
  }
  if (reference.sourceTier && reference.sourceKind !== "wechat") {
    labelParts.push(reference.sourceTier);
  }
  if (reference.accountName) {
    labelParts.push(reference.accountName);
  }
  content.push([
    { tag: "text", text: `来源：${labelParts.join(" | ")} ` },
    { tag: "a", text: "打开链接", href: reference.sourceUrl }
  ]);

  if (reference.publishTimeRaw) {
    pushTextParagraph(content, `时间：${reference.publishTimeRaw}`);
  }

  if (reference.excerpt) {
    pushTextParagraph(content, `摘要：${truncateText(reference.excerpt, 120)}`);
    return;
  }

  if (reference.summaryPreview) {
    pushTextParagraph(content, `摘要：${truncateText(reference.summaryPreview, 120)}`);
  }
}

function buildLocalPreparationNotice(
  request: ResearchRequest,
  prepared: PreparedResearchRequest
) {
  const cleanedPrompt = cleanUserPrompt(request.prompt);
  const titles =
    prepared.extractedDocuments.length > 0
      ? prepared.extractedDocuments
          .map((item) => `- ${item.title ?? item.sourceUrl}`)
          .join("\n")
      : "- No readable article text was extracted.";
  const firstPreview = prepared.extractedDocuments[0]?.textPreview;
  const previewBlock = firstPreview ? `\n\nExtracted preview:\n${firstPreview}` : "";
  const urlBlock =
    request.urls && request.urls.length > 0
      ? `\n\nReferenced URLs:\n- ${request.urls.join("\n- ")}`
      : "";

  return [
    "Local preprocessing completed, but no research provider is available.",
    `Mode: ${request.mode}`,
    `User request: ${cleanedPrompt || request.prompt}`,
    `Fetched documents: ${prepared.sourceDocumentCount}`,
    `Fetched titles:\n${titles}`,
    previewBlock,
    urlBlock,
    "",
    "Next step: configure a primary or fallback research provider such as OpenAI-compatible or Ollama."
  ]
    .filter(Boolean)
    .join("\n");
}

function extractOpenAiContent(response: ChatCompletionResponse) {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
  }
  return "";
}

function cleanUserPrompt(prompt: string) {
  return prompt.replace(/^\/\S+\s*/, "").trim();
}

function defaultSystemPrompt() {
  return [
    "You are a Chinese research assistant.",
    "Give a clear, accurate, concise answer in Chinese based on the provided inputs."
  ].join(" ");
}

function buildModeSpecificInstructions(mode: TaskMode) {
  switch (mode) {
    case "article_precheck":
      return [
        "Return sections in this order:",
        "1. 主题",
        "2. 核心要点（3-5条）",
        "3. 是否值得深读",
        "4. 建议下一步",
        "5. 不确定点",
        "Keep the answer concise and avoid long exposition."
      ].join("\n");
    case "article_research":
      return [
        "Return sections in this order:",
        "1. 核心观点",
        "2. 关键事实与论据",
        "3. 重要线索提取",
        "4. 线索扩展研究",
        "5. 行业与公司扩面",
        "6. 初步结论与研究判断",
        "7. 值得继续追踪的问题",
        "8. 下一步阅读与研究路径",
        "9. 不确定点",
        "In section 4, explicitly analyze forward demand drivers, causal chains, upstream/downstream dependencies, and route choices by major vendors when relevant.",
        "In section 5, explicitly analyze reverse constraints, substitution risks, bottlenecks, competing technical routes, and representative company sets when relevant.",
        "Do not stop at restating the article. Expand the research surface in a structured way, but clearly mark unsupported or uncertain parts."
      ].join("\n");
    case "article_verify":
      return [
        "Return sections in this order:",
        "1. 可直接支持的内容",
        "2. 存疑或证据不足的内容",
        "3. 建议补查项",
        "Be strict about evidence boundaries."
      ].join("\n");
    case "summarize":
      return [
        "Provide a concise Chinese summary.",
        "If helpful, use 1 short opening paragraph plus 3-5 key points.",
        "If the material is incomplete, say so briefly."
      ].join("\n");
    case "general_chat":
      return [
        "Answer the user's request directly in Chinese.",
        "If the user is asking for analysis, prefer a short structured answer.",
        "Do not overstate uncertain details."
      ].join("\n");
    default:
      return "Answer clearly in Chinese based only on the provided material.";
  }
}

function truncateText(value: string, maxChars: number) {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function safeNumber(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function normalizeAiError(
  error: unknown,
  request: ResearchRequest,
  provider: ResearchProvider
) {
  if (error instanceof RetryableError) {
    return error;
  }

  if (error instanceof TimeoutError) {
    return new RetryableError(
      "AI_TIMEOUT",
      `AI request timed out for ${request.mode} (${request.jobId}) via ${provider}.`
    );
  }

  if (error instanceof ExternalServiceError) {
    if (error.status === 401 || error.status === 403) {
      return new ExternalServiceError(
        "AI_AUTH_FAILED",
        `Research provider ${provider} authentication failed.`,
        error.status
      );
    }

    if (error.status === 400 || error.status === 404) {
      return new ExternalServiceError(
        "AI_REQUEST_INVALID",
        `Research provider ${provider} rejected the request. Check endpoint, model, and payload format.`,
        error.status
      );
    }

    if (error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429) {
      return new RetryableError(
        "AI_TRANSIENT_HTTP",
        `Research provider ${provider} is temporarily unavailable (status ${error.status}).`
      );
    }

    if (typeof error.status === "number" && error.status >= 500) {
      return new RetryableError(
        "AI_SERVER_ERROR",
        `Research provider ${provider} server error (status ${error.status}).`
      );
    }

    return error;
  }

  if (error instanceof TypeError) {
    return new RetryableError(
      "AI_NETWORK_ERROR",
      `Research provider ${provider} network request failed for ${request.mode}: ${error.message}`
    );
  }

  return new ExternalServiceError(
    "AI_UNKNOWN_ERROR",
    error instanceof Error ? error.message : String(error)
  );
}
