import type { Env } from "../config/env.js";
import type { Job, NormalizedInput, TaskPlan } from "../models/types.js";
import type { JobRepository } from "../storage/job-repository.js";
import { createJobId } from "../utils/ids.js";
import type { Logger } from "../utils/logger.js";
import { CommandRouter } from "./router.js";

interface IntakeServiceOptions {
  env: Env;
  logger: Logger;
  jobRepository: JobRepository;
  router: CommandRouter;
}

export class IntakeService {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly jobRepository: JobRepository;
  private readonly router: CommandRouter;

  constructor(options: IntakeServiceOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.jobRepository = options.jobRepository;
    this.router = options.router;
  }

  submit(input: NormalizedInput) {
    const plan = this.router.route(input);
    const now = new Date().toISOString();
    const job: Job = {
      id: createJobId(),
      source: input.source,
      sourceMessageId: input.messageId,
      userId: input.userId,
      chatId: input.chatId,
      type: plan.jobType,
      mode: plan.mode,
      status: "queued",
      inputSummary: summarizeInput(input, plan),
      plan,
      attempt: 0,
      maxAttempts: this.env.JOB_MAX_ATTEMPTS,
      queuedAt: now,
      replyMode: plan.replyMode ?? "text",
      createdAt: now,
      updatedAt: now
    };
    const attachments = toAttachments(input);
    if (attachments) {
      job.attachments = attachments;
    }

    this.jobRepository.create(job);
    this.logger.info("intake.submit", {
      jobId: job.id,
      chatId: job.chatId,
      mode: job.mode,
      type: job.type
    });

    return {
      job,
      plan
    };
  }
}

function summarizeInput(input: NormalizedInput, plan: TaskPlan) {
  if (input.type === "text") {
    return `${plan.mode}: ${input.text.slice(0, 120)}`;
  }

  return `${plan.mode}: ${input.fileName ?? input.localPath ?? input.type}`;
}

function toAttachments(input: NormalizedInput): Job["attachments"] | undefined {
  if (input.type === "text") {
    return undefined;
  }

  return [
    {
      name: input.fileName ?? `${input.type}-input`,
      localPath: input.localPath,
      ...(input.mimeType ? { mimeType: input.mimeType } : {})
    }
  ];
}
