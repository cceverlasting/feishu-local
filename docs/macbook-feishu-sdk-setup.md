# MacBook Pro Feishu SDK Setup

## Purpose

This note records the recommended setup for the second MacBook Pro that will run and develop the Feishu local bot for this project.

## What To Install

Install these tools on macOS:

```bash
# 1. Install Apple's local build tools
xcode-select --install

# 2. Install project dependencies
npm install

# 3. Install the official Feishu Node server SDK in this project
npm install @larksuiteoapi/node-sdk
```

Recommended versions and optional tools:

- `Node.js 24.x`
- `@larksuiteoapi/node-sdk`
- `Docker Desktop` for Gotenberg and PDF conversion
- `@larksuite/cli` for API debugging and auth troubleshooting

Optional CLI install:

```bash
npm install -g @larksuite/cli
```

Optional Gotenberg runtime:

```bash
docker run --rm -p 3000:3000 gotenberg/gotenberg:8
```

## Why This Stack

- This repository is a `Node.js + TypeScript` service, not a native iOS or macOS app.
- The project design uses the official Feishu Node SDK as the primary integration path.
- Event intake should use long connection mode for `im.message.receive_v1`.
- Long connection mode avoids public webhook URLs, domains, and tunnel tools during local development.

## Feishu Open Platform Setup

Configure the Feishu app in this order:

1. Create an `Enterprise Self-built App`.
2. Copy the `App ID` and `App Secret` from `Credentials & Basic Info`.
3. Enable the `Bot` capability.
4. In `Events & Callbacks`, choose long connection mode instead of public webhook callback mode.
5. Subscribe to `im.message.receive_v1`.
6. Apply the MVP permissions listed below.
7. Create a version and publish it so the capabilities and permissions actually take effect.

Recommended MVP permissions:

- Read direct messages sent to the bot
- Receive group messages that `@` the bot
- Send messages as the bot
- Reply to messages
- Download message resources such as images, audio, video, and files
- Upload images and files for generated outputs

## Local Environment Variables

Add these variables to the local environment when the Feishu adapter is implemented:

```env
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
FEISHU_EVENT_MODE=ws
FEISHU_ENABLED=true
FEISHU_MESSAGE_DOWNLOAD_DIR=./data/inbox
```

For this repository, create a local env file and start directly:

```bash
cp .env.example .env
# edit .env and set FEISHU_ENABLED=true + real FEISHU_APP_ID / FEISHU_APP_SECRET
npm run dev
```

## Notes

- Do not use a normal Feishu group webhook bot as the main entry for this project.
- Do not set global `HTTP_PROXY` or `HTTPS_PROXY` for the whole Node process because that may break the Feishu long connection.
- The official CLI is helpful, but it is not required to run this project.
