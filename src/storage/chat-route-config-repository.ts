import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatRouteConfig } from "../models/types.js";
import { normalizeChatRouteConfig } from "../utils/task-mode.js";
import type { Logger } from "../utils/logger.js";

export class ChatRouteConfigRepository {
  constructor(
    private readonly filePath: string,
    private readonly logger: Logger
  ) {}

  async initialize(seedRoutes: Record<string, ChatRouteConfig>) {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await readFile(this.filePath, "utf8");
    } catch {
      await this.saveAll(seedRoutes);
      this.logger.info("chat_route_config.initialize", {
        filePath: this.filePath,
        routeCount: Object.keys(seedRoutes).length
      });
    }
  }

  async loadAll() {
    try {
      const content = await readFile(this.filePath, "utf8");
      return normalizeRouteMap(JSON.parse(content) as Record<string, ChatRouteConfig>);
    } catch (error) {
      this.logger.warn("chat_route_config.load_failed", {
        filePath: this.filePath,
        error: error instanceof Error ? error.message : String(error)
      });
      return {};
    }
  }

  async saveAll(routes: Record<string, ChatRouteConfig>) {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(routes, null, 2), "utf8");
  }

  async upsert(chatId: string, route: ChatRouteConfig) {
    const routes = await this.loadAll();
    routes[chatId] = route;
    await this.saveAll(routes);
    return routes;
  }

  async remove(chatId: string) {
    const routes = await this.loadAll();
    delete routes[chatId];
    await this.saveAll(routes);
    return routes;
  }
}

function normalizeRouteMap(routes: Record<string, ChatRouteConfig>) {
  return Object.fromEntries(
    Object.entries(routes).map(([chatId, route]) => [chatId, normalizeChatRouteConfig(route)])
  ) as Record<string, ChatRouteConfig>;
}
