import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as lark from "@larksuiteoapi/node-sdk";
import type { Env } from "../../config/env.js";
import type { IntakeService } from "../../orchestrator/intake.js";
import { normalizeDemoInput } from "../../orchestrator/input-normalizer.js";
import { CommandRouter } from "../../orchestrator/router.js";
import type { Logger } from "../../utils/logger.js";
import { createFeishuClient, createFeishuWsClient, isFeishuConfigured } from "./client.js";

interface FeishuBotAdapterOptions {
  env: Env;
  logger: Logger;
  intakeService: IntakeService;
  router: CommandRouter;
}

export class FeishuBotAdapter {
  private readonly env: Env;
  private readonly logger: Logger;
  private readonly intakeService: IntakeService;
  private readonly router: CommandRouter;
  private readonly client;
  private readonly wsClient;
  private readonly recentUrls = new Map<string, { urls: string[]; updatedAt: number }>();
  private readonly pendingTextIntents = new Map<
    string,
    { event: FeishuMessageEvent; text: string; timer: NodeJS.Timeout; createdAt: number }
  >();
  private started = false;

  constructor(options: FeishuBotAdapterOptions) {
    this.env = options.env;
    this.logger = options.logger;
    this.intakeService = options.intakeService;
    this.router = options.router;
    this.client = createFeishuClient(this.env, this.logger);
    this.wsClient = createFeishuWsClient(this.env, this.logger);
  }

  isConfigured() {
    return isFeishuConfigured(this.env);
  }

  start() {
    if (this.started || !this.isConfigured()) {
      this.logger.info("feishu_bot.skip", {
        started: this.started,
        configured: this.isConfigured(),
        enabled: this.env.FEISHU_ENABLED
      });
      return;
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        await this.handleMessageEvent(data as FeishuMessageEvent);
      }
    });

    this.wsClient.start({ eventDispatcher: dispatcher });
    this.started = true;
    this.logger.info("feishu_bot.start", {
      domain: this.env.FEISHU_DOMAIN,
      mode: "ws"
    });
  }

  private async handleMessageEvent(event: FeishuMessageEvent) {
    const message = event.message;
    if (!message) {
      return;
    }
    this.captureRecentUrls(event);
    this.resolvePendingIntentIfUrlArrived(event);

    if (message.message_type === "post") {
      return;
    }

    if (message.chat_type === "group" && !event.message?.mentions?.length) {
      return;
    }

    if (
      message.message_type === "text" &&
      this.shouldDelayForSiblingUrl(event, parseTextContent(message.content))
    ) {
      this.schedulePendingIntent(event);
      return;
    }

    await this.submitEvent(event);
  }

  private async submitEvent(event: FeishuMessageEvent, overrideText?: string) {
    const input = await this.toNormalizedInput(event, overrideText);
    const submitted = this.intakeService.submit(input);
    const message = event.message;
    if (!message) {
      return;
    }
    this.logger.info("feishu_bot.intake_submitted", {
      messageId: message.message_id,
      chatId: message.chat_id,
      messageType: message.message_type,
      jobId: submitted.job.id,
      mode: submitted.job.mode
    });
  }

  private async toNormalizedInput(event: FeishuMessageEvent, overrideText?: string) {
    const message = event.message;
    if (!message) {
      return normalizeDemoInput({
        type: "text",
        text: "",
        messageId: "msg-empty",
        chatId: "chat-empty",
        userId: "user-empty"
      });
    }
    const senderId = event.sender?.sender_id?.open_id ?? "user-feishu";

    if (message.message_type === "text") {
      const baseText = overrideText ?? parseTextContent(message.content);
      const text = this.enrichTextWithRecentUrls(event, baseText);
      return normalizeDemoInput({
        type: "text",
        text,
        messageId: message.message_id,
        chatId: message.chat_id,
        userId: senderId,
        mentionsBot: Array.isArray(message.mentions) && message.mentions.length > 0
      });
    }

    const localPath = await this.downloadMessageResource(message);
    const messageType = toInputType(message.message_type);
    return normalizeDemoInput({
      type: messageType,
      text: parseTextContent(message.content),
      messageId: message.message_id,
      chatId: message.chat_id,
      userId: senderId,
      localPath,
      fileName: inferFileName(message, messageType),
      mentionsBot: Array.isArray(message.mentions) && message.mentions.length > 0
    });
  }

  private shouldDelayForSiblingUrl(event: FeishuMessageEvent, text: string) {
    const message = event.message;
    if (!message) {
      return false;
    }

    if (extractUrlsFromRawContent(text).length > 0) {
      return false;
    }

    const normalized = normalizeDemoInput({
      type: "text",
      text,
      messageId: message.message_id,
      chatId: message.chat_id,
      userId: event.sender?.sender_id?.open_id ?? "user-feishu",
      mentionsBot: Array.isArray(message.mentions) && message.mentions.length > 0
    });
    const route = this.router.route(normalized);
    return route.mode === "article_research";
  }

  private schedulePendingIntent(event: FeishuMessageEvent) {
    const message = event.message;
    if (!message) {
      return;
    }
    const senderId = event.sender?.sender_id?.open_id ?? "user-feishu";
    const key = buildRecentUrlKey(message.chat_id, senderId);
    const current = this.pendingTextIntents.get(key);
    if (current) {
      clearTimeout(current.timer);
      this.pendingTextIntents.delete(key);
    }

    const text = parseTextContent(message.content);
    const timer = setTimeout(() => {
      const pending = this.pendingTextIntents.get(key);
      if (!pending) {
        return;
      }
      this.pendingTextIntents.delete(key);
      void this.submitEvent(pending.event, pending.text);
    }, 30_000);

    this.pendingTextIntents.set(key, {
      event,
      text,
      timer,
      createdAt: Date.now()
    });
  }

  private resolvePendingIntentIfUrlArrived(event: FeishuMessageEvent) {
    const message = event.message;
    if (!message) {
      return;
    }
    const senderId = event.sender?.sender_id?.open_id ?? "user-feishu";
    const key = buildRecentUrlKey(message.chat_id, senderId);
    const pending = this.pendingTextIntents.get(key);
    if (!pending) {
      return;
    }

    const urls = extractUrlsFromRawContent(message.content);
    if (urls.length === 0) {
      return;
    }

    clearTimeout(pending.timer);
    this.pendingTextIntents.delete(key);
    const mergedText = `${pending.text}\n${urls.join("\n")}`.trim();
    void this.submitEvent(pending.event, mergedText);
  }

  private async downloadMessageResource(message: FeishuMessage) {
    const payload = parseResourcePayload(message.content);
    if (!payload?.file_key) {
      return "";
    }

    await mkdir(this.env.FEISHU_MESSAGE_DOWNLOAD_DIR, { recursive: true });
    const extension = inferExtension(message.message_type);
    const filePath = path.join(
      this.env.FEISHU_MESSAGE_DOWNLOAD_DIR,
      `${message.message_id}${extension}`
    );

    const streamResult = await this.client.im.v1.messageResource.get({
      path: {
        message_id: message.message_id,
        file_key: payload.file_key
      },
      params: {
        type: message.message_type
      }
    });
    await streamResult.writeFile(filePath);
    return filePath;
  }

  private captureRecentUrls(event: FeishuMessageEvent) {
    const message = event.message;
    if (!message) {
      return;
    }

    const senderId = event.sender?.sender_id?.open_id ?? "user-feishu";
    const urls = extractUrlsFromRawContent(message.content);
    if (urls.length === 0) {
      return;
    }

    this.recentUrls.set(buildRecentUrlKey(message.chat_id, senderId), {
      urls,
      updatedAt: Date.now()
    });
    this.cleanupRecentUrls();
  }

  private enrichTextWithRecentUrls(event: FeishuMessageEvent, text: string) {
    const message = event.message;
    if (!message) {
      return text;
    }

    const currentUrls = extractUrlsFromRawContent(text);
    if (currentUrls.length > 0) {
      return text;
    }

    const senderId = event.sender?.sender_id?.open_id ?? "user-feishu";
    const cached = this.recentUrls.get(buildRecentUrlKey(message.chat_id, senderId));
    if (!cached || Date.now() - cached.updatedAt > 120_000 || cached.urls.length === 0) {
      return text;
    }

    return `${text}\n${cached.urls.join("\n")}`.trim();
  }

  private cleanupRecentUrls() {
    const now = Date.now();
    for (const [key, value] of this.recentUrls.entries()) {
      if (now - value.updatedAt > 120_000) {
        this.recentUrls.delete(key);
      }
    }
  }
}

