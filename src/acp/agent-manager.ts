/**
 * Spawn and manage ACP agent subprocesses.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { Writable, Readable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import packageJson from "../../package.json" with { type: "json" };
import type { WeChatAcpClient } from "./client.js";

export interface AgentProcessInfo {
  process: ChildProcess;
  connection: acp.ClientSideConnection;
  sessionId: string;
}

export async function spawnAgent(params: {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  client: WeChatAcpClient;
  log: (msg: string) => void;
}): Promise<AgentProcessInfo> {
  const { command, args, cwd, env, client, log } = params;

  // On Windows, shell mode avoids EINVAL/ENOENT for command shims like npx/claude/gemini.
  const useShell = process.platform === "win32";
  // Detach on non-Windows so the agent gets its own process group. This lets
  // killAgent send a signal to the *group* (negative pid) and reap the agent's
  // own children too — critical for npx wrappers that otherwise orphan their
  // spawned package process when only the npx shim receives the signal.
  const detached = process.platform !== "win32";

  log(`Spawning agent: ${command} ${args.join(" ")} (cwd: ${cwd}, shell=${useShell})`);

  const proc = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
    cwd,
    env: { ...process.env, ...env },
    shell: useShell,
    windowsHide: true,
    detached,
  });

  proc.on("error", (err) => {
    log(`Agent process error: ${String(err)}`);
  });

  proc.on("exit", (code, signal) => {
    log(`Agent process exited: code=${code} signal=${signal}`);
  });

  if (!proc.stdin || !proc.stdout) {
    killAgent(proc);
    throw new Error("Failed to get agent process stdio");
  }

  const input = Writable.toWeb(proc.stdin);
  const output = Readable.toWeb(proc.stdout) as ReadableStream<Uint8Array>;
  const stream = acp.ndJsonStream(input, output);

  const connection = new acp.ClientSideConnection(() => client, stream);

  // If initialize/newSession throws (slow cold start, resource exhaustion),
  // clean up the already-spawned process instead of orphaning it.
  try {
    // Initialize
    log("Initializing ACP connection...");
    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: {
        name: packageJson.name,
        title: packageJson.name,
        version: packageJson.version,
      },
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true,
        },
      },
    });
    log(`ACP initialized (protocol v${initResult.protocolVersion})`);

    // Create session
    log("Creating ACP session...");
    const sessionResult = await connection.newSession({
      cwd,
      mcpServers: [],
    });
    log(`ACP session created: ${sessionResult.sessionId}`);

    return {
      process: proc,
      connection,
      sessionId: sessionResult.sessionId,
    };
  } catch (err) {
    killAgent(proc);
    throw err;
  }
}

/**
 * Terminate an agent and, where possible, its whole process group.
 *
 * Agents are typically launched via an `npx <pkg>` wrapper; signalling only the
 * wrapper pid orphans the real agent (the spawned package process) as it
 * detaches. By spawning detached (own process group) we can target the group
 * with a negative pid to reach every descendant. We fall back to a plain pid
 * signal if the group signal fails (e.g. non-detached spawn, or already dead),
 * and always escalate to SIGKILL after a grace window.
 */
export function killAgent(proc: ChildProcess): void {
  if (proc.killed) return;

  const pid = proc.pid;
  // Best effort: signal the entire process group first.
  const tryKillGroup = (signal: NodeJS.Signals): boolean => {
    if (!pid) return false;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // Group may not exist (non-detached spawn, or group already reaped).
      return false;
    }
  };

  tryKillGroup("SIGTERM") || proc.kill("SIGTERM");
  // Force kill after 5s if still alive
  setTimeout(() => {
    if (!proc.killed) {
      tryKillGroup("SIGKILL") || proc.kill("SIGKILL");
    }
  }, 5_000).unref();
}
