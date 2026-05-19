/**
 * WeChatAcpBridge — the main orchestrator.
 *
 * Connects WeChat's iLink long-poll to ACP agent subprocesses.
 * One bridge = one WeChat bot account → many users → many agent sessions.
 */

import path from "node:path";
import { login, loadToken, type TokenData } from "./weixin/auth/login.js";
import { startMonitor } from "./weixin/monitor/monitor.js";
import { sendTextMessage, splitText } from "./weixin/send.js";
import { sendTyping, notifyStart, notifyStop } from "./weixin/api/api.js";
import { TypingStatus, MessageType } from "./weixin/api/types.js";
import type { WeixinMessage } from "./weixin/api/types.js";
import { WeixinConfigManager } from "./weixin/api/config-cache.js";
import { setWeixinRuntimeConfig } from "./weixin/api/runtime-config.js";
import { initWeixinLogger } from "./weixin/util/logger.js";
import { setDebugModeStorageDir } from "./weixin/messaging/debug-mode.js";
import { handleSlashCommand } from "./weixin/messaging/slash-commands.js";
import { extractTextBody } from "./weixin/messaging/inbound.js";
import { assertSessionActive } from "./weixin/api/session-guard.js";
import { restoreContextTokens, setContextToken } from "./weixin/storage/context-tokens.js";
import { isDebugMode } from "./weixin/messaging/debug-mode.js";
import { SessionManager } from "./acp/session.js";
import { weixinMessageToPrompt } from "./adapter/inbound.js";
import { formatForWeChat } from "./adapter/outbound.js";
import type { WeChatAcpConfig } from "./config.js";

const TEXT_CHUNK_LIMIT = 4000;

export class WeChatAcpBridge {
  private config: WeChatAcpConfig;
  private abortController = new AbortController();
  private sessionManager: SessionManager | null = null;
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

    restoreContextTokens(this.config.storage.dir);
    setDebugModeStorageDir(this.config.storage.dir);

    if (!forceLogin) {
      this.tokenData = loadToken(this.config.storage.dir);
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

    this.log("Starting message polling...");
    await startMonitor({
      baseUrl: this.tokenData.baseUrl,
      token: this.tokenData.token,
      storageDir: this.config.storage.dir,
      accountId: this.tokenData.accountId,
      abortSignal: this.abortController.signal,
      log: this.log,
      onMessage: (msg, typingTicket) => this.handleMessage(msg, typingTicket),
    });
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    this.abortController.abort();
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
    if (msg.message_type !== MessageType.USER) return;
    if (msg.group_id) return;

    const userId = msg.from_user_id;
    const contextToken = msg.context_token;
    if (!userId || !contextToken) return;

    if (msg.context_token) {
      setContextToken(this.config.storage.dir, userId, msg.context_token);
    }
    if (typingTicket) {
      this.typingTickets.set(userId, typingTicket);
    }

    this.log(`Message from ${userId}: ${this.previewMessage(msg)}`);

    this.processMessage(msg, userId, contextToken).catch((err) => {
      this.log(`Failed to process message from ${userId}: ${String(err)}`);
    });
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

    const textBody = extractTextBody(msg);
    if (textBody.startsWith("/")) {
      const slash = await handleSlashCommand(
        textBody,
        {
          to: userId,
          contextToken,
          baseUrl: this.tokenData!.baseUrl,
          token: this.tokenData!.token,
          accountId: this.tokenData!.accountId,
          log: this.log,
          errLog: this.log,
        },
        Date.now(),
        msg.create_time_ms,
      );
      if (slash.handled) {
        this.log(`Slash command handled for ${userId}`);
        return;
      }
    }

    const mediaDir = path.join(this.config.storage.dir, "media");
    const prompt = await weixinMessageToPrompt(msg, {
      cdnBaseUrl: this.config.wechat.cdnBaseUrl,
      mediaDir,
      log: this.log,
    });

    await this.sessionManager!.enqueue(userId, { prompt, contextToken });
  }

  private async sendReply(userId: string, contextToken: string, text: string): Promise<void> {
    assertSessionActive(this.tokenData!.accountId);

    let outbound = text;
    if (isDebugMode(this.tokenData!.accountId)) {
      outbound += `\n\n⏱ [debug] reply delivered at ${new Date().toISOString()}`;
    }

    const formatted = formatForWeChat(outbound);
    const segments = splitText(formatted, TEXT_CHUNK_LIMIT);

    for (const segment of segments) {
      await sendTextMessage(userId, segment, {
        baseUrl: this.tokenData!.baseUrl,
        token: this.tokenData!.token,
        contextToken,
      });
    }

    this.cancelTypingIndicator(userId, contextToken).catch(() => {});
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
      const ticket = await this.resolveTypingTicket(userId, contextToken);
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
