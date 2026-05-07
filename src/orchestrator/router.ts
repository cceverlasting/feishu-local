import type { Env } from "../config/env.js";
import type { ChatRouteConfig, JobType, NormalizedInput, TaskMode, TaskPlan } from "../models/types.js";
import { normalizeChatRouteConfig } from "../utils/task-mode.js";
import type { Logger } from "../utils/logger.js";

const commandRouteMap: Record<string, Omit<ChatRouteConfig, "jobType"> & { jobType: JobType }> = {
  "/读": { mode: "article_precheck", jobType: "article", replyMode: "post" },
  "/深读": { mode: "article_research", jobType: "article", replyMode: "post" },
  "/研究": { mode: "article_research", jobType: "article", replyMode: "post" },
  "/查证": { mode: "article_verify", jobType: "article", replyMode: "post" },
  "/合同": { mode: "contract_draft", jobType: "contract", replyMode: "mixed" },
  "/审合同": { mode: "contract_review", jobType: "contract", replyMode: "mixed" },
  "/总结": { mode: "summarize", jobType: "general", replyMode: "text" }
};

const typeRouteMap: Record<NormalizedInput["type"], ChatRouteConfig & { jobType: JobType }> = {
  text: { mode: "general_chat", jobType: "general", replyMode: "text" },
  image: { mode: "image_understanding", jobType: "image", replyMode: "mixed" },
  audio: { mode: "speech_to_text", jobType: "audio", replyMode: "text" },
  file: { mode: "file_processing", jobType: "file", replyMode: "mixed" },
  video: { mode: "file_processing", jobType: "file", replyMode: "mixed" }
};

export class CommandRouter {
  private readonly logger: Logger;
  private chatRoutes: Record<string, ChatRouteConfig>;

  constructor(env: Env, logger: Logger, initialChatRoutes?: Record<string, ChatRouteConfig>) {
    this.logger = logger;
    this.chatRoutes = {
      ...parseChatRoutes(env.CHAT_ROUTING_JSON, logger),
      ...(initialChatRoutes ?? {})
    };
  }

  route(input: NormalizedInput): TaskPlan {
    const command = input.command?.trim();

    if (command && commandRouteMap[command]) {
      const selected = commandRouteMap[command];
      const plan: TaskPlan = {
        jobType: selected.jobType,
        mode: selected.mode,
        requiresAsync: true,
        replyMode: selected.replyMode ?? "text",
        input
      };
      if (selected.providerHint) {
        plan.providerHint = selected.providerHint;
      }
      if (selected.promptProfile) {
        plan.promptProfile = selected.promptProfile;
      }
      return plan;
    }

    const chatRoute = this.chatRoutes[input.chatId];
    if (chatRoute) {
      const plan: TaskPlan = {
        jobType: chatRoute.jobType ?? inferJobTypeFromMode(chatRoute.mode),
        mode: chatRoute.mode,
        requiresAsync: true,
        replyMode: chatRoute.replyMode ?? "text",
        input
      };
      if (chatRoute.providerHint) {
        plan.providerHint = chatRoute.providerHint;
      }
      if (chatRoute.promptProfile) {
        plan.promptProfile = chatRoute.promptProfile;
      }
      return plan;
    }

    if (input.type === "text" && input.hasUrl) {
      return {
        jobType: "article",
        mode: "article_precheck",
        requiresAsync: true,
        replyMode: "post",
        input
      };
    }

    const fallback = typeRouteMap[input.type];
    return {
      jobType: fallback.jobType,
      mode: fallback.mode,
      requiresAsync: true,
      replyMode: fallback.replyMode ?? "text",
      input
    };
  }

  getChatRoutes() {
    return this.chatRoutes;
  }

  setChatRoutes(routes: Record<string, ChatRouteConfig>) {
    this.chatRoutes = { ...routes };
  }

  upsertChatRoute(chatId: string, route: ChatRouteConfig) {
    this.chatRoutes = {
      ...this.chatRoutes,
      [chatId]: route
    };
  }

  removeChatRoute(chatId: string) {
    const nextRoutes = { ...this.chatRoutes };
    delete nextRoutes[chatId];
    this.chatRoutes = nextRoutes;
  }
}

function parseChatRoutes(rawValue: string | undefined, logger: Logger): Record<string, ChatRouteConfig> {
  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, ChatRouteConfig>;
    return Object.fromEntries(
      Object.entries(parsed).map(([chatId, route]) => [chatId, normalizeChatRouteConfig(route)])
    ) as Record<string, ChatRouteConfig>;
  } catch (error) {
    logger.warn("router.chat_routes.invalid", {
      error: error instanceof Error ? error.message : String(error)
    });
    return {};
  }
}

function inferJobTypeFromMode(mode: TaskMode): JobType {
  if (mode.startsWith("article_")) {
    return "article";
  }
  if (mode.startsWith("contract_")) {
    return "contract";
  }
  if (mode === "speech_to_text") {
    return "audio";
  }
  if (mode === "image_understanding") {
    return "image";
  }
  if (mode === "file_processing") {
    return "file";
  }
  if (mode === "email_draft") {
    return "email";
  }
  return "general";
}
