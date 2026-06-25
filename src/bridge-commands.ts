/**
 * Bridge-owned slash commands (prefix `//` to distinguish from agent `/` commands).
 *
 * Parsing uses a cursor-based tokenizer that consumes the input left-to-right:
 * `//` → primary command word → per-command branch. Each branch reads exactly
 * the tokens it needs and ignores any trailing remainder.
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

/* ------------------------------------------------------------------ *
 * Tokenizer — cursor-based, consumes the input left to right.
 * ------------------------------------------------------------------ */

class Tokenizer {
  private s: string;
  private i = 0;

  constructor(input: string) {
    this.s = input;
  }

  /** Current cursor position (for diagnostics). */
  get pos(): number {
    return this.i;
  }

  /** True when the cursor has reached end of input. */
  eof(): boolean {
    return this.i >= this.s.length;
  }

  /** Advance over any run of whitespace. */
  skipWhitespace(): void {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) {
      this.i++;
    }
  }

  /** Peek at the next char without consuming. */
  peek(): string | undefined {
    return this.i < this.s.length ? this.s[this.i] : undefined;
  }

  /**
   * Read the next whitespace-delimited word (lowercased by callers as needed).
   * Returns "" at end of input. Does NOT handle quotes — a "word" is purely
   * a maximal run of non-whitespace characters.
   */
  readWord(): string {
    this.skipWhitespace();
    const start = this.i;
    while (this.i < this.s.length && !/\s/.test(this.s[this.i]!)) {
      this.i++;
    }
    return this.s.slice(start, this.i);
  }

  /**
   * Read a quoted segment. The cursor must currently sit on a quote char
   * (`"` or `'`). Consumes through the matching closing quote and returns the
   * inner content (without quotes). Returns undefined if not on a quote or the
   * quote is never closed.
   */
  readQuoted(): string | undefined {
    this.skipWhitespace();
    const quote = this.s[this.i];
    if (quote !== '"' && quote !== "'") return undefined;
    const close = this.s.indexOf(quote, this.i + 1);
    if (close === -1) return undefined;
    const inner = this.s.slice(this.i + 1, close);
    this.i = close + 1;
    return inner;
  }

  /**
   * Consume the rest of the input from the current cursor, after trimming
   * leading/trailing whitespace. Used for free-form tails like prompts or paths.
   */
  readRest(): string {
    this.skipWhitespace();
    const rest = this.s.slice(this.i).trim();
    this.i = this.s.length;
    return rest;
  }

  /** The full original input. */
  get source(): string {
    return this.s;
  }
}

/* ------------------------------------------------------------------ *
 * Reply formatters
 * ------------------------------------------------------------------ */

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
  return `**工作目录已切换为**\n\n\`${result.path}\`\n\n${restarted}`;
}

function replyForFile(result: SendFileResult): string {
  if (!result.ok) {
    return result.error;
  }
  return `已发送文件: \`${result.fileName}\``;
}

function replyForCronAdd(result: CronAddResult): string {
  if (!result.ok) {
    return result.error;
  }
  const j = result.job;
  return `**已添加调度任务 #${j.id}**\n\n- 表达式: \`${j.expression}\`\n- Prompt: ${truncate(j.prompt, 80)}`;
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
    return `- **#${j.id}** \`${j.expression}\` — ${truncate(j.prompt, 60)}（下次: ${nextStr}）`;
  });
  return `**调度任务 (${jobs.length})**\n\n${lines.join("\n")}`;
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
  "**//cron 用法**",
  "",
  "- `//cron` — 显示本帮助",
  "- `//cron list` — 列出当前用户的调度任务",
  "- `//cron del <id>` — 删除指定调度任务",
  '- `//cron add "<cron-expr>" <prompt>` — 新增调度任务（cron 表达式须带引号，因为含空格）',
  "",
  "**示例**",
  "",
  '`//cron add "*/5 * * * *" 检查部署状态并汇报`',
].join("\n");

const CD_USAGE = "**用法**: `//cd <目录>`\n\n例如: `//cd /path/to/project` 或 `//cd ../other-repo`";
const FILE_USAGE = "**用法**: `//file <文件路径>`\n\n例如: `//file ./output/report.pdf` 或 `//file /tmp/data.json`";
const UNKNOWN_USAGE = (cmd: string) =>
  `未知 bridge 命令: \`${cmd}\`\n\n输入 \`//help\` 查看支持的命令`;

const HELP_USAGE = [
  "**可用命令**",
  "",
  "- `//stop` — 停止当前 agent 回复并清空排队消息",
  "- `//cd <目录>` — 切换 agent 工作目录（下一条消息重启 agent）",
  "- `//pwd` — 打印当前 agent 工作目录",
  "- `//file <路径>` — 向用户发送本地文件",
  "- `//cron` — 管理定时调度任务（`//cron` 查看子命令）",
  "- `//help` — 显示本帮助",
].join("\n");

