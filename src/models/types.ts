export type LogLevel = "debug" | "info" | "warn" | "error";

export type JobStatus =
  | "received"
  | "routing"
  | "queued"
  | "processing"
  | "needs_review"
  | "completed"
  | "failed";

export type JobType =
  | "article"
  | "contract"
  | "audio"
  | "image"
  | "file"
  | "email"
  | "general";

export type TaskMode =
  | "article_precheck"
  | "article_research"
  | "article_verify"
  | "contract_draft"
  | "contract_review"
  | "email_draft"
  | "summarize"
  | "speech_to_text"
  | "image_understanding"
  | "file_processing"
  | "web_edit"
  | "general_chat";

export type NormalizedInput =
  | {
      source: "feishu";
      type: "text";
      text: string;
      command?: string;
      hasUrl: boolean;
      urls?: string[];
      userId: string;
      chatId: string;
      messageId: string;
      mentionsBot?: boolean;
    }
  | {
      source: "feishu";
      type: "image" | "audio" | "file" | "video";
      text?: string;
      command?: string;
      hasUrl?: boolean;
      userId: string;
      chatId: string;
      messageId: string;
      fileName?: string;
      mimeType?: string;
      localPath: string;
      mentionsBot?: boolean;
    };

export interface TaskPlan {
  jobType: JobType;
  mode: TaskMode;
  providerHint?: string;
  promptProfile?: string;
  requiresAsync?: boolean;
  replyMode?: "text" | "post" | "file" | "mixed";
  input: NormalizedInput;
}

export interface ChatRouteConfig {
  mode: TaskMode;
  jobType?: JobType;
  providerHint?: string;
  promptProfile?: string;
  replyMode?: "text" | "post" | "file" | "mixed";
}

export interface ModuleResult {
  ok: boolean;
  summary?: string;
  richTextBlocks?: unknown;
  outputFiles?: Array<{
    name: string;
    localPath?: string;
    remoteUrl?: string;
    mimeType?: string;
  }>;
  editUrl?: string;
  metadata?: Record<string, unknown>;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
  };
}

export interface Job {
  id: string;
  source: "feishu" | "web" | "api";
  sourceMessageId?: string;
  userId?: string;
  chatId?: string;
  type: JobType;
  mode?: TaskMode;
  status: JobStatus;
  inputSummary: string;
  rawInputPath?: string;
  attachments?: Array<{
    name: string;
    localPath?: string;
    remoteUrl?: string;
    mimeType?: string;
  }>;
  result?: ModuleResult;
  outputFiles?: Array<{
    name: string;
    localPath: string;
    mimeType?: string;
  }>;
  editUrl?: string;
  provider?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  error?: string;
  createdAt: string;
  updatedAt: string;
  plan?: TaskPlan;
  attempt?: number;
  maxAttempts?: number;
  queuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  lastHeartbeatAt?: string;
  replyMode?: "text" | "post" | "file" | "mixed";
}

export interface LogEvent {
  event: string;
  level: LogLevel;
  timestamp: string;
  data?: Record<string, unknown>;
}
