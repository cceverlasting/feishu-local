import type { ChatRouteConfig } from "../models/types.js";
import { ChatRouteConfigRepository } from "../storage/chat-route-config-repository.js";
import type { Logger } from "../utils/logger.js";
import { CommandRouter } from "./router.js";

export class ChatRouteService {
  constructor(
    private readonly repository: ChatRouteConfigRepository,
    private readonly router: CommandRouter,
    private readonly logger: Logger
  ) {}

  async initialize(seedRoutes: Record<string, ChatRouteConfig>) {
    await this.repository.initialize(seedRoutes);
    const routes = await this.repository.loadAll();
    this.router.setChatRoutes(routes);
    this.logger.info("chat_route_service.ready", {
      routeCount: Object.keys(routes).length
    });
  }

  listRoutes() {
    return this.router.getChatRoutes();
  }

  async upsertRoute(chatId: string, route: ChatRouteConfig) {
    const routes = await this.repository.upsert(chatId, route);
    this.router.setChatRoutes(routes);
    return routes;
  }

  async removeRoute(chatId: string) {
    const routes = await this.repository.remove(chatId);
    this.router.setChatRoutes(routes);
    return routes;
  }
}
