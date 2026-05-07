import { getAppContext } from "../bootstrap/app-context.js";

async function main() {
  const context = await getAppContext();
  context.jobRepository.initialize();

  const [command, ...rest] = process.argv.slice(2);

  if (command === "list") {
    const limitArg = rest[0];
    const limit = limitArg ? Number(limitArg) : 20;
    console.log(JSON.stringify(context.jobRepository.listRecent(limit), null, 2));
    return;
  }

  if (command === "get") {
    const jobId = rest[0];
    if (!jobId) {
      throw new Error("job id is required");
    }
    console.log(JSON.stringify(context.jobRepository.getById(jobId), null, 2));
    return;
  }

  if (command === "retry") {
    const jobId = rest[0];
    if (!jobId) {
      throw new Error("job id is required");
    }
    console.log(JSON.stringify(context.jobRepository.retry(jobId), null, 2));
    return;
  }

  throw new Error("unknown command. use: list | get <id> | retry <id>");
}

main().catch((error) => {
  console.error("[fatal] jobs cli failed", error);
  process.exitCode = 1;
});
