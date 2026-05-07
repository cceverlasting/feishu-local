import { getAppContext } from "../bootstrap/app-context.js";
import { normalizeDemoInput } from "../orchestrator/input-normalizer.js";

function parseArgs(argv: string[]) {
  const pairs = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if (!current || !current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      pairs.set(key, "true");
      continue;
    }

    pairs.set(key, value);
    index += 1;
  }

  return pairs;
}

async function main() {
  const context = await getAppContext();
  context.jobRepository.initialize();

  const args = parseArgs(process.argv.slice(2));
  const inputOptions: Parameters<typeof normalizeDemoInput>[0] = {
    type: (args.get("type") as "text" | "image" | "audio" | "file" | "video" | undefined) ?? "text",
    mentionsBot: args.get("mentions-bot") === "true"
  };
  const text = args.get("text");
  const chatId = args.get("chat-id");
  const userId = args.get("user-id");
  const messageId = args.get("message-id");
  const fileName = args.get("file-name");
  const mimeType = args.get("mime-type");
  const localPath = args.get("local-path");
  if (text) inputOptions.text = text;
  if (chatId) inputOptions.chatId = chatId;
  if (userId) inputOptions.userId = userId;
  if (messageId) inputOptions.messageId = messageId;
  if (fileName) inputOptions.fileName = fileName;
  if (mimeType) inputOptions.mimeType = mimeType;
  if (localPath) inputOptions.localPath = localPath;

  const input = normalizeDemoInput(inputOptions);

  const submitted = context.intakeService.submit(input);

  console.log(
    JSON.stringify(
      {
        jobId: submitted.job.id,
        mode: submitted.job.mode,
        type: submitted.job.type,
        status: submitted.job.status,
        chatId: submitted.job.chatId
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error("[fatal] failed to submit demo job", error);
  process.exitCode = 1;
});
