/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import path from "node:path";
import { resolveAgentFile } from "./acp/user-cwd.js";
import { login, loadToken, type TokenData } from "./weixin/auth/login.js";
import { startMonitor } from "./weixin/monitor/monitor.js";
import { sendTextMessage, splitText } from "./weixin/send.js";
import { initPackageInfo, sendTyping, notifyStart, notifyStop } from "./weixin/api/api.js";
import { TypingStatus, MessageType } from "./weixin/api/types.js";
import type { WeixinMessage } from "./weixin/api/types.js";
import { WeixinConfigManager } from "./weixin/api/config-cache.js";
import { setWeixinRuntimeConfig } from "./weixin/api/runtime-config.js";
import { initWeixinLogger } from "./weixin/util/logger.js";
import { assertSessionActive } from "./weixin/api/session-guard.js";
import { restoreContextTokens, resolveContextToken } from "./weixin/storage/context-tokens.js";
import { SessionManager } from "./acp/session.js";
import { CronManager } from "./scheduler/cron.js";
import {
  handleBridgeCommand,
  isBridgeCommandMessage,
  type SendFileResult,
} from "./bridge-commands.js";
import { sendWeixinMediaFile } from "./weixin/messaging/send-media.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { filterMarkdown } from "./weixin/messaging/markdown-filter.js";
import type { WeChatAcpConfig } from "./config.js";
import { bodyFromItemList } from "./weixin/messaging/inbound.js";