type FeishuMessageEvent = {
  message?: FeishuMessage;
  sender?: {
    sender_id?: {
      open_id?: string;
    };
  };
};

type FeishuMessage = {
  chat_id: string;
  chat_type?: "p2p" | "group";
  message_id: string;
  message_type: "text" | "image" | "audio" | "file" | "media" | "post";
  content: string;
  mentions?: unknown[];
};

function toInputType(messageType: FeishuMessage["message_type"]): "image" | "audio" | "file" | "video" {
  if (messageType === "image") return "image";
  if (messageType === "audio") return "audio";
  if (messageType === "media") return "video";
  return "file";
}

function parseTextContent(raw: string) {
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    return parsed.text?.trim() ?? "";
  } catch {
    return "";
  }
}

function parseResourcePayload(raw: string) {
  try {
    return JSON.parse(raw) as { file_key?: string; image_key?: string };
  } catch {
    return {};
  }
}

function extractUrlsFromRawContent(raw: string) {
  const urls = new Set<string>();
  for (const match of raw.matchAll(/https?:\/\/[^\s"'<>()]+/g)) {
    urls.add(match[0]);
  }
  for (const match of raw.matchAll(/https?:\\\/\\\/[^\\\s"'<>()]+/g)) {
    urls.add(match[0].replace(/\\\//g, "/"));
  }
  return [...urls];
}

function buildRecentUrlKey(chatId: string, senderId: string) {
  return `${chatId}:${senderId}`;
}

function inferFileName(message: FeishuMessage, inputType: "image" | "audio" | "file" | "video") {
  const extension = inferExtension(message.message_type);
  return `${message.message_id}-${inputType}${extension}`;
}

function inferExtension(messageType: FeishuMessage["message_type"]) {
  if (messageType === "image") return ".jpg";
  if (messageType === "audio") return ".m4a";
  if (messageType === "media") return ".mp4";
  return ".bin";
}
