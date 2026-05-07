import type { Env } from "../config/env.js";
import type { Job, ModuleResult, TaskMode } from "../models/types.js";
import { DemoClient } from "../modules/contract/demo-client.js";
import { ResearchClient } from "../modules/research/ai-client.js";
import { OcrClient } from "../modules/vision/ocr-client.js";
import type { ResultPublisher } from "../publishers/result-publisher.js";
import type { JobRepository } from "../storage/job-repository.js";
import { isRetryableError, RetryableError } from "../utils/errors.js";
import type { Logger } from "../utils/logger.js";

interface JobManagerOptions {
  env: Env;
  logger: Logger;
  jobRepository: JobRepository;
  demoClient: DemoClient;
  researchClient: ResearchClient;
  ocrClient: OcrClient;
  resultPublisher: ResultPublisher;
}

export class JobManager {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly jobRepository: JobRepository;
  private readonly demoClient: DemoClient;
  private readonly researchClient: ResearchClient;
  private readonly ocrClient: OcrClient;
  private readonly resultPublisher: ResultPublisher;

  constructor(options: JobManagerOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.jobRepository = options.jobRepository;
    this.demoClient = options.demoClient;
    this.researchClient = options.researchClient;
    this.ocrClient = options.ocrClient;
    this.resultPublisher = options.resultPublisher;
  }

  async recoverPendingJobs() {
    const pending = this.jobRepository.listPending();
    const now = new Date().toISOString();

    for (const job of pending) {
      if (job.status === "processing") {
        this.jobRepository.update(job.id, {
          status: "queued",
          queuedAt: now
        });
      }
    }

    this.logger.info("job.recover_pending", {
      count: pending.length
    });
  }

  async process(job: Job) {
    this.logger.info("job.process.start", {
      jobId: job.id,
      mode: job.mode,
      attempt: job.attempt ?? 0
    });

    try {
      const result = await this.execute(job);
      const completedAt = new Date().toISOString();

      const patch: Partial<Job> = {
        status: result.editUrl ? "needs_review" : "completed",
        result
      };

      if (result.editUrl) {
        patch.editUrl = result.editUrl;
      } else {
        patch.completedAt = completedAt;
      }

      const outputFiles = result.outputFiles
        ?.filter((item): item is { name: string; localPath: string; mimeType?: string } =>
          typeof item.localPath === "string"
        )
        .map((item) => {
          const output: { name: string; localPath: string; mimeType?: string } = {
            name: item.name,
            localPath: item.localPath
          };
          if (item.mimeType) {
            output.mimeType = item.mimeType;
          }
          return output;
        });

      if (outputFiles && outputFiles.length > 0) {
        patch.outputFiles = outputFiles;
      }

      this.jobRepository.update(job.id, patch);
      await this.resultPublisher.publishSuccess(job, result);

      this.logger.info("job.process.complete", {
        jobId: job.id,
        status: result.editUrl ? "needs_review" : "completed"
      });
    } catch (error) {
      const attempt = (job.attempt ?? 0) + 1;
      const maxAttempts = job.maxAttempts ?? this.env.JOB_MAX_ATTEMPTS;
      const retryable = isRetryableError(error);

      if (retryable && attempt < maxAttempts) {
        this.jobRepository.update(job.id, {
          status: "queued",
          attempt,
          queuedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : String(error)
        });

        this.logger.warn("job.process.retry", {
          jobId: job.id,
          attempt,
          maxAttempts
        });
        return;
      }

      this.jobRepository.update(job.id, {
        status: "failed",
        attempt,
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString()
      });
      await this.resultPublisher.publishFailure(job, error instanceof Error ? error.message : String(error));

      this.logger.error("job.process.failed", {
        jobId: job.id,
        attempt,
        maxAttempts,
        retryable,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async execute(job: Job): Promise<ModuleResult> {
    if (!job.plan) {
      throw new RetryableError("JOB_PLAN_MISSING", `Job plan missing for ${job.id}`);
    }

    if (job.plan.mode === "contract_draft") {
      return this.executeContractDraft(job);
    }

    if (isResearchMode(job.plan.mode)) {
      return this.executeResearch(job);
    }

    if (job.plan.mode === "image_understanding") {
      return this.executeImageUnderstanding(job);
    }

    return {
      ok: true,
      summary: `Execution completed for ${job.mode ?? job.type}.`,
      metadata: {
        jobId: job.id,
        placeholder: true,
        inputType: job.plan.input.type
      }
    };
  }

  private async executeContractDraft(job: Job) {
    const input = job.plan?.input;
    if (!input) {
      throw new RetryableError("JOB_INPUT_MISSING", `Job input missing for ${job.id}`);
    }

    const promptText = input.text?.trim() || job.inputSummary;
    const request = {
      jobId: job.id,
      title: inferContractTitle(promptText),
      prompt: promptText,
      sourceText: promptText,
      metadata: {
        source: input.source,
        inputType: input.type,
        command: input.command
      }
    } as const;

    return this.demoClient.draftContract({
      ...request,
      ...(job.userId ? { userId: job.userId } : {}),
      ...(job.chatId ? { chatId: job.chatId } : {})
    });
  }

  private async executeResearch(job: Job) {
    const plan = job.plan;
    const input = plan?.input;
    if (!plan || !input || input.type !== "text") {
      throw new RetryableError("RESEARCH_INPUT_MISSING", `Research text input missing for ${job.id}`);
    }

    return this.researchClient.run({
      jobId: job.id,
      mode: plan.mode,
      prompt: input.text,
      ...(plan.providerHint ? { providerHint: plan.providerHint } : {}),
      ...(plan.promptProfile ? { promptProfile: plan.promptProfile } : {}),
      ...(input.urls ? { urls: input.urls } : {})
    });
  }

  private async executeImageUnderstanding(job: Job) {
    const plan = job.plan;
    const input = plan?.input;
    if (!plan || !input || input.type !== "image") {
      throw new RetryableError("IMAGE_INPUT_MISSING", `Image input missing for ${job.id}`);
    }

    return this.ocrClient.run({
      jobId: job.id,
      ...(input.text ? { prompt: input.text } : {}),
      localPath: input.localPath,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(plan.providerHint ? { providerHint: plan.providerHint } : {})
    });
  }
}

function isResearchMode(mode: TaskMode) {
  return (
    mode === "article_precheck" ||
    mode === "article_research" ||
    mode === "article_verify" ||
    mode === "summarize" ||
    mode === "general_chat"
  );
}

function inferContractTitle(text: string) {
  const normalized = text.replace(/^\/\S+\s*/, "").trim();
  if (!normalized) {
    return "未命名合同草稿";
  }
  return normalized.slice(0, 40);
}
