import * as lark from "@larksuiteoapi/node-sdk";
import type { Env } from "../../config/env.js";
import type { Logger } from "../../utils/logger.js";

export function isFeishuConfigured(env: Env) {
  return Boolean(env.FEISHU_ENABLED && env.FEISHU_APP_ID && env.FEISHU_APP_SECRET);
}

export function createFeishuClient(env: Env, logger: Logger) {
  return new lark.Client({
    appId: env.FEISHU_APP_ID ?? "",
    appSecret: env.FEISHU_APP_SECRET ?? "",
    appType: lark.AppType.SelfBuild,
    domain: env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: toLarkLoggerLevel(env.LOG_LEVEL),
    logger: {
      info(...args: unknown[]) {
        logger.info("feishu_sdk.info", { message: args.map(String).join(" ") });
      },
      warn(...args: unknown[]) {
        logger.warn("feishu_sdk.warn", { message: args.map(String).join(" ") });
      },
      error(...args: unknown[]) {
        logger.error("feishu_sdk.error", { message: args.map(String).join(" ") });
      },
      debug(...args: unknown[]) {
        logger.debug("feishu_sdk.debug", { message: args.map(String).join(" ") });
      },
      trace(...args: unknown[]) {
        logger.debug("feishu_sdk.trace", { message: args.map(String).join(" ") });
      }
    }
  });
}

export function createFeishuWsClient(env: Env, logger: Logger) {
  return new lark.WSClient({
    appId: env.FEISHU_APP_ID ?? "",
    appSecret: env.FEISHU_APP_SECRET ?? "",
    domain: env.FEISHU_DOMAIN === "lark" ? lark.Domain.Lark : lark.Domain.Feishu,
    loggerLevel: toLarkLoggerLevel(env.LOG_LEVEL),
    logger: {
      info(...args: unknown[]) {
        logger.info("feishu_ws.info", { message: args.map(String).join(" ") });
      },
      warn(...args: unknown[]) {
        logger.warn("feishu_ws.warn", { message: args.map(String).join(" ") });
      },
      error(...args: unknown[]) {
        logger.error("feishu_ws.error", { message: args.map(String).join(" ") });
      },
      debug(...args: unknown[]) {
        logger.debug("feishu_ws.debug", { message: args.map(String).join(" ") });
      },
      trace(...args: unknown[]) {
        logger.debug("feishu_ws.trace", { message: args.map(String).join(" ") });
      }
    }
  });
}

function toLarkLoggerLevel(level: Env["LOG_LEVEL"]) {
  if (level === "debug") return lark.LoggerLevel.debug;
  if (level === "warn") return lark.LoggerLevel.warn;
  if (level === "error") return lark.LoggerLevel.error;
  return lark.LoggerLevel.info;
}
