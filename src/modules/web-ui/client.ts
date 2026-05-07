import type { Env } from "../../config/env.js";
import type { Job, ModuleResult } from "../../models/types.js";
import { fetchJson } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";

interface ReviewStateResponse {
  status: "pending" | "completed";
  editUrl?: string;
  result?: ModuleResult;
}

export class WebUiClient {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {}

  isConfigured() {
    return Boolean(this.env.WEB_UI_BASE_URL && this.env.WEB_API_TOKEN);
  }

  logConfiguration() {
    this.logger.info("web_ui.config", {
      configured: this.isConfigured(),
      baseUrl: this.env.WEB_UI_BASE_URL
    });
  }

  async getReviewState(job: Job): Promise<ReviewStateResponse | null> {
    if (!this.isConfigured()) {
      return null;
    }

    const url = new URL(`/api/jobs/${job.id}`, this.env.WEB_UI_BASE_URL).toString();
    return fetchJson<ReviewStateResponse>(url, {
      method: "GET",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        authorization: `Bearer ${this.env.WEB_API_TOKEN ?? ""}`
      }
    });
  }
}
