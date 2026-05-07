import { readFile } from "node:fs/promises";
import type { Env } from "../../config/env.js";
import type { ModuleResult } from "../../models/types.js";
import {
  ExternalServiceError,
  RetryableError,
  TimeoutError
} from "../../utils/errors.js";
import { fetchBuffer, fetchJson } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";

type VisionProvider = "openai-compatible" | "ollama" | "none";

interface VisionRequest {
  jobId: string;
  prompt?: string;
  localPath: string;
  mimeType?: string;
  providerHint?: string;
}

interface RemoteVisionRequest {
  jobId: string;
  prompt?: string;
  imageUrls: string[];
  providerHint?: string;
}

interface ImagePayload {
  base64: string;
  mimeType: string;
  label: string;
}

interface OpenAiVisionResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; text?: string }>;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

interface OllamaVisionResponse {
  message?: {
    content?: string;
  };
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OcrClient {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {}

  logConfiguration() {
    this.logger.info("vision_ai.config", {
      primaryProvider: this.env.RESEARCH_PRIMARY_PROVIDER,
      fallbackProvider: this.env.RESEARCH_FALLBACK_PROVIDER ?? null,
      openAiBaseUrl: this.env.AI_BASE_URL,
      openAiModel: this.env.AI_MODEL,
      ollamaBaseUrl: this.env.OLLAMA_BASE_URL,
      ollamaModel: this.env.OLLAMA_MODEL
    });
  }

  async run(request: VisionRequest): Promise<ModuleResult> {
    const providerChain = this.resolveProviderChain(request.providerHint);
    const imagePayload = await this.readLocalImagePayload(request.localPath, request.mimeType);

    if (providerChain.length === 0) {
      return this.buildFallbackResult(request, "no_provider_configured", []);
    }

    const attemptedProviders: VisionProvider[] = [];
    let lastError: unknown;

    for (const provider of providerChain) {
      attemptedProviders.push(provider);

      if (!this.isConfigured(provider)) {
        lastError = new ExternalServiceError(
          "PROVIDER_NOT_CONFIGURED",
          `Vision provider ${provider} is not configured.`
        );
        continue;
      }

      try {
        const result =
          provider === "openai-compatible"
            ? await this.executeOpenAiCompatible(request.prompt, imagePayload)
            : await this.executeOllama(request.prompt, imagePayload);

        return {
          ok: true,
          summary: result.summary.trim(),
          metadata: {
            jobId: request.jobId,
            provider,
            providerHint: request.providerHint ?? null,
            attemptedProviders,
            usedFallback: attemptedProviders.length > 1,
            localPath: request.localPath,
            mimeType: request.mimeType ?? null,
            totalTokens: result.totalTokens
          }
        };
      } catch (error) {
        lastError = normalizeVisionError(error, request, provider);
        this.logger.warn("vision_ai.request.failed", {
          jobId: request.jobId,
          provider,
          error: lastError instanceof Error ? lastError.message : String(lastError)
        });
      }
    }

    if (!lastError) {
      return this.buildFallbackResult(request, "provider_chain_exhausted", attemptedProviders);
    }

    throw lastError;
  }

  async analyzeRemoteImages(request: RemoteVisionRequest): Promise<ModuleResult> {
    const providerChain = this.resolveProviderChain(request.providerHint);
    const imagePayloads = await this.readRemoteImagePayloads(request.imageUrls);

    if (providerChain.length === 0) {
      return this.buildRemoteFallbackResult(request, "no_provider_configured", [], imagePayloads.length);
    }

    const attemptedProviders: VisionProvider[] = [];
    let lastError: unknown;

    for (const provider of providerChain) {
      attemptedProviders.push(provider);

      if (!this.isConfigured(provider)) {
        lastError = new ExternalServiceError(
          "PROVIDER_NOT_CONFIGURED",
          `Vision provider ${provider} is not configured.`
        );
        continue;
      }

      try {
        const result =
          provider === "openai-compatible"
            ? await this.executeOpenAiCompatible(request.prompt, imagePayloads)
            : await this.executeOllama(request.prompt, imagePayloads);

        return {
          ok: true,
          summary: result.summary.trim(),
          metadata: {
            jobId: request.jobId,
            provider,
            providerHint: request.providerHint ?? null,
            attemptedProviders,
            usedFallback: attemptedProviders.length > 1,
            remoteImageCount: imagePayloads.length,
            remoteImageUrls: request.imageUrls,
            totalTokens: result.totalTokens
          }
        };
      } catch (error) {
        lastError = normalizeVisionError(error, { jobId: request.jobId, localPath: request.imageUrls[0] ?? "remote-image" }, provider);
        this.logger.warn("vision_ai.remote.request.failed", {
          jobId: request.jobId,
          provider,
          error: lastError instanceof Error ? lastError.message : String(lastError)
        });
      }
    }

    if (!lastError) {
      return this.buildRemoteFallbackResult(
        request,
        "provider_chain_exhausted",
        attemptedProviders,
        imagePayloads.length
      );
    }

    throw lastError;
  }

  private async readLocalImagePayload(localPath: string, mimeType?: string): Promise<ImagePayload[]> {
    const buffer = await readFile(localPath);
    return [
      {
        base64: buffer.toString("base64"),
        mimeType: mimeType ?? inferMimeTypeFromUrl(localPath),
        label: localPath
      }
    ];
  }

  private async readRemoteImagePayloads(imageUrls: string[]) {
    const payloads: ImagePayload[] = [];

    for (const imageUrl of imageUrls) {
      try {
        const buffer = await fetchBuffer(imageUrl, {
          method: "GET",
          timeoutMs: this.env.HTTP_TIMEOUT_MS,
          retryCount: 1,
          headers: {
            "user-agent": "FeishuLocalAI/0.1 (+https://local)"
          }
        });
        payloads.push({
          base64: buffer.toString("base64"),
          mimeType: inferMimeTypeFromUrl(imageUrl),
          label: imageUrl
        });
      } catch (error) {
        this.logger.warn("vision_ai.remote_image.fetch_failed", {
          imageUrl,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    if (payloads.length === 0) {
      throw new RetryableError("REMOTE_IMAGE_FETCH_FAILED", "No remote image could be fetched for vision analysis.");
    }

    return payloads;
  }

  private async executeOpenAiCompatible(userPrompt: string | undefined, imagePayloads: ImagePayload[]) {
    const url = new URL("/v1/chat/completions", this.env.AI_BASE_URL).toString();
    const response = await fetchJson<OpenAiVisionResponse>(url, {
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
            content: buildVisionSystemPrompt()
          },
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildVisionUserPrompt(userPrompt, imagePayloads.length)
              },
              ...imagePayloads.map((item) => ({
                type: "image_url",
                image_url: {
                  url: `data:${item.mimeType};base64,${item.base64}`
                }
              }))
            ]
          }
        ],
        temperature: 0.2
      })
    });

    const content = extractContent(response.choices?.[0]?.message?.content);
    if (!content) {
      throw new ExternalServiceError("VISION_EMPTY_RESPONSE", "Vision response content was empty.");
    }

    return {
      summary: content,
      totalTokens: response.usage?.total_tokens
    };
  }

  private async executeOllama(userPrompt: string | undefined, imagePayloads: ImagePayload[]) {
    const url = new URL("/api/chat", this.env.OLLAMA_BASE_URL).toString();
    const response = await fetchJson<OllamaVisionResponse>(url, {
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
            content: buildVisionSystemPrompt()
          },
          {
            role: "user",
            content: buildVisionUserPrompt(userPrompt, imagePayloads.length),
            images: imagePayloads.map((item) => item.base64)
          }
        ],
        options: {
          temperature: 0.2
        }
      })
    });

    const content = response.message?.content?.trim();
    if (!content) {
      throw new ExternalServiceError("VISION_EMPTY_RESPONSE", "Ollama vision response was empty.");
    }

    return {
      summary: content,
      totalTokens: safeNumber(response.prompt_eval_count) + safeNumber(response.eval_count)
    };
  }

  private buildFallbackResult(
    request: VisionRequest,
    reason: string,
    attemptedProviders: VisionProvider[]
  ): ModuleResult {
    return {
      ok: true,
      summary: [
        "Image input was received, but no OCR-capable provider is available.",
        `Job: ${request.jobId}`,
        `Local file: ${request.localPath}`,
        "Next step: configure OpenAI-compatible vision or Ollama multimodal support."
      ].join("\n"),
      metadata: {
        jobId: request.jobId,
        provider: "none",
        providerHint: request.providerHint ?? null,
        attemptedProviders,
        usedFallback: true,
        fallbackReason: reason,
        localPath: request.localPath,
        mimeType: request.mimeType ?? null
      }
    };
  }

  private buildRemoteFallbackResult(
    request: RemoteVisionRequest,
    reason: string,
    attemptedProviders: VisionProvider[],
    imageCount: number
  ): ModuleResult {
    return {
      ok: true,
      summary: [
        "Remote images were detected, but no vision-capable provider is available.",
        `Job: ${request.jobId}`,
        `Image count: ${imageCount}`,
        "Next step: configure OpenAI-compatible vision or Ollama multimodal support."
      ].join("\n"),
      metadata: {
        jobId: request.jobId,
        provider: "none",
        providerHint: request.providerHint ?? null,
        attemptedProviders,
        usedFallback: true,
        fallbackReason: reason,
        remoteImageCount: imageCount,
        remoteImageUrls: request.imageUrls
      }
    };
  }

  private resolveProviderChain(providerHint?: string): VisionProvider[] {
    const ordered: VisionProvider[] = [];
    const pushIfValid = (provider: VisionProvider | undefined) => {
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

  private isConfigured(provider: VisionProvider) {
    if (provider === "openai-compatible") {
      return Boolean(this.env.AI_BASE_URL && this.env.AI_API_KEY && this.env.AI_MODEL);
    }
    if (provider === "ollama") {
      return Boolean(this.env.OLLAMA_BASE_URL && this.env.OLLAMA_MODEL);
    }
    return false;
  }
}

function buildVisionSystemPrompt() {
  return [
    "You are a careful Chinese OCR and image analysis assistant.",
    "First extract visible text as accurately as possible.",
    "Then summarize the image's informational content in Chinese.",
    "If multiple images are provided, merge them into one coherent understanding and note any ordering ambiguity.",
    "If part of the image is unreadable, cropped, blurred, or uncertain, explicitly say so.",
    "Do not invent text that is not visible.",
    "Use the following sections when appropriate: 1. 识别文字 2. 图片内容总结 3. 关键信息 4. 不确定点."
  ].join(" ");
}

function buildVisionUserPrompt(userPrompt?: string, imageCount = 1) {
  return [
    `Please perform OCR on ${imageCount > 1 ? `these ${imageCount} related images` : "this image"} and then summarize the content in Chinese.`,
    "Focus on readable text, meaningful visual structure, and facts useful for later research or summarization.",
    userPrompt ? `Additional instruction: ${userPrompt}` : ""
  ]
    .filter(Boolean)
    .join("\n");
}

function extractContent(content: string | Array<{ type?: string; text?: string }> | undefined) {
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

function normalizeProviderHint(value?: string): VisionProvider | undefined {
  if (!value) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "openai-compatible" || normalized === "openai" || normalized === "remote") {
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

function safeNumber(value: unknown) {
  return typeof value === "number" ? value : 0;
}

function inferMimeTypeFromUrl(value: string) {
  if (/\.png(\?|$)/i.test(value)) return "image/png";
  if (/\.webp(\?|$)/i.test(value)) return "image/webp";
  if (/\.gif(\?|$)/i.test(value)) return "image/gif";
  return "image/jpeg";
}

function normalizeVisionError(error: unknown, request: VisionRequest, provider: VisionProvider) {
  if (error instanceof RetryableError) {
    return error;
  }
  if (error instanceof TimeoutError) {
    return new RetryableError(
      "VISION_TIMEOUT",
      `Vision request timed out for ${request.jobId} via ${provider}.`
    );
  }
  if (error instanceof ExternalServiceError) {
    if (error.status === 401 || error.status === 403) {
      return new ExternalServiceError(
        "VISION_AUTH_FAILED",
        `Vision provider ${provider} authentication failed.`,
        error.status
      );
    }
    if (error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429) {
      return new RetryableError(
        "VISION_TRANSIENT_HTTP",
        `Vision provider ${provider} is temporarily unavailable (status ${error.status}).`
      );
    }
    if (typeof error.status === "number" && error.status >= 500) {
      return new RetryableError(
        "VISION_SERVER_ERROR",
        `Vision provider ${provider} server error (status ${error.status}).`
      );
    }
    return error;
  }
  if (error instanceof TypeError) {
    return new RetryableError(
      "VISION_NETWORK_ERROR",
      `Vision provider ${provider} network error for ${request.jobId}: ${error.message}`
    );
  }
  return new ExternalServiceError(
    "VISION_UNKNOWN_ERROR",
    error instanceof Error ? error.message : String(error)
  );
}
