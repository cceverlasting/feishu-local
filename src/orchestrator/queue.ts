import type { Env } from "../config/env.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { Logger } from "../utils/logger.js";
import type { JobManager } from "./job-manager.js";

interface JobQueueOptions {
  env: Env;
  logger: Logger;
  jobRepository: JobRepository;
  jobManager: JobManager;
}

export class JobQueue {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly jobRepository: JobRepository;
  private readonly jobManager: JobManager;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: JobQueueOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.jobRepository = options.jobRepository;
    this.jobManager = options.jobManager;
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.logger.info("queue.start", {
      pollIntervalMs: this.env.QUEUE_POLL_INTERVAL_MS
    });
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.logger.info("queue.stop");
  }

  private schedule() {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.env.QUEUE_POLL_INTERVAL_MS);
  }

  private async tick() {
    if (!this.running) {
      return;
    }

    const job = this.jobRepository.claimNextQueued();
    if (!job) {
      this.schedule();
      return;
    }

    await this.jobManager.process(job);
    this.schedule();
  }
}
