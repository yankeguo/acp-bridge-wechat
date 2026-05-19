/**
 * Bridge-owned slash commands (prefix `//` to distinguish from agent `/` commands).
 */

import type { ChangeDirectoryResult } from "./acp/session.js";

export type StopInteractionResult = "no_session" | "idle" | "stopped";

export type BridgeCommandDeps = {
  stopInteraction: (userId: string) => Promise<StopInteractionResult>;
  changeDirectory: (userId: string, rawPath: string) => Promise<ChangeDirectoryResult>;
};

export type BridgeCommandHandleResult =
  | { handled: true; reply: string }
  | { handled: false };

function parseCommandLine(text: string): { command: string; args: string } {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { command: trimmed.toLowerCase(), args: "" };
  }
  return {
    command: trimmed.slice(0, spaceIdx).toLowerCase(),
    args: trimmed.slice(spaceIdx + 1).trim(),
  };
}

function replyForStop(outcome: StopInteractionResult): string {
  switch (outcome) {
    case "no_session":
      return "当前没有进行中的 agent 会话。";
    case "idle":
      return "已停止等待中的消息（当前无进行中的回复）。";
    case "stopped":
      return "已停止当前 agent 回复。";
  }
}

function replyForCd(result: ChangeDirectoryResult): string {
  if (!result.ok) {
    return result.error;
  }
  const restarted = result.hadSession
    ? "已结束当前 agent 进程，下一条消息将在新目录中启动。"
    : "下一条消息将在新目录中启动 agent。";
  return `工作目录已切换为:\n${result.path}\n\n${restarted}`;
}

/**
 * Returns true when the message should be handled as a bridge command (`//...`).
 */
export function isBridgeCommandMessage(text: string): boolean {
  return text.trim().startsWith("//");
}

/**
 * Handle a bridge command. All `//` messages are consumed here and not forwarded to ACP.
 */
export async function handleBridgeCommand(
  text: string,
  userId: string,
  deps: BridgeCommandDeps,
): Promise<BridgeCommandHandleResult> {
  const { command, args } = parseCommandLine(text);

  switch (command) {
    case "//stop": {
      const outcome = await deps.stopInteraction(userId);
      return { handled: true, reply: replyForStop(outcome) };
    }
    case "//cd": {
      if (!args) {
        return { handled: true, reply: "用法: //cd <目录>\n例如: //cd /path/to/project 或 //cd ../other-repo" };
      }
      const result = await deps.changeDirectory(userId, args);
      return { handled: true, reply: replyForCd(result) };
    }
    default:
      return {
        handled: true,
        reply: `未知 bridge 命令: ${command}\n当前支持: //stop, //cd`,
      };
  }
}
