import type { Env } from "../../config/env.js";
import type { ModuleResult } from "../../models/types.js";
import { ExternalServiceError } from "../../utils/errors.js";
import { fetchJson } from "../../utils/http.js";
import type { Logger } from "../../utils/logger.js";

interface DraftContractInput {
  jobId: string;
  userId?: string;
  chatId?: string;
  title?: string;
  prompt: string;
  sourceText?: string;
  metadata?: Record<string, unknown>;
}

interface DraftContractResponse {
  ok: boolean;
  summary?: string;
  docxPath?: string;
  pdfPath?: string;
  remoteDocxUrl?: string;
  remotePdfUrl?: string;
  draftText?: string;
  editUrl?: string;
  metadata?: Record<string, unknown>;
  error?: {
    code?: string;
    message?: string;
  };
}

export class DemoClient {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger
  ) {}

  isConfigured() {
    return Boolean(this.env.DEMO_BASE_URL);
  }

  logConfiguration() {
    this.logger.info("demo_service.config", {
      configured: this.isConfigured(),
      baseUrl: this.env.DEMO_BASE_URL
    });
  }

  async draftContract(input: DraftContractInput): Promise<ModuleResult> {
    if (!this.env.DEMO_BASE_URL) {
      return {
        ok: true,
        summary: input.sourceText ?? input.prompt,
        metadata: {
          jobId: input.jobId,
          mocked: true,
          reason: "demo_service_not_configured"
        }
      };
    }

    const url = new URL("/contracts/draft", this.env.DEMO_BASE_URL).toString();

    this.logger.info("demo_service.contract_draft.start", {
      jobId: input.jobId,
      url
    });

    const response = await fetchJson<DraftContractResponse>(url, {
      method: "POST",
      timeoutMs: this.env.HTTP_TIMEOUT_MS,
      retryCount: 1,
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(input)
    });

    if (!response.ok) {
      throw new ExternalServiceError(
        response.error?.code ?? "DEMO_CONTRACT_DRAFT_FAILED",
        response.error?.message ?? "Demo contract draft request failed."
      );
    }

    const result: ModuleResult = {
      ok: true,
      summary: response.summary ?? response.draftText ?? "Contract draft generated.",
      outputFiles: [
        response.docxPath
          ? {
              name: "contract.docx",
              localPath: response.docxPath,
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
          : undefined,
        response.pdfPath
          ? {
              name: "contract.pdf",
              localPath: response.pdfPath,
              mimeType: "application/pdf"
            }
          : undefined,
        response.remoteDocxUrl
          ? {
              name: "contract.docx",
              remoteUrl: response.remoteDocxUrl,
              mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            }
          : undefined,
        response.remotePdfUrl
          ? {
              name: "contract.pdf",
              remoteUrl: response.remotePdfUrl,
              mimeType: "application/pdf"
            }
          : undefined
      ].filter((item): item is NonNullable<typeof item> => Boolean(item))
    };
    if (response.editUrl) {
      result.editUrl = response.editUrl;
    }
    if (response.metadata) {
      result.metadata = response.metadata;
    }
    return result;
  }
}
