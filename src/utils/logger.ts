import type { LogEvent, LogLevel } from "../models/types.js";

const rank: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

export interface Logger {
  debug(event: string, data?: Record<string, unknown>): void;
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}

export function createLogger(level: LogLevel): Logger {
  function shouldLog(entryLevel: LogLevel) {
    return rank[entryLevel] >= rank[level];
  }

  function write(entryLevel: LogLevel, event: string, data?: Record<string, unknown>) {
    if (!shouldLog(entryLevel)) {
      return;
    }

    const payload: LogEvent = {
      event,
      level: entryLevel,
      timestamp: new Date().toISOString()
    };
    if (data) {
      payload.data = data;
    }

    const line = JSON.stringify(payload);
    if (entryLevel === "error") {
      console.error(line);
      return;
    }

    if (entryLevel === "warn") {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    debug(event, data) {
      write("debug", event, data);
    },
    info(event, data) {
      write("info", event, data);
    },
    warn(event, data) {
      write("warn", event, data);
    },
    error(event, data) {
      write("error", event, data);
    }
  };
}
