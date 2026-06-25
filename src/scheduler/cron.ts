/**
 * Cron scheduler: per-user scheduled prompts backed by node-cron.
 *
 * Jobs are isolated per WeChat user and persisted to disk so they survive bridge
 * restarts. When a job fires, the configured `fire` callback is invoked, which
 * the bridge wires to enqueue the prompt into that user's ACP session.
 */

import cron from "node-cron";
import type { ScheduledTask } from "node-cron";
import path from "node:path";

import { readJsonFile, writeJsonFile } from "../util/fs-json.js";

export interface CronJob {
  id: number;
  userId: string;
  expression: string;
  prompt: string;
  createdAt: number;
}

interface CronJobsFile {
  jobs: CronJob[];
}

export type CronAddResult =
  | { ok: true; job: CronJob }
  | { ok: false; error: string };

export type CronDeleteResult =
  | { ok: true }
  | { ok: false; error: string };

export interface CronManagerOpts {
  storageDir: string;
  /** Invoked when a job fires. Should enqueue the prompt into the user's session. */
  fire: (userId: string, prompt: string) => void | Promise<void>;
  log: (msg: string) => void;
}

export function getCronJobsFilePath(storageDir: string): string {
  return path.join(storageDir, "cron-jobs.json");
}

/**
 * Validate a cron expression using node-cron's built-in validator.
 */
export function isValidCronExpression(expression: string): boolean {
  return cron.validate(expression);
}

export class CronManager {
  private opts: CronManagerOpts;
  /** All jobs across all users (per-user filter happens at the API boundary). */
  private jobs: CronJob[] = [];
  /** Running node-cron tasks keyed by job id (unique across all users). */
  private tasks = new Map<string, ScheduledTask>();
  /** Coalesced-write promise chain, mirroring context-tokens.ts. */
  private persistChain: Promise<void> = Promise.resolve();
  private started = false;

  constructor(opts: CronManagerOpts) {
    this.opts = opts;
  }

  /**
   * Restore persisted jobs from disk and start their schedules.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    const file = await readJsonFile<CronJobsFile>(getCronJobsFilePath(this.opts.storageDir));
    if (file?.jobs && Array.isArray(file.jobs)) {
      for (const job of file.jobs) {
        if (!isValidCronJobShape(job)) continue;
        this.jobs.push(job);
        this.scheduleJob(job);
      }
      if (this.jobs.length > 0) {
        this.opts.log(`Restored ${this.jobs.length} cron job(s) from disk`);
      }
    }
  }

  /**
   * Stop all running tasks and clear in-memory state. Persisted jobs remain on
   * disk and will be restored on next start().
   */
  async stop(): Promise<void> {
    for (const task of this.tasks.values()) {
      await task.stop();
    }
    this.tasks.clear();
    this.jobs = [];
    this.started = false;
  }

  list(userId: string): CronJob[] {
    return this.jobs.filter((j) => j.userId === userId);
  }

  /**
   * Best-effort next run time for a job, or null if unavailable.
   */
  nextRunOf(job: CronJob): Date | null {
    return this.tasks.get(taskKey(job))?.getNextRun() ?? null;
  }

  add(userId: string, expression: string, prompt: string): CronAddResult {
    const trimmedExpr = expression.trim();
    if (!trimmedExpr) {
      return { ok: false, error: "cron 表达式不能为空" };
    }
    if (!isValidCronExpression(trimmedExpr)) {
      return { ok: false, error: `无效的 cron 表达式: ${trimmedExpr}` };
    }
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      return { ok: false, error: "prompt 不能为空" };
    }

    const id = nextJobId(this.jobs);
    const job: CronJob = {
      id,
      userId,
      expression: trimmedExpr,
      prompt: trimmedPrompt,
      createdAt: Date.now(),
    };
    this.jobs.push(job);
    this.scheduleJob(job);
    this.schedulePersist();
    return { ok: true, job };
  }

  delete(userId: string, id: number): CronDeleteResult {
    const idx = this.jobs.findIndex((j) => j.userId === userId && j.id === id);
    if (idx === -1) {
      return { ok: false, error: `未找到 id 为 ${id} 的调度任务` };
    }
    const [removed] = this.jobs.splice(idx, 1);
    const task = this.tasks.get(taskKey(removed));
    if (task) {
      // node-cron stop() is async in v4; fire-and-forget is fine here since we
      // drop the reference and clear the registry.
      void task.stop();
      this.tasks.delete(taskKey(removed));
    }
    this.schedulePersist();
    return { ok: true };
  }

  private scheduleJob(job: CronJob): void {
    const task = cron.schedule(
      job.expression,
      () => {
        this.opts.log(`[${job.userId}] cron job #${job.id} fired: "${truncate(job.prompt, 60)}"`);
        try {
          const ret = this.opts.fire(job.userId, job.prompt);
          if (ret && typeof (ret as Promise<void>).catch === "function") {
            (ret as Promise<void>).catch((err) => {
              this.opts.log(`[${job.userId}] cron job #${job.id} fire failed: ${String(err)}`);
            });
          }
        } catch (err) {
          this.opts.log(`[${job.userId}] cron job #${job.id} fire failed: ${String(err)}`);
        }
      },
    );
    this.tasks.set(taskKey(job), task);
  }

  private schedulePersist(): void {
    this.persistChain = this.persistChain
      .then(() => this.persist())
      .catch(() => {});
  }

  private async persist(): Promise<void> {
    const filePath = getCronJobsFilePath(this.opts.storageDir);
    const data: CronJobsFile = { jobs: this.jobs };
    try {
      await writeJsonFile(filePath, data, { indent: 2 });
    } catch {
      // best effort, mirroring context-tokens.ts
    }
  }
}

function taskKey(job: Pick<CronJob, "userId" | "id">): string {
  return `${job.userId}:${job.id}`;
}

function nextJobId(jobs: CronJob[]): number {
  return jobs.reduce((max, j) => (j.id > max ? j.id : max), 0) + 1;
}

function truncate(s: string, max: number): string {
  const t = s.length > max ? s.slice(0, max) + "…" : s;
  return t.replace(/\s+/g, " ");
}

function isValidCronJobShape(job: unknown): job is CronJob {
  if (typeof job !== "object" || job === null) return false;
  const j = job as Record<string, unknown>;
  return (
    typeof j.id === "number" &&
    typeof j.userId === "string" &&
    typeof j.expression === "string" &&
    typeof j.prompt === "string" &&
    typeof j.createdAt === "number"
  );
}
