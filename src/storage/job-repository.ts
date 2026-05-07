import type Database from "better-sqlite3";
import { openDatabase } from "./sqlite.js";
import type { Job, JobStatus } from "../models/types.js";
import { normalizeTaskMode, normalizeTaskPlan } from "../utils/task-mode.js";
import type { Logger } from "../utils/logger.js";

type MutableJobFields = Omit<Job, "id" | "createdAt">;
type UpdatePatch = {
  [Key in keyof MutableJobFields]?: MutableJobFields[Key] | undefined;
} & { updatedAt?: string };

export class JobRepository {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(filePath: string, logger: Logger) {
    this.db = openDatabase(filePath, logger);
    this.logger = logger;
  }

  initialize() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        type TEXT NOT NULL,
        source TEXT NOT NULL,
        source_message_id TEXT,
        user_id TEXT,
        chat_id TEXT,
        mode TEXT,
        input_summary TEXT NOT NULL,
        raw_input_path TEXT,
        attachments_json TEXT,
        result_json TEXT,
        output_files_json TEXT,
        edit_url TEXT,
        provider TEXT,
        model TEXT,
        usage_json TEXT,
        error TEXT,
        plan_json TEXT,
        attempt INTEGER,
        max_attempts INTEGER,
        queued_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        last_heartbeat_at TEXT,
        reply_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_chat_id ON jobs(chat_id);
      CREATE INDEX IF NOT EXISTS idx_jobs_updated_at ON jobs(updated_at);
    `);
  }

  create(job: Job) {
    const statement = this.db.prepare(`
      INSERT INTO jobs (
        id, status, type, source, source_message_id, user_id, chat_id, mode, input_summary,
        raw_input_path, attachments_json, result_json, output_files_json, edit_url, provider,
        model, usage_json, error, plan_json, attempt, max_attempts, queued_at, started_at,
        completed_at, last_heartbeat_at, reply_mode, created_at, updated_at
      ) VALUES (
        @id, @status, @type, @source, @sourceMessageId, @userId, @chatId, @mode, @inputSummary,
        @rawInputPath, @attachmentsJson, @resultJson, @outputFilesJson, @editUrl, @provider,
        @model, @usageJson, @error, @planJson, @attempt, @maxAttempts, @queuedAt, @startedAt,
        @completedAt, @lastHeartbeatAt, @replyMode, @createdAt, @updatedAt
      )
    `);

    statement.run(this.toRow(job));
    this.logger.info("job.create", { jobId: job.id, status: job.status, mode: job.mode });
  }

  getById(id: string) {
    const statement = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`);
    const row = statement.get(id) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : null;
  }

  update(id: string, patch: UpdatePatch) {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const next: Job = {
      ...existing,
      updatedAt: patch.updatedAt ?? new Date().toISOString()
    };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "updatedAt") {
        continue;
      }

      if (value === undefined) {
        delete ((next as unknown) as Record<string, unknown>)[key];
        continue;
      }

      ((next as unknown) as Record<string, unknown>)[key] = value;
    }

    const statement = this.db.prepare(`
      UPDATE jobs SET
        status = @status,
        type = @type,
        source = @source,
        source_message_id = @sourceMessageId,
        user_id = @userId,
        chat_id = @chatId,
        mode = @mode,
        input_summary = @inputSummary,
        raw_input_path = @rawInputPath,
        attachments_json = @attachmentsJson,
        result_json = @resultJson,
        output_files_json = @outputFilesJson,
        edit_url = @editUrl,
        provider = @provider,
        model = @model,
        usage_json = @usageJson,
        error = @error,
        plan_json = @planJson,
        attempt = @attempt,
        max_attempts = @maxAttempts,
        queued_at = @queuedAt,
        started_at = @startedAt,
        completed_at = @completedAt,
        last_heartbeat_at = @lastHeartbeatAt,
        reply_mode = @replyMode,
        updated_at = @updatedAt
      WHERE id = @id
    `);

    statement.run(this.toRow(next));
    return next;
  }

  listPending() {
    const statement = this.db.prepare(`
      SELECT * FROM jobs
      WHERE status IN ('received', 'routing', 'queued', 'processing')
      ORDER BY created_at ASC
    `);

    return (statement.all() as Record<string, unknown>[]).map((row) => this.fromRow(row));
  }

  claimNextQueued() {
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare(`
          SELECT * FROM jobs
          WHERE status = 'queued'
          ORDER BY queued_at ASC, created_at ASC
          LIMIT 1
        `)
        .get() as Record<string, unknown> | undefined;

      if (!row) {
        return null;
      }

      const job = this.fromRow(row);
      const now = new Date().toISOString();
      this.update(job.id, {
        status: "processing",
        startedAt: now
      });
      return this.getById(job.id);
    });

    return transaction();
  }

  listByStatus(status: JobStatus) {
    const statement = this.db.prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC`);
    return (statement.all(status) as Record<string, unknown>[]).map((row) => this.fromRow(row));
  }

  listRecent(limit: number) {
    const statement = this.db.prepare(`
      SELECT * FROM jobs
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return (statement.all(limit) as Record<string, unknown>[]).map((row) => this.fromRow(row));
  }

  retry(id: string) {
    const existing = this.getById(id);
    if (!existing) {
      return null;
    }

    const patch: UpdatePatch = {
      status: "queued",
      error: undefined,
      queuedAt: new Date().toISOString(),
      startedAt: undefined,
      completedAt: undefined
    };

    return this.update(id, patch);
  }

  private toRow(job: Job) {
    return {
      id: job.id,
      status: job.status,
      type: job.type,
      source: job.source,
      sourceMessageId: job.sourceMessageId ?? null,
      userId: job.userId ?? null,
      chatId: job.chatId ?? null,
      mode: job.mode ?? null,
      inputSummary: job.inputSummary,
      rawInputPath: job.rawInputPath ?? null,
      attachmentsJson: job.attachments ? JSON.stringify(job.attachments) : null,
      resultJson: job.result ? JSON.stringify(job.result) : null,
      outputFilesJson: job.outputFiles ? JSON.stringify(job.outputFiles) : null,
      editUrl: job.editUrl ?? null,
      provider: job.provider ?? null,
      model: job.model ?? null,
      usageJson: job.usage ? JSON.stringify(job.usage) : null,
      error: job.error ?? null,
      planJson: job.plan ? JSON.stringify(job.plan) : null,
      attempt: job.attempt ?? 0,
      maxAttempts: job.maxAttempts ?? 1,
      queuedAt: job.queuedAt ?? null,
      startedAt: job.startedAt ?? null,
      completedAt: job.completedAt ?? null,
      lastHeartbeatAt: job.lastHeartbeatAt ?? null,
      replyMode: job.replyMode ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
  }

  private fromRow(row: Record<string, unknown>): Job {
    const job: Job = {
      id: String(row.id),
      status: row.status as JobStatus,
      type: row.type as Job["type"],
      source: row.source as Job["source"],
      inputSummary: String(row.input_summary),
      attempt: typeof row.attempt === "number" ? row.attempt : 0,
      maxAttempts: typeof row.max_attempts === "number" ? row.max_attempts : 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    };

    const sourceMessageId = this.toOptionalString(row.source_message_id);
    const userId = this.toOptionalString(row.user_id);
    const chatId = this.toOptionalString(row.chat_id);
    const mode = normalizeTaskMode(this.toOptionalString(row.mode));
    const rawInputPath = this.toOptionalString(row.raw_input_path);
    const attachments = this.parseJson<Job["attachments"]>(row.attachments_json);
    const result = this.parseJson<Job["result"]>(row.result_json);
    const outputFiles = this.parseJson<Job["outputFiles"]>(row.output_files_json);
    const editUrl = this.toOptionalString(row.edit_url);
    const provider = this.toOptionalString(row.provider);
    const model = this.toOptionalString(row.model);
    const usage = this.parseJson<Job["usage"]>(row.usage_json);
    const error = this.toOptionalString(row.error);
    const plan = normalizeTaskPlan(this.parseJson<Job["plan"]>(row.plan_json));
    const queuedAt = this.toOptionalString(row.queued_at);
    const startedAt = this.toOptionalString(row.started_at);
    const completedAt = this.toOptionalString(row.completed_at);
    const lastHeartbeatAt = this.toOptionalString(row.last_heartbeat_at);
    const replyMode = this.toOptionalString(row.reply_mode) as Job["replyMode"] | undefined;

    if (sourceMessageId) job.sourceMessageId = sourceMessageId;
    if (userId) job.userId = userId;
    if (chatId) job.chatId = chatId;
    if (mode) job.mode = mode;
    if (rawInputPath) job.rawInputPath = rawInputPath;
    if (attachments) job.attachments = attachments;
    if (result) job.result = result;
    if (outputFiles) job.outputFiles = outputFiles;
    if (editUrl) job.editUrl = editUrl;
    if (provider) job.provider = provider;
    if (model) job.model = model;
    if (usage) job.usage = usage;
    if (error) job.error = error;
    if (plan) job.plan = plan;
    if (queuedAt) job.queuedAt = queuedAt;
    if (startedAt) job.startedAt = startedAt;
    if (completedAt) job.completedAt = completedAt;
    if (lastHeartbeatAt) job.lastHeartbeatAt = lastHeartbeatAt;
    if (replyMode) job.replyMode = replyMode;

    return job;
  }

  private parseJson<T>(value: unknown): T | undefined {
    if (typeof value !== "string" || value.length === 0) {
      return undefined;
    }
    return JSON.parse(value) as T;
  }

  private toOptionalString(value: unknown) {
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }
}
