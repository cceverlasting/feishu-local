import type { NormalizedInput } from "../models/types.js";
import { createJobId } from "../utils/ids.js";

export interface DemoSubmitOptions {
  text?: string;
  type?: NormalizedInput["type"];
  chatId?: string;
  userId?: string;
  messageId?: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
  mentionsBot?: boolean;
}

export function normalizeDemoInput(options: DemoSubmitOptions): NormalizedInput {
  const type = options.type ?? "text";
  const text = options.text?.trim();
  const messageId = options.messageId ?? createJobId().replace(/^job_/, "msg_");
  const chatId = options.chatId ?? "chat-default";
  const userId = options.userId ?? "user-local";

  if (type === "text") {
    const command = extractCommand(text);
    const urls = extractUrls(text);
    const normalized: NormalizedInput = {
      source: "feishu",
      type: "text",
      text: text ?? "",
      hasUrl: urls.length > 0,
      userId,
      chatId,
      messageId,
      mentionsBot: options.mentionsBot ?? false
    };
    if (command) {
      normalized.command = command;
    }
    if (urls.length > 0) {
      normalized.urls = urls;
    }
    return normalized;
  }

  const normalized: NormalizedInput = {
    source: "feishu",
    type,
    userId,
    chatId,
    messageId,
    localPath: options.localPath ?? "",
    mentionsBot: options.mentionsBot ?? false
  };

  if (text) {
    normalized.text = text;
    const command = extractCommand(text);
    const hasUrl = extractUrls(text).length > 0;
    if (command) {
      normalized.command = command;
    }
    if (hasUrl) {
      normalized.hasUrl = true;
    }
  }
  if (options.fileName) {
    normalized.fileName = options.fileName;
  }
  if (options.mimeType) {
    normalized.mimeType = options.mimeType;
  }
  return normalized;
}

function extractCommand(text: string | undefined) {
  if (!text) {
    return undefined;
  }
  const match = text.match(/^\/\S+/);
  return match?.[0];
}

function extractUrls(text: string | undefined) {
  if (!text) {
    return [];
  }
  return [...text.matchAll(/https?:\/\/\S+/g)].map((match) => match[0]);
}
