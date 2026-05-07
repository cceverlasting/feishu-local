import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Logger } from "../utils/logger.js";

export function openDatabase(filePath: string, logger: Logger) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  db.pragma("journal_mode = WAL");

  logger.info("sqlite.open", { filePath });
  return db;
}
