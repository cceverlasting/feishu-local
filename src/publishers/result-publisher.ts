import type { Job, ModuleResult } from "../models/types.js";
import type { Logger } from "../utils/logger.js";

export interface ResultPublisher {
  publishSuccess(job: Job, result: ModuleResult): Promise<void>;
  publishFailure(job: Job, errorMessage: string): Promise<void>;
}

export class LoggingResultPublisher implements ResultPublisher {
  constructor(private readonly logger: Logger) {}

  async publishSuccess(job: Job, result: ModuleResult) {
    this.logger.info("result.publish.success", {
      jobId: job.id,
      chatId: job.chatId,
      mode: job.mode,
      summary: result.summary,
      richTextBlockCount:
        result.richTextBlocks &&
        typeof result.richTextBlocks === "object" &&
        "zh_cn" in result.richTextBlocks &&
        Array.isArray((result.richTextBlocks as { zh_cn?: { content?: unknown } }).zh_cn?.content)
          ? (result.richTextBlocks as { zh_cn?: { content?: unknown[] } }).zh_cn?.content?.length ?? 0
          : 0,
      provider: result.metadata?.provider,
      attemptedProviders: result.metadata?.attemptedProviders,
      outputFileCount: result.outputFiles?.length ?? 0,
      editUrl: result.editUrl,
      metadataKeys:
        result.metadata && typeof result.metadata === "object"
          ? Object.keys(result.metadata)
          : []
    });
  }

  async publishFailure(job: Job, errorMessage: string) {
    this.logger.error("result.publish.failure", {
      jobId: job.id,
      chatId: job.chatId,
      mode: job.mode,
      error: errorMessage
    });
  }
}
