import { getAppContext } from "./bootstrap/app-context.js";

async function main() {
  const context = await getAppContext();

  context.logger.info("app.start", {
    sqlitePath: context.env.SQLITE_PATH,
    queuePollIntervalMs: context.env.QUEUE_POLL_INTERVAL_MS,
    configuredChatRoutes: Object.keys(context.router.getChatRoutes()).length,
    adminServerPort: context.env.ADMIN_SERVER_PORT
  });

  context.jobRepository.initialize();
  await context.jobManager.recoverPendingJobs();
  context.demoClient.logConfiguration();
  context.researchClient.logConfiguration();
  context.ocrClient.logConfiguration();
  context.webUiClient.logConfiguration();

  context.queue.start();
  context.reviewPoller.start();
  context.adminServer.start();
}

main().catch((error) => {
  console.error("[fatal] failed to start application", error);
  process.exitCode = 1;
});
