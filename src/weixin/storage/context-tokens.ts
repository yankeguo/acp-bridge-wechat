import path from "node:path";

import { pathExists, readJsonFile, writeJsonFile } from "../../util/fs-json.js";

/**
 * Persist context_token per user so replies work across bridge restarts.
 */

const contextTokenStore = new Map<string, string>();

const persistChains = new Map<string, Promise<void>>();

function contextTokenKey(storageDir: string, userId: string): string {
  return `${storageDir}:${userId}`;
}

function contextTokenFilePath(storageDir: string): string {
  return path.join(storageDir, "context-tokens.json");
}

async function persistContextTokens(storageDir: string): Promise<void> {
  const prefix = `${storageDir}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = contextTokenFilePath(storageDir);
  try {
    await writeJsonFile(filePath, tokens);
  } catch {
    // best effort
  }
}

function schedulePersistContextTokens(storageDir: string): Promise<void> {
  const prev = persistChains.get(storageDir) ?? Promise.resolve();
  const next = prev
    .then(() => persistContextTokens(storageDir))
    .catch(() => {});
  persistChains.set(storageDir, next);
  return next;
}

export async function restoreContextTokens(storageDir: string): Promise<void> {
  const filePath = contextTokenFilePath(storageDir);
  if (!(await pathExists(filePath))) return;

  const tokens = await readJsonFile<Record<string, string>>(filePath);
  if (!tokens) return;

  for (const [userId, token] of Object.entries(tokens)) {
    if (typeof token === "string" && token) {
      contextTokenStore.set(contextTokenKey(storageDir, userId), token);
    }
  }
}

export async function setContextToken(
  storageDir: string,
  userId: string,
  token: string,
): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) return;
  contextTokenStore.set(contextTokenKey(storageDir, userId), trimmed);
  await schedulePersistContextTokens(storageDir);
}

export function getContextToken(storageDir: string, userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(storageDir, userId));
}

/**
 * Prefer the token from the current message; fall back to the last persisted token
 * for this user (survives restarts and messages missing context_token).
 */
export async function resolveContextToken(
  storageDir: string,
  userId: string,
  incoming?: string,
): Promise<string | undefined> {
  const trimmed = incoming?.trim();
  if (trimmed) {
    await setContextToken(storageDir, userId, trimmed);
    return trimmed;
  }
  return getContextToken(storageDir, userId);
}