const TEXT_CHUNK_LIMIT = 4000;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
  private cronManager: CronManager | null = null;
  private tokenData: TokenData | null = null;
  private configManager: WeixinConfigManager | null = null;
  private typingTickets = new Map<string, string>();
  private log: (msg: string) => void;
  private verbose: boolean;

  constructor(
    config: WeChatAcpConfig,
    log?: (msg: string) => void,
    opts?: { verbose?: boolean },
  ) {
    this.config = config;
    this.verbose = Boolean(opts?.verbose);
    this.log = log ?? ((msg: string) => console.log(`[acp-bridge-wechat] ${msg}`));
    initWeixinLogger({ log: this.log, verbose: this.verbose });
    setWeixinRuntimeConfig({
      botAgent: config.wechat.botAgent,
      routeTag: config.wechat.routeTag,
    });
  }

  async start(opts?: {
    forceLogin?: boolean;
    renderQrUrl?: (url: string) => void;
  }): Promise<void> {
    const { forceLogin, renderQrUrl } = opts ?? {};

    await initPackageInfo();
    await restoreContextTokens(this.config.storage.dir);

    if (!forceLogin) {
      this.tokenData = await loadToken(this.config.storage.dir);
    }

    if (!this.tokenData) {
      this.tokenData = await login({
        baseUrl: this.config.wechat.baseUrl,
        botType: this.config.wechat.botType,
        storageDir: this.config.storage.dir,
        log: this.log,
        renderQrUrl,
        verbose: this.verbose,
      });
    } else {
      this.log(
        `Loaded saved token (Bot: ${this.tokenData.accountId}, saved at ${this.tokenData.savedAt})`,
      );
      this.log(`Use --login to force re-login`);
    }

    try {
      const startResp = await notifyStart({
        baseUrl: this.tokenData.baseUrl,
        token: this.tokenData.token,
      });
      if (startResp.ret !== undefined && startResp.ret !== 0) {
        this.log(`notifyStart: ret=${startResp.ret} errmsg=${startResp.errmsg ?? ""}`);
      }
    } catch (err) {
      this.log(`notifyStart failed (ignored): ${String(err)}`);
    }

    this.configManager = new WeixinConfigManager(
      { baseUrl: this.tokenData.baseUrl, token: this.tokenData.token },
      this.log,
    );

    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (userId, contextToken, text) => this.sendReply(userId, contextToken, text),
      sendTyping: (userId, contextToken) => this.sendTypingIndicator(userId, contextToken),
    });
    this.sessionManager.start();

    this.cronManager = new CronManager({
      storageDir: this.config.storage.dir,
      fire: (userId, prompt) => this.fireCronJob(userId, prompt),
      log: this.log,
    });
    await this.cronManager.start();

    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      accountId: this.tokenData.accountId,
      configManager: this.configManager,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg, typingTicket) => this.handleMessage(msg, typingTicket),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
    await this.cronManager?.stop();
    await this.sessionManager?.stop();

    if (this.tokenData?.token) {
      try {
        const resp = await notifyStop({
          baseUrl: this.tokenData.baseUrl,
          token: this.tokenData.token,
        });
        if (resp.ret !== undefined && resp.ret !== 0) {
          this.log(`notifyStop: ret=${resp.ret} errmsg=${resp.errmsg ?? ""}`);
        }
      } catch (err) {
        this.log(`notifyStop failed (ignored): ${String(err)}`);
      }
    }

    this.log("Bridge stopped");
  }

  private handleMessage(msg: WeixinMessage, typingTicket: string): void {
    void this.dispatchInboundMessage(msg, typingTicket).catch((err) => {
      const userId = msg.from_user_id ?? "unknown";
      this.log(`Failed to process message from ${userId}: ${String(err)}`);
    });
  }

  private async dispatchInboundMessage(
    msg: WeixinMessage,
    typingTicket: string,
  ): Promise<void> {
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    if (!userId) return;

    const contextToken = await resolveContextToken(
      this.config.storage.dir,
      userId,
      msg.context_token,
    );
    if (!contextToken) {
      this.log(`No context_token for ${userId}, skipping message`);
      return;
    }

    if (typingTicket) {
      this.typingTickets.set(userId, typingTicket);
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);
    await this.processMessage(msg, userId, contextToken);
  }

  private async processMessage(
    msg: WeixinMessage,
    userId: string,
    contextToken: string,
  ): Promise<void> {
    try {
      assertSessionActive(this.tokenData!.accountId);
    } catch (err) {
      this.log(`Skipping message during session pause: ${String(err)}`);
      return;
    }

    const textBody = bodyFromItemList(msg.item_list);
    if (isBridgeCommandMessage(textBody)) {
      const result = await handleBridgeCommand(textBody, userId, contextToken, {
        stopInteraction: (uid) => this.sessionManager!.stopInteraction(uid),
        changeDirectory: (uid, dir) => this.sessionManager!.changeWorkingDirectory(uid, dir),
        printWorkingDirectory: (uid) => this.sessionManager!.getAgentCwd(uid),
        sendFile: (uid, token, filePath) => this.sendFileToUser(uid, token, filePath),
        addCron: (uid, expr, prompt) => this.cronManager!.add(uid, expr, prompt),
        deleteCron: (uid, id) => this.cronManager!.delete(uid, id),
        listCrons: (uid) => this.cronManager!.list(uid),
        cronNextRun: (job) => this.cronManager!.nextRunOf(job),
      });
      if (result.handled) {
        await this.sendReply(userId, contextToken, result.reply);
        await this.cancelTypingIndicator(userId, contextToken).catch(() => {});
      }
      return;
    }

    const mediaDir = path.join(this.config.storage.dir, "media");
    const prompt = await weixinMessageToPrompt(msg, {
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
      mediaDir,
      log: this.log,
    });

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  /**
   * Fire a cron job's prompt into the owner's ACP session.
   * Uses the user's last persisted context_token; skips silently if none.
   */
  private async fireCronJob(userId: string, prompt: string): Promise<void> {
    const contextToken = await resolveContextToken(this.config.storage.dir, userId);
    if (!contextToken) {
      this.log(`[${userId}] cron fire skipped: no context_token (user has never messaged)`);
      return;
    }
    await this.sessionManager!.enqueue(userId, {
      prompt: [{ type: "text", text: prompt }],
      contextToken,
    });
  }

  private async sendFileToUser(
    userId: string,
    contextToken: string,
    rawPath: string,
  ): Promise<SendFileResult> {
    const baseCwd = this.sessionManager!.getAgentCwd(userId);
    const resolved = await resolveAgentFile(rawPath, baseCwd);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    try {
      assertSessionActive(this.tokenData!.accountId);
    } catch (err) {
      return { ok: false, error: String(err) };
    }

    const resolvedToken = await resolveContextToken(
      this.config.storage.dir,
      userId,
      contextToken,
    );
    if (!resolvedToken) {
      return { ok: false, error: "无法发送：缺少 context_token" };
    }

    try {
      await sendWeixinMediaFile({
        filePath: resolved.path,
        to: userId,
        text: "",
        opts: {
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          contextToken: resolvedToken,
        },
        cdnBaseUrl: this.config.wechat.cdnBaseUrl,
      });
      const fileName = path.basename(resolved.path);
      this.log(`Sent file to ${userId}: ${resolved.path}`);
      await this.cancelTypingIndicator(userId, resolvedToken).catch(() => {});
      return { ok: true, path: resolved.path, fileName };
    } catch (err) {
      this.log(`Failed to send file to ${userId}: ${String(err)}`);
      return { ok: false, error: `发送失败: ${String(err)}` };
    }
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    assertSessionActive(this.tokenData!.accountId);

    const resolvedToken = await resolveContextToken(
      this.config.storage.dir,
      userId,
      contextToken,
    );
    if (!resolvedToken) {
      this.log(`Cannot send reply to ${userId}: no context_token available`);
      return;
    }

    const formatted = filterMarkdown(text);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);

    for (const segment of segments) {
      await sendTextMessage(userId, segment, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken: resolvedToken,
      });
    }

    this.cancelTypingIndicator(userId, resolvedToken).catch(() => {});
  }

  private async cancelTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      assertSessionActive(this.tokenData!.accountId);
    } catch {
      return;
    }
    const ticket = await this.resolveTypingTicket(userId, contextToken);
    if (!ticket) return;

    await sendTyping({
      baseUrl: this.tokenData!.baseUrl,
      token: this.tokenData!.token,
      body: {
        ilink_user_id: userId,
        typing_ticket: ticket,
        status: TypingStatus.CANCEL,
      },
    });
  }

  private async sendTypingIndicator(userId: string, contextToken: string): Promise<void> {
    try {
      assertSessionActive(this.tokenData!.accountId);
      const resolvedToken = await resolveContextToken(
        this.config.storage.dir,
        userId,
        contextToken,
      );
      if (!resolvedToken) return;

      const ticket = await this.resolveTypingTicket(userId, resolvedToken);
      if (!ticket) return;

      await sendTyping({
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        body: {
          ilink_user_id: userId,
          typing_ticket: ticket,
          status: TypingStatus.TYPING,
        },
      });
    } catch {
      // best-effort
    }
  }

  private async resolveTypingTicket(userId: string, contextToken: string): Promise<string | null> {
    const cached = this.typingTickets.get(userId);
    if (cached) return cached;

    if (!this.configManager) return null;
    const cfg = await this.configManager.getForUser(userId, contextToken);
    if (cfg.typingTicket) {
      this.typingTickets.set(userId, cfg.typingTicket);
      return cfg.typingTicket;
    }
    return null;
  }

  private previewMessage(msg: WeixinMessage): string {
    const items = msg.item_list ?? [];
    for (const item of items) {
      if (item.type === 1 && item.text_item?.text) {
        const text = item.text_item.text;
        return text.length > 50 ? text.substring(0, 50) + "..." : text;
      }
      if (item.type === 2) return "[image]";
      if (item.type === 3) {
        return item.voice_item?.text
          ? `[voice] ${item.voice_item.text.substring(0, 30)}`
          : "[voice]";
      }
      if (item.type === 4) return `[file] ${item.file_item?.file_name ?? ""}`;
      if (item.type === 5) return "[video]";
    }
    return "[empty]";
  }
}
