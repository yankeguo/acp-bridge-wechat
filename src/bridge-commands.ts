/**
 * Bridge-owned slash commands (prefix `//` to distinguish from agent `/` commands).
 */

import type { ChangeDirectoryResult } from "./acp/session.js";
import type { CronAddResult, CronDeleteResult, CronJob } from "./scheduler/cron.js";

export type StopInteractionResult = "no_session" | "idle" | "stopped";

export type SendFileResult =
  | { ok: true; path: string; fileName: string }
  | { ok: false; error: string };

export type BridgeCommandDeps = {
  stopInteraction: (userId: string) => Promise<StopInteractionResult>;
  changeDirectory: (userId: string, rawPath: string) => Promise<ChangeDirectoryResult>;
  printWorkingDirectory: (userId: string) => string;
  sendFile: (userId: string, contextToken: string, rawPath: string) => Promise<SendFileResult>;
  addCron: (userId: string, expression: string, prompt: string) => CronAddResult;
  deleteCron: (userId: string, id: number) => CronDeleteResult;
  listCrons: (userId: string) => CronJob[];
  cronNextRun: (job: CronJob) => Date | null;
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

type ParsedCronArgs =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "del"; id: number }
  | { kind: "add"; expression: string; prompt: string }
  | { kind: "error"; message: string };

/**
 * Parse the args blob following `//cron`.
 *
 * Subcommand is the first whitespace-delimited token. Space handling:
 *  - `add` requires the cron expression to be quoted (single or double quotes),
 *    because standard 5-field cron expressions contain spaces. The remainder
 *    after the closing quote is taken verbatim as the prompt (may contain spaces).
 *  - `del` takes a single numeric id token.
 *  - `list` takes no arguments.
 *  - Empty args -> help.
 */
function parseCronArgs(args: string): ParsedCronArgs {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "help" };

  const spaceIdx = trimmed.search(/\s/);
  const sub = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx).trim();

  switch (sub) {
    case "list":
      return { kind: "list" };
    case "del": {
      if (!rest) {
        return { kind: "error", message: '用法: //cron del <id>\n例如: //cron del 3' };
      }
      const idToken = rest.split(/\s+/)[0]!;
      const id = Number(idToken);
      if (!Number.isInteger(id) || id <= 0) {
        return { kind: "error", message: `无效的任务 id: ${idToken}（应为正整数）` };
      }
      return { kind: "del", id };
    }
    case "add":
      return parseCronAdd(rest);
    default:
      return { kind: "error", message: `未知的 //cron 子命令: ${sub}\n\n${CRON_USAGE}` };
  }
}

/**
 * Parse the `add` subcommand body: `<quoted-expr> <prompt>`.
 * The cron expression MUST be quoted (single or double), since it contains spaces.
 */
function parseCronAdd(rest: string): ParsedCronArgs {
  if (!rest) {
    return { kind: "error", message: CRON_USAGE };
  }
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") {
    return {
      kind: "error",
      message: `cron 表达式必须用引号括起来（因为含空格）。\n例如: //cron add "*/5 * * * *" 检查部署状态\n\n${CRON_USAGE}`,
    };
  }
  const close = rest.indexOf(quote, 1);
  if (close === -1) {
    return { kind: "error", message: `cron 表达式的引号未闭合。\n\n${CRON_USAGE}` };
  }
  const expression = rest.slice(1, close);
  const prompt = rest.slice(close + 1).trim();
  if (!expression.trim()) {
    return { kind: "error", message: "cron 表达式不能为空" };
  }
  if (!prompt) {
    return { kind: "error", message: "prompt 不能为空" };
  }
  return { kind: "add", expression, prompt };
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

function replyForFile(result: SendFileResult): string {
  if (!result.ok) {
    return result.error;
  }
  return `已发送文件: ${result.fileName}`;
}

function replyForCronAdd(result: CronAddResult): string {
  if (!result.ok) {
    return result.error;
  }
  const j = result.job;
  return `已添加调度任务 #${j.id}:\n表达式: ${j.expression}\nPrompt: ${truncate(j.prompt, 80)}`;
}

function replyForCronDel(result: CronDeleteResult): string {
  if (!result.ok) {
    return result.error;
  }
  return "已删除调度任务。";
}

function replyForCronList(jobs: CronJob[], nextRun: (job: CronJob) => Date | null): string {
  if (jobs.length === 0) {
    return "当前没有调度任务。";
  }
  const lines = jobs.map((j) => {
    const next = nextRun(j);
    const nextStr = next ? formatDateTime(next) : "未知";
    return `#${j.id}  [${j.expression}]\n  prompt: ${truncate(j.prompt, 60)}\n  下次触发: ${nextStr}`;
  });
  return `调度任务 (${jobs.length}):\n${lines.join("\n")}`;
}

function formatDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function truncate(s: string, max: number): string {
  const t = s.length > max ? s.slice(0, max) + "…" : s;
  return t.replace(/\s+/g, " ");
}

const CRON_USAGE = [
  "用法:",
  "  //cron                                显示此帮助",
  "  //cron list                           列出当前用户的调度任务",
  "  //cron del <id>                       删除指定调度任务",
  '  //cron add "<cron-expr>" <prompt>     新增调度任务（cron 表达式须带引号，因为含空格）',
  "",
  "示例:",
  '  //cron add "*/5 * * * *" 检查部署状态并汇报',
].join("\n");

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
  contextToken: string,
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
    case "//pwd": {
      const cwd = deps.printWorkingDirectory(userId);
      return { handled: true, reply: `当前工作目录:\n${cwd}` };
    }
    case "//file": {
      if (!args) {
        return {
          handled: true,
          reply: "用法: //file <文件路径>\n例如: //file ./output/report.pdf 或 //file /tmp/data.json",
        };
      }
      const result = await deps.sendFile(userId, contextToken, args);
      return { handled: true, reply: replyForFile(result) };
    }
    case "//cron": {
      const parsed = parseCronArgs(args);
      switch (parsed.kind) {
        case "help":
          return { handled: true, reply: CRON_USAGE };
        case "list":
          return {
            handled: true,
            reply: replyForCronList(deps.listCrons(userId), deps.cronNextRun),
          };
        case "del": {
          const result = deps.deleteCron(userId, parsed.id);
          return { handled: true, reply: replyForCronDel(result) };
        }
        case "add": {
          const result = deps.addCron(userId, parsed.expression, parsed.prompt);
          return { handled: true, reply: replyForCronAdd(result) };
        }
        case "error":
          return { handled: true, reply: parsed.message };
      }
    }
    default:
      return {
        handled: true,
        reply: `未知 bridge 命令: ${command}\n当前支持: //stop, //cd, //pwd, //file, //cron`,
      };
  }
}
