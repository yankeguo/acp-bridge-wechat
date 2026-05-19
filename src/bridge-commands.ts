/**
 * Bridge-owned slash commands (prefix `//` to distinguish from agent `/` commands).
 */

export type StopInteractionResult = "no_session" | "idle" | "stopped";

export type BridgeCommandDeps = {
  stopInteraction: (userId: string) => Promise<StopInteractionResult>;
};

export type BridgeCommandHandleResult =
  | { handled: true; reply: string }
  | { handled: false };

function parseCommand(text: string): string {
  const trimmed = text.trim();
  const spaceIdx = trimmed.indexOf(" ");
  const head = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  return head.toLowerCase();
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
  const command = parseCommand(text);

  switch (command) {
    case "//stop": {
      const outcome = await deps.stopInteraction(userId);
      return { handled: true, reply: replyForStop(outcome) };
    }
    default:
      return {
        handled: true,
        reply: `未知 bridge 命令: ${command}\n当前支持: //stop`,
      };
  }
}
