# acp-bridge-wechat

> **Hard fork notice:** This repository is a hard fork of [formulahendry/wechat-acp](https://github.com/formulahendry/wechat-acp)—a clean fork without commit history. We have decided to break away from upstream and evolve independently.

[![NPM Downloads](https://img.shields.io/npm/d18m/acp-bridge-wechat)](https://www.npmjs.com/package/acp-bridge-wechat)

Bridge WeChat direct messages to any ACP-compatible AI agent.

`acp-bridge-wechat` logs in with the WeChat iLink bot API, polls incoming 1:1 messages, forwards them to an ACP agent over stdio, and sends the agent reply back to WeChat.

<img src="./resources/screenshot.jpg" alt="acp-bridge-wechat screenshot" width="400" />

## Features

- WeChat QR login with terminal QR rendering
- One ACP agent session per WeChat user
- Built-in ACP agent presets for common CLIs
- Custom raw agent command support
- Auto-allow permission requests from the agent
- Direct message only; group chats are ignored
- Background daemon mode

## Requirements

- Node.js 20+
- A WeChat environment that can use the iLink bot API
- An ACP-compatible agent available locally or through `npx`

## Quick Start

Start with a built-in agent preset:

```bash
npx acp-bridge-wechat --agent copilot
```

Or use a raw custom command:

```bash
npx acp-bridge-wechat --agent "npx my-agent --acp"
```

On first run, the bridge will:

1. Start WeChat QR login
2. Render a QR code in the terminal
3. Save the login token under `~/.acp-bridge-wechat`
4. Begin polling direct messages

## Built-in Agent Presets

List the bundled presets:

```bash
npx acp-bridge-wechat agents
```

Current presets:

- `copilot`
- `claude`
- `gemini`
- `qwen`
- `codex`
- `opencode`

These presets resolve to concrete `command + args` pairs internally, so users do not need to type long `npx ...` commands.

## CLI Usage

```text
acp-bridge-wechat --agent <preset|command> [options]
acp-bridge-wechat agents
acp-bridge-wechat stop
acp-bridge-wechat status
```

Options:

- `--agent <value>`: built-in preset name or raw agent command
- `--cwd <dir>`: working directory for the agent process
- `--login`: force QR re-login and replace the saved token
- `--daemon`: run in background after startup
- `--config <file>`: load JSON config file
- `--instance <name>`: run as a named, isolated instance. See "Running multiple instances" below.
- `--idle-timeout <minutes>`: session idle timeout, default `1440` (use `0` for unlimited)
- `--max-sessions <count>`: maximum concurrent user sessions, default `10`
- `--hide-thoughts`: do not forward agent thinking to WeChat (default: forwarded)
- `-h, --help`: show help

Examples:

```bash
npx acp-bridge-wechat --agent copilot
npx acp-bridge-wechat --agent claude --cwd D:\code\project
npx acp-bridge-wechat --agent "npx @github/copilot --acp"
npx acp-bridge-wechat --agent gemini --daemon
```

## Running multiple instances

By default everything (saved login token, daemon pid/log, sync state) lives under `~/.acp-bridge-wechat/`, which means a single machine can only host one bridge at a time. Pass `--instance <name>` to namespace all of that under `~/.acp-bridge-wechat/instances/<name>/` and run several bridges side by side, each with its own WeChat account and project directory.

Typical setup: WeChat account 1 drives project A, WeChat account 2 drives project B.

```bash
# Terminal 1: scan with WeChat account 1
npx acp-bridge-wechat --instance projA --agent copilot --cwd D:\code\repo-a

# Terminal 2: scan with WeChat account 2
npx acp-bridge-wechat --instance projB --agent copilot --cwd D:\code\repo-b
```

The first run of each instance prints its own QR code. Tokens are saved per instance, so subsequent runs reuse them independently.

The `stop` and `status` subcommands also honor `--instance`:

```bash
npx acp-bridge-wechat status --instance projA
npx acp-bridge-wechat stop   --instance projB
```

Without `--instance`, paths fall back to `~/.acp-bridge-wechat/` exactly as before, so existing installs are unaffected.

## Configuration File

You can provide a JSON config file with `--config`.

Example:

```json
{
  "agent": {
    "preset": "copilot",
    "cwd": "D:/code/project"
  },
  "session": {
    "idleTimeoutMs": 86400000,
    "maxConcurrentUsers": 10
  }
}
```

You can also override or add agent presets:

```json
{
  "agent": {
    "preset": "my-agent"
  },
  "agents": {
    "my-agent": {
      "label": "My Agent",
      "description": "Internal team agent",
      "command": "npx",
      "args": ["my-agent-cli", "--acp"]
    }
  }
}
```

## Runtime Behavior

- Each WeChat user gets a dedicated ACP session and subprocess.
- Messages are processed serially per user.
- Replies are formatted for WeChat before sending.
- Typing indicators are sent when supported by the WeChat API.
- Sessions are cleaned up after inactivity (set `idleTimeoutMs` to `0` to disable idle cleanup).

## Storage

By default, runtime files are stored under:

```text
~/.acp-bridge-wechat
```

This directory is used for:

- saved login token
- daemon pid file
- daemon log file
- sync state

When `--instance <name>` is used, the same files live under `~/.acp-bridge-wechat/instances/<name>/` instead, fully isolated from other instances.

## Current Limitations

- Direct messages only; group chats are ignored
- MCP servers are not used
- Permission requests are auto-approved
- Agent communication is subprocess-only over stdio
- Some preset agents may require separate authentication before they can respond successfully

## Development

For local development:

```bash
npm install
npm run build
```

Run the built CLI locally:

```bash
node dist/bin/acp-bridge-wechat.js --help
```

Watch mode:

```bash
npm run dev
```

## License

MIT