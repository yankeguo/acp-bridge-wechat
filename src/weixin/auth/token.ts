/**
 * WeChat bot token persistence for acp-bridge-wechat.
 */

import fs from "node:fs";
import path from "node:path";

export interface TokenData {
  token: string;
  baseUrl: string;
  accountId: string;
  userId: string;
  savedAt: string;
}

function getTokenPath(storageDir: string): string {
  return path.join(storageDir, "token.json");
}

export function loadToken(storageDir: string): TokenData | null {
  const tokenPath = getTokenPath(storageDir);
  if (!fs.existsSync(tokenPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(tokenPath, "utf-8")) as TokenData;
  } catch {
    return null;
  }
}

export function saveToken(storageDir: string, data: TokenData): void {
  fs.mkdirSync(storageDir, { recursive: true });
  fs.writeFileSync(getTokenPath(storageDir), JSON.stringify(data, null, 2), "utf-8");
}

/** Collect recent bot tokens for QR login local_token_list (up to 10). */
export function listLocalBotTokens(primaryStorageDir: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();

  const add = (dir: string) => {
    const data = loadToken(dir);
    const t = data?.token?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };

  add(primaryStorageDir);

  const instancesRoot = path.join(path.dirname(primaryStorageDir), "instances");
  if (fs.existsSync(instancesRoot)) {
    for (const name of fs.readdirSync(instancesRoot)) {
      if (tokens.length >= 10) break;
      add(path.join(instancesRoot, name));
    }
  }

  return tokens.slice(0, 10);
}
