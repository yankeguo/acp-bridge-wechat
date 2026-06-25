/**
 * Per-user ACP session manager.
 *
 * Each WeChat user gets their own agent subprocess + ACP session.
 * Messages are queued per-user to ensure serialized processing.
 */

import type { ChildProcess } from "node:child_process";
import type * as acp from "@agentclientprotocol/sdk";
import { WeChatAcpClient } from "./client.js";
import { spawnAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";
import { resolveAgentDirectory } from "./user-cwd.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  contextToken: string;
}

export interface UserSession {
  userId: string;
  contextToken: string;
  client: WeChatAcpClient;
  agentInfo: AgentProcessInfo;
  queue: PendingMessage[];
  processing: boolean;
  /** When true, suppress agent replies (e.g. after //stop). */
  suppressOutbound: boolean;
  lastActivity: number;
  createdAt: number;
}

export type ChangeDirectoryResult =
  | { ok: true; path: string; hadSession: boolean }
  | { ok: false; error: string };

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  showThoughts: boolean;
  log: (msg: string) => void;
  onReply: (userId: string, contextToken: string, text: string) => Promise<void>;
  sendTyping: (userId: string, contextToken: string) => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  /**
   * In-flight session creation per user. Guards against the spawn storm: when a
   * session is torn down (e.g. after //cd) and the user sends several messages
   * before the new agent finishes booting, all those enqueues coalesce onto a
   * single createSession instead of each spawning its own agent subprocess.
   */
  private pendingSessions = new Map<string, Promise<UserSession>>();
  /** In-memory only; cleared when the bridge process restarts. */
  private userCwdOverrides = new Map<string, string>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private opts: SessionManagerOpts;
  private aborted = false;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
  }

  getAgentCwd(userId: string): string {
    return this.userCwdOverrides.get(userId) ?? this.opts.agentCwd;
  }

  start(): void {
    // Run cleanup every 2 minutes
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), 2 * 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    // Kill all agent processes
    for (const [userId, session] of this.sessions) {
      this.opts.log(`Stopping session for ${userId}`);
      killAgent(session.agentInfo.process);
    }
    this.sessions.clear();
    // In-flight spawns will see `this.aborted` and kill themselves on resolve;
    // drop the registry so nothing else awaits them.
    this.pendingSessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    const session = await this.getOrCreateSession(userId, message.contextToken);

    // Always update contextToken to the latest
    session.contextToken = message.contextToken;
    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      // Fire-and-forget processing loop for this user
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${userId}] queue processing error: ${String(err)}`);
      });
    }
  }

  /**
   * Return the live session for a user, or spawn one if none exists. Concurrent
   * callers during the spawn window (agent boot takes seconds) share a single
   * in-flight createSession via `pendingSessions`, so a burst of messages after
   * //cd (or any session teardown) spawns exactly one agent — not one per
   * message.
   */
  private getOrCreateSession(userId: string, contextToken: string): Promise<UserSession> {
    const existing = this.sessions.get(userId);
    if (existing) return Promise.resolve(existing);

    const pending = this.pendingSessions.get(userId);
    if (pending) return pending;

    if (this.sessions.size >= this.opts.maxConcurrentUsers) {
      // Evict oldest idle session
      this.evictOldest();
    }

    const creating = this.createSession(userId, contextToken)
      .then((session) => {
        // If the bridge is shutting down (or this user's session was torn down
        // while we were booting), kill the agent we just spawned and reject so
        // the caller doesn't enqueue into a dead session.
        if (this.aborted) {
          killAgent(session.agentInfo.process);
          throw new Error("session creation aborted");
        }
        this.sessions.set(userId, session);
        return session;
      })
      .finally(() => {
        this.pendingSessions.delete(userId);
      });
    this.pendingSessions.set(userId, creating);
    return creating;
  }

  getSession(userId: string): UserSession | undefined {
    return this.sessions.get(userId);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /**
   * Interrupt the current ACP turn for a user: cancel in-flight prompt and drop queued messages.
   */
  async stopInteraction(userId: string): Promise<"no_session" | "idle" | "stopped"> {
    const session = this.sessions.get(userId);
    if (!session) {
      return "no_session";
    }

    session.queue.length = 0;
    session.lastActivity = Date.now();

    if (!session.processing) {
      return "idle";
    }

    session.suppressOutbound = true;

    try {
      await session.agentInfo.connection.cancel({
        sessionId: session.agentInfo.sessionId,
      });
      this.opts.log(`[${userId}] Sent session/cancel`);
    } catch (err) {
      this.opts.log(`[${userId}] session/cancel failed: ${String(err)}`);
    }

    return "stopped";
  }

  /**
   * Set this user's agent working directory and tear down any existing ACP subprocess.
   * The next inbound message spawns a fresh agent in the new cwd.
   */
  async changeWorkingDirectory(userId: string, rawPath: string): Promise<ChangeDirectoryResult> {
    // Resolve relative paths against the user's *current* effective cwd (honoring
    // any prior //cd override), mirroring shell `cd` semantics — not the static
    // default agent cwd.
    const resolved = await resolveAgentDirectory(rawPath, this.getAgentCwd(userId));
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }

    const hadSession = this.sessions.has(userId) || this.pendingSessions.has(userId);

    // Update the override FIRST so any session spawned from here on (a concurrent
    // enqueue, or the pending createSession we're about to wait out and kill)
    // resolves the new directory. We then tear down whatever was running before.
    this.userCwdOverrides.set(userId, resolved.path);

    // Wait out an in-flight createSession so its process is registered and we
    // can kill it. Without this, a session spawned with the old cwd would be
    // re-inserted into the map after we delete, leaking a process.
    const pending = this.pendingSessions.get(userId);
    if (pending) {
      try {
        await pending;
      } catch {
        // createSession failures are logged within; proceed to teardown below.
      }
    }

    const session = this.sessions.get(userId);
    if (session) {
      session.queue.length = 0;
      session.suppressOutbound = true;
      session.lastActivity = Date.now();

      if (session.processing) {
        try {
          await session.agentInfo.connection.cancel({
            sessionId: session.agentInfo.sessionId,
          });
          this.opts.log(`[${userId}] session/cancel before //cd`);
        } catch (err) {
          this.opts.log(`[${userId}] session/cancel before //cd failed: ${String(err)}`);
        }
      }

      killAgent(session.agentInfo.process);
      this.sessions.delete(userId);
      this.opts.log(`[${userId}] Agent stopped for directory change`);
    }

    this.opts.log(`[${userId}] Agent cwd set to ${resolved.path}`);
    return { ok: true, path: resolved.path, hadSession };
  }

  /**
   * Run a single prompt against a throwaway agent bound to `cwd`, then tear it
   * down. Used by the cron scheduler so a scheduled task runs in the directory
   * captured when it was created — independent of the user's current `//cd`
   * override and their interactive agent. This path never touches the
   * `sessions` map: it does not count against `maxConcurrentUsers`, cannot be
   * evicted, and cannot collide with the user's interactive turn.
   */
  async runOnce(
    userId: string,
    contextToken: string,
    cwd: string,
    prompt: acp.ContentBlock[],
  ): Promise<void> {
    this.opts.log(`[${userId}] Starting ephemeral agent for scheduled task (cwd: ${cwd})`);

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: async (text) => {
        await this.opts.onReply(userId, contextToken, text);
      },
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
    });

    let agentInfo: AgentProcessInfo | null = null;
    try {
      agentInfo = await spawnAgent({
        command: this.opts.agentCommand,
        args: this.opts.agentArgs,
        cwd,
        env: this.opts.agentEnv,
        client,
        log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      });

      // Send typing immediately so the user sees the scheduled task is running.
      this.opts.sendTyping(userId, contextToken).catch(() => {});

      this.opts.log(`[${userId}] Sending scheduled prompt to ephemeral agent...`);
      const result = await agentInfo.connection.prompt({
        sessionId: agentInfo.sessionId,
        prompt,
      });

      let replyText = await client.flush();
      if (result.stopReason === "cancelled") {
        replyText += "\n[cancelled]";
      } else if (result.stopReason === "refusal") {
        replyText += "\n[agent refused to continue]";
      }

      this.opts.log(
        `[${userId}] Ephemeral agent done (${result.stopReason}), reply ${replyText.length} chars`,
      );

      if (replyText.trim()) {
        await this.opts.onReply(userId, contextToken, replyText);
      }
    } catch (err) {
      this.opts.log(`[${userId}] Ephemeral agent error: ${String(err)}`);
      try {
        await this.opts.onReply(
          userId,
          contextToken,
          `⚠️ Scheduled task error: ${String(err)}`,
        );
      } catch {
        // best effort
      }
    } finally {
      if (agentInfo) {
        killAgent(agentInfo.process);
      }
    }
  }

  private async createSession(userId: string, contextToken: string): Promise<UserSession> {
    const cwd = this.getAgentCwd(userId);
    this.opts.log(`Creating new session for ${userId} (cwd: ${cwd})`);

    const sessionRef: { current?: UserSession } = {};

    const client = new WeChatAcpClient({
      sendTyping: () => this.opts.sendTyping(userId, contextToken),
      onThoughtFlush: async (text) => {
        const s = sessionRef.current;
        if (s?.suppressOutbound) return;
        await this.opts.onReply(userId, contextToken, text);
      },
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
      showThoughts: this.opts.showThoughts,
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
    });

    // If agent process exits, clean up the session
    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s && s.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent process for ${userId} exited, removing session`);
        this.sessions.delete(userId);
      }
    });

    const session: UserSession = {
      userId,
      contextToken,
      client,
      agentInfo,
      queue: [],
      processing: false,
      suppressOutbound: false,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };
    sessionRef.current = session;
    return session;
  }

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        // Keep the ACP client instance stable because the connection is bound to it.
        session.client.updateCallbacks({
          sendTyping: () => this.opts.sendTyping(session.userId, pending.contextToken),
          onThoughtFlush: async (text) => {
            if (session.suppressOutbound) return;
            await this.opts.onReply(session.userId, pending.contextToken, text);
          },
        });

        // Reset chunks for the new turn
        await session.client.flush();

        try {
          // Send typing immediately so user knows the prompt was received
          this.opts.sendTyping(session.userId, pending.contextToken).catch(() => {});

          // Send ACP prompt
          this.opts.log(`[${session.userId}] Sending prompt to agent...`);
          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          const suppress = session.suppressOutbound;
          session.suppressOutbound = false;

          let replyText = await session.client.flush();

          if (suppress) {
            this.opts.log(`[${session.userId}] Agent turn ended (${result.stopReason}), reply suppressed after stop`);
            continue;
          }

          if (result.stopReason === "cancelled") {
            replyText += "\n[cancelled]";
          } else if (result.stopReason === "refusal") {
            replyText += "\n[agent refused to continue]";
          }

          this.opts.log(`[${session.userId}] Agent done (${result.stopReason}), reply ${replyText.length} chars`);

          if (replyText.trim()) {
            await this.opts.onReply(session.userId, pending.contextToken, replyText);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent prompt error: ${String(err)}`);

          // Check if agent died
          if (session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            this.opts.log(`[${session.userId}] Agent process died, removing session`);
            this.sessions.delete(session.userId);
            return;
          }

          // Send error message to user
          try {
            await this.opts.onReply(
              session.userId,
              pending.contextToken,
              `⚠️ Agent error: ${String(err)}`,
            );
          } catch {
            // best effort
          }
        }
      }
    } finally {
      session.processing = false;
    }
  }

  private cleanupIdleSessions(): void {
    if (this.opts.idleTimeoutMs <= 0) {
      return;
    }

    const now = Date.now();
    for (const [userId, session] of this.sessions) {
      if (now - session.lastActivity > this.opts.idleTimeoutMs && !session.processing) {
        this.opts.log(`Session for ${userId} idle for ${Math.round((now - session.lastActivity) / 60_000)}min, removing`);
        killAgent(session.agentInfo.process);
        this.sessions.delete(userId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, session] of this.sessions) {
      if (!session.processing && (!oldest || session.lastActivity < oldest.lastActivity)) {
        oldest = { userId, lastActivity: session.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Evicting oldest idle session: ${oldest.userId}`);
      const session = this.sessions.get(oldest.userId);
      if (session) killAgent(session.agentInfo.process);
      this.sessions.delete(oldest.userId);
    }
  }
}
