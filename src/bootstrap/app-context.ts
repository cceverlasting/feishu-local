import { AdminServer } from "../admin/admin-server.js";
import { env } from "../config/env.js";
import { DemoClient } from "../modules/contract/demo-client.js";
import { ResearchClient } from "../modules/research/ai-client.js";
import { ResearchSearchClient } from "../modules/research/search-client.js";
import { OcrClient } from "../modules/vision/ocr-client.js";
import { WebUiClient } from "../modules/web-ui/client.js";
import { ChatRouteService } from "../orchestrator/chat-route-service.js";
import { IntakeService } from "../orchestrator/intake.js";
import { JobManager } from "../orchestrator/job-manager.js";
import { JobQueue } from "../orchestrator/queue.js";
import { ReviewPoller } from "../orchestrator/review-poller.js";
import { CommandRouter } from "../orchestrator/router.js";
import { FeishuResultPublisher } from "../publishers/feishu-result-publisher.js";
import { ChatRouteConfigRepository } from "../storage/chat-route-config-repository.js";
import { createLogger } from "../utils/logger.js";
import { JobRepository } from "../storage/job-repository.js";
import { FeishuBotAdapter } from "../adapters/feishu/bot-adapter.js";

export async function getAppContext() {
  const logger = createLogger(env.LOG_LEVEL);
  const jobRepository = new JobRepository(env.SQLITE_PATH, logger);
  const demoClient = new DemoClient(env, logger);
  const ocrClient = new OcrClient(env, logger);
  const researchSearchClient = new ResearchSearchClient(env, logger);
  const researchClient = new ResearchClient(env, logger, ocrClient, researchSearchClient);
  const webUiClient = new WebUiClient(env, logger);
  const routeConfigRepository = new ChatRouteConfigRepository(env.CHAT_ROUTE_CONFIG_PATH, logger);
  const router = new CommandRouter(env, logger);
  const chatRouteService = new ChatRouteService(routeConfigRepository, router, logger);
  await chatRouteService.initialize(router.getChatRoutes());
  const resultPublisher = new FeishuResultPublisher(env, logger);
  const jobManager = new JobManager({
    env,
    logger,
    jobRepository,
    demoClient,
    researchClient,
    ocrClient,
    resultPublisher
  });
  const queue = new JobQueue({
    env,
    logger,
    jobRepository,
    jobManager
  });
  const intakeService = new IntakeService({
    env,
    logger,
    jobRepository,
    router
  });
  const reviewPoller = new ReviewPoller({
    env,
    logger,
    jobRepository,
    webUiClient
  });
  const feishuBot = new FeishuBotAdapter({
    env,
    logger,
    intakeService,
    router
  });
  const adminServer = new AdminServer({
    env,
    logger,
    chatRouteService,
    jobRepository
  });

  return {
    env,
    logger,
    jobRepository,
    demoClient,
    researchClient,
    researchSearchClient,
    ocrClient,
    webUiClient,
    router,
    chatRouteService,
    intakeService,
    jobManager,
    queue,
    reviewPoller,
    feishuBot,
    adminServer
  };
}
