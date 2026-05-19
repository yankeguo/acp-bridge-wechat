import fs from "node:fs";
import path from "node:path";

/**
 * Persist context_token per user so replies work across bridge restarts.
 */

const contextTokenStore = new Map<string, string>();

function contextTokenKey(storageDir: string, userId: string): string {
  return `${storageDir}:${userId}`;
}

function contextTokenFilePath(storageDir: string): string {
  return path.join(storageDir, "context-tokens.json");
}

function persistContextTokens(storageDir: string): void {
  const prefix = `${storageDir}:`;
  const tokens: Record<string, string> = {};
  for (const [k, v] of contextTokenStore) {
    if (k.startsWith(prefix)) {
      tokens[k.slice(prefix.length)] = v;
    }
  }
  const filePath = contextTokenFilePath(storageDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(tokens, null, 0), "utf-8");
  } catch {
    // best effort
  }
}

export function restoreContextTokens(storageDir: string): void {
  const filePath = contextTokenFilePath(storageDir);
  try {
    if (!fs.existsSync(filePath)) return;
    const tokens = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, string>;
    for (const [userId, token] of Object.entries(tokens)) {
      if (typeof token === "string" && token) {
        contextTokenStore.set(contextTokenKey(storageDir, userId), token);
      }
    }
  } catch {
    // ignore
  }
}

export function setContextToken(storageDir: string, userId: string, token: string): void {
  const trimmed = token.trim();
  if (!trimmed) return;
  contextTokenStore.set(contextTokenKey(storageDir, userId), trimmed);
  persistContextTokens(storageDir);
}

export function getContextToken(storageDir: string, userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(storageDir, userId));
}

/**
 * Prefer the token from the current message; fall back to the last persisted token
 * for this user (survives restarts and messages missing context_token).
 */
export function resolveContextToken(
  storageDir: string,
  userId: string,
  incoming?: string,
): string | undefined {
  const trimmed = incoming?.trim();
  if (trimmed) {
    setContextToken(storageDir, userId, trimmed);
    return trimmed;
  }
  return getContextToken(storageDir, userId);
}
