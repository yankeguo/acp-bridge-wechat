import fs from "node:fs";
import path from "node:path";

import { logger } from "../util/logger.js";

interface DebugModeState {
  accounts: Record<string, boolean>;
}

let storageDir: string | null = null;

export function setDebugModeStorageDir(dir: string): void {
  storageDir = dir;
}

function resolveDebugModePath(): string {
  const base = storageDir ?? path.join(process.env.HOME ?? "/tmp", ".acp-bridge-wechat");
  return path.join(base, "debug-mode.json");
}

function loadState(): DebugModeState {
  try {
    const raw = fs.readFileSync(resolveDebugModePath(), "utf-8");
    const parsed = JSON.parse(raw) as DebugModeState;
    if (parsed && typeof parsed.accounts === "object") return parsed;
  } catch {
    // missing or corrupt
  }
  return { accounts: {} };
}

function saveState(state: DebugModeState): void {
  const filePath = resolveDebugModePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2), "utf-8");
}

export function toggleDebugMode(accountId: string): boolean {
  const state = loadState();
  const next = !state.accounts[accountId];
  state.accounts[accountId] = next;
  try {
    saveState(state);
  } catch (err) {
    logger.error(`debug-mode: failed to persist state: ${String(err)}`);
  }
  return next;
}

export function isDebugMode(accountId: string): boolean {
  return loadState().accounts[accountId] === true;
}