/* ------------------------------------------------------------------ *
 * Command dispatch
 * ------------------------------------------------------------------ */

/**
 * Returns true when the message should be handled as a bridge command (`//...`).
 */
export function isBridgeCommandMessage(text: string): boolean {
  return text.trim().startsWith("//");
}

/**
 * Handle a bridge command. All `//` messages are consumed here and not forwarded to ACP.
 *
 * Parsing is cursor-based: consume `//`, read the primary command word, then
 * branch into a per-command reader. Each branch consumes exactly the tokens it
 * needs; trailing input is ignored unless the branch explicitly reads a tail.
 */
export async function handleBridgeCommand(
  text: string,
  userId: string,
  contextToken: string,
  deps: BridgeCommandDeps,
): Promise<BridgeCommandHandleResult> {
  const trimmed = text.trim();

  // Must start with `//`.
  if (!trimmed.startsWith("//")) {
    return { handled: false };
  }
  // Consume the leading slashes; the tokenizer works on the remainder.
  const tk = new Tokenizer(trimmed.slice(2));

  const primary = tk.readWord().toLowerCase();

  switch (primary) {
    case "": {
      // Bare `//` → help.
      return { handled: true, reply: HELP_USAGE };
    }
    case "help": {
      // No arguments; ignore any trailing remainder.
      return { handled: true, reply: HELP_USAGE };
    }
    case "stop": {
      // No arguments; ignore any trailing remainder.
      const outcome = await deps.stopInteraction(userId);
      return { handled: true, reply: replyForStop(outcome) };
    }
    case "pwd": {
      // No arguments; ignore any trailing remainder.
      const cwd = deps.printWorkingDirectory(userId);
      return { handled: true, reply: `**当前工作目录**\n\n\`${cwd}\`` };
    }
    case "cd": {
      // The remainder (trimmed) is the directory path.
      const dir = tk.readRest();
      if (!dir) {
        return { handled: true, reply: CD_USAGE };
      }
      const result = await deps.changeDirectory(userId, dir);
      return { handled: true, reply: replyForCd(result) };
    }
    case "file": {
      // The remainder (trimmed) is the file path.
      const filePath = tk.readRest();
      if (!filePath) {
        return { handled: true, reply: FILE_USAGE };
      }
      const result = await deps.sendFile(userId, contextToken, filePath);
      return { handled: true, reply: replyForFile(result) };
    }
    case "cron": {
      return handleCron(tk, userId, deps);
    }
    default: {
      // Reconstruct the original `//<cmd>` form for the error message.
      return { handled: true, reply: UNKNOWN_USAGE(`//${primary}`) };
    }
  }
}

/**
 * `//cron` branch: read the subcommand word, then dispatch.
 */
async function handleCron(
  tk: Tokenizer,
  userId: string,
  deps: BridgeCommandDeps,
): Promise<BridgeCommandHandleResult> {
  const sub = tk.readWord().toLowerCase();

  switch (sub) {
    case "": {
      // No subcommand → help.
      return { handled: true, reply: CRON_USAGE };
    }
    case "list": {
      // Ignore any trailing remainder.
      return {
        handled: true,
        reply: replyForCronList(deps.listCrons(userId), deps.cronNextRun),
      };
    }
    case "del": {
      const idToken = tk.readWord();
      if (!idToken) {
        return { handled: true, reply: '**用法**: `//cron del <id>`\n\n例如: `//cron del 3`' };
      }
      const id = Number(idToken);
      if (!Number.isInteger(id) || id <= 0) {
        return { handled: true, reply: `无效的任务 id: ${idToken}（应为正整数）` };
      }
      // Ignore any trailing remainder after the id.
      const result = deps.deleteCron(userId, id);
      return { handled: true, reply: replyForCronDel(result) };
    }
    case "add": {
      // Read the quoted cron expression, then the rest as the prompt.
      const expression = tk.readQuoted();
      if (expression === undefined) {
        const onQuote = tk.peek() === '"' || tk.peek() === "'";
        if (onQuote) {
          return { handled: true, reply: `cron 表达式的引号未闭合。\n\n${CRON_USAGE}` };
        }
        return {
          handled: true,
          reply: `cron 表达式必须用引号括起来（因为含空格）。\n\n例如: \`//cron add "*/5 * * * *" 检查部署状态\`\n\n${CRON_USAGE}`,
        };
      }
      if (!expression.trim()) {
        return { handled: true, reply: "cron 表达式不能为空" };
      }
      const prompt = tk.readRest();
      if (!prompt) {
        return { handled: true, reply: "prompt 不能为空" };
      }
      const result = deps.addCron(userId, expression, prompt);
      return { handled: true, reply: replyForCronAdd(result) };
    }
    default: {
      return { handled: true, reply: `未知的 //cron 子命令: ${sub}\n\n${CRON_USAGE}` };
    }
  }
}
