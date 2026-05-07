import path from "node:path";
import "dotenv/config";
import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.string().trim().toLowerCase()])
  .transform((value) => {
    if (typeof value === "boolean") {
      return value;
    }
    return value === "true" || value === "1" || value === "yes" || value === "on";
  });

const envSchema = z.object({
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SQLITE_PATH: z.string().trim().min(1).default("./data/app.db"),
  CHAT_ROUTE_CONFIG_PATH: z.string().trim().min(1).default("./data/chat-routes.json"),
  QUEUE_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().positive().default(2),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(20_000),
  ADMIN_SERVER_PORT: z.coerce.number().int().nonnegative().default(3310),
  WEB_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  RESEARCH_PRIMARY_PROVIDER: z
    .enum(["openai-compatible", "ollama", "none"])
    .default("openai-compatible"),
  RESEARCH_FALLBACK_PROVIDER: z
    .enum(["openai-compatible", "ollama", "none"])
    .optional(),
  AI_BASE_URL: z.string().trim().url().optional(),
  AI_API_KEY: z.string().trim().optional(),
  AI_MODEL: z.string().trim().optional(),
  OLLAMA_BASE_URL: z.string().trim().url().optional(),
  OLLAMA_MODEL: z.string().trim().optional(),
  AI_USER_PROMPT_MAX_CHARS: z.coerce.number().int().positive().default(4_000),
  AI_SOURCE_TEXT_MAX_CHARS: z.coerce.number().int().positive().default(10_000),
  RESEARCH_SEARCH_ENABLED: booleanish.default(false),
  RESEARCH_SEARCH_MAX_QUERIES: z.coerce.number().int().positive().default(3),
  RESEARCH_SEARCH_RESULTS_PER_QUERY: z.coerce.number().int().positive().default(3),
  RESEARCH_SEARCH_MAX_RESULTS: z.coerce.number().int().positive().default(6),
  SEARCH_API_URL: z.string().trim().url().optional(),
  SEARCH_API_KEY: z.string().trim().optional(),
  SEARCH_API_AUTH_HEADER: z.string().trim().default("authorization"),
  GOOGLE_SEARCH_API_KEY: z.string().trim().optional(),
  GOOGLE_SEARCH_CX: z.string().trim().optional(),
  WEIXIN_SEARCH_ENABLED: booleanish.default(false),
  WEIXIN_SEARCH_MAX_PAGES: z.coerce.number().int().positive().default(2),
  WEIXIN_SEARCH_API_URL: z.string().trim().url().optional(),
  WEIXIN_SEARCH_API_KEY: z.string().trim().optional(),
  WEIXIN_SEARCH_API_AUTH_HEADER: z.string().trim().default("authorization"),
  DEMO_BASE_URL: z.string().trim().url().optional(),
  GOTENBERG_URL: z.string().trim().url().optional(),
  WEB_UI_BASE_URL: z.string().trim().url().optional(),
  WEB_API_TOKEN: z.string().trim().optional(),
  CHAT_ROUTING_JSON: z.string().trim().optional(),
  FEISHU_ENABLED: booleanish.default(false),
  FEISHU_APP_ID: z.string().trim().optional(),
  FEISHU_APP_SECRET: z.string().trim().optional(),
  FEISHU_DOMAIN: z.enum(["feishu", "lark"]).default("feishu"),
  FEISHU_MESSAGE_DOWNLOAD_DIR: z.string().trim().min(1).default("./data/inbox")
});

const parsed = envSchema.parse(process.env);

export const env = {
  ...parsed,
  SQLITE_PATH: path.resolve(parsed.SQLITE_PATH),
  CHAT_ROUTE_CONFIG_PATH: path.resolve(parsed.CHAT_ROUTE_CONFIG_PATH),
  FEISHU_MESSAGE_DOWNLOAD_DIR: path.resolve(parsed.FEISHU_MESSAGE_DOWNLOAD_DIR)
};

export type Env = typeof env;
