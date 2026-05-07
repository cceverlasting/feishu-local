import type { Env } from "../config/env.js";
import { WebUiClient } from "../modules/web-ui/client.js";
import type { Job } from "../models/types.js";
import type { JobRepository } from "../storage/job-repository.js";
import type { Logger } from "../utils/logger.js";

interface ReviewPollerOptions {
  env: Env;
  logger: Logger;
  jobRepository: JobRepository;
  webUiClient: WebUiClient;
}

export class ReviewPoller {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly jobRepository: JobRepository;
  private readonly webUiClient: WebUiClient;
  private running = false;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ReviewPollerOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.jobRepository = options.jobRepository;
    this.webUiClient = options.webUiClient;
  }

  start() {
    if (this.running) {
      return;
    }
    this.running = true;
    this.logger.info("review_poller.start", {
      pollIntervalMs: this.env.WEB_POLL_INTERVAL_MS
    });
    this.schedule();
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  private schedule() {
    this.timer = setTimeout(() => {
      void this.tick();
    }, this.env.WEB_POLL_INTERVAL_MS);
  }

  private async tick() {
    if (!this.running) {
      return;
    }

    const jobs = this.jobRepository.listByStatus("needs_review");
    for (const job of jobs) {
      try {
        await this.pollJob(job);
      } catch (error) {
        this.logger.warn("review_poller.poll_failed", {
          jobId: job.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    this.schedule();
  }

  private async pollJob(job: Job) {
    if (!job.editUrl) {
      return;
    }

    const remoteState = await this.webUiClient.getReviewState(job);
    if (!remoteState || remoteState.status !== "completed") {
      return;
    }

    const patch: Parameters<JobRepository["update"]>[1] = {
      status: "completed",
      completedAt: new Date().toISOString(),
      editUrl: remoteState.editUrl ?? job.editUrl
    };
    if (remoteState.result ?? job.result) {
      patch.result = remoteState.result ?? job.result;
    }

    this.jobRepository.update(job.id, patch);

    this.logger.info("review_poller.completed", {
      jobId: job.id
    });
  }
}
