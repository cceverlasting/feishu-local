import type { Env } from "../config/env.js";
import type { Job, ModuleResult } from "../models/types.js";
import type { Logger } from "../utils/logger.js";
import { createFeishuClient, isFeishuConfigured } from "../adapters/feishu/client.js";
import { LoggingResultPublisher, type ResultPublisher } from "./result-publisher.js";

export class FeishuResultPublisher implements ResultPublisher {
  private readonly fallback: LoggingResultPublisher;
  private readonly client;
  private readonly configured: boolean;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {
    this.fallback = new LoggingResultPublisher(logger);
    this.configured = isFeishuConfigured(env);
    this.client = createFeishuClient(env, logger);
  }

  async publishSuccess(job: Job, result: ModuleResult) {
    await this.fallback.publishSuccess(job, result);
    if (!this.shouldPublishToFeishu(job)) {
      return;
    }

    const summary = (result.summary ?? "").trim() || "任务已完成。";
    await this.sendText(job.chatId!, summary, job.sourceMessageId);
  }

  async publishFailure(job: Job, errorMessage: string) {
    await this.fallback.publishFailure(job, errorMessage);
    if (!this.shouldPublishToFeishu(job)) {
      return;
    }

    const message = `任务失败：${errorMessage}`;
    await this.sendText(job.chatId!, message, job.sourceMessageId);
  }

  private shouldPublishToFeishu(job: Job) {
    return Boolean(
      this.configured &&
        job.source === "feishu" &&
        job.chatId &&
        job.sourceMessageId
    );
  }

  private async sendText(chatId: string, text: string, replyMessageId?: string) {
    try {
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: "chat_id"
        },
        data: {
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({ text }),
          ...(replyMessageId ? { reply_in_thread: true, reply_message_id: replyMessageId } : {})
        }
      });
    } catch (error) {
      this.logger.warn("feishu_publish.send_failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }
}
