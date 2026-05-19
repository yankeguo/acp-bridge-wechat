/**
 * WeChat bot token persistence for acp-bridge-wechat.
 */

import path from "node:path";

import { pathExists, readDirectoryNames, readJsonFile, writeJsonFile } from "../../util/fs-json.js";

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

export async function loadToken(storageDir: string): Promise<TokenData | null> {
  const tokenPath = getTokenPath(storageDir);
  if (!(await pathExists(tokenPath))) return null;
  const data = await readJsonFile<TokenData>(tokenPath);
  return data ?? null;
}

export async function saveToken(storageDir: string, data: TokenData): Promise<void> {
  await writeJsonFile(getTokenPath(storageDir), data, { indent: 2 });
}

/** Collect recent bot tokens for QR login local_token_list (up to 10). */
export async function listLocalBotTokens(primaryStorageDir: string): Promise<string[]> {
  const tokens: string[] = [];
  const seen = new Set<string>();

  const add = async (dir: string) => {
    const data = await loadToken(dir);
    const t = data?.token?.trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };

  const dirsToScan = new Set<string>([primaryStorageDir]);

  const nestedInstances = path.join(primaryStorageDir, "instances");
  if (await pathExists(nestedInstances)) {
    for (const name of await readDirectoryNames(nestedInstances)) {
      dirsToScan.add(path.join(nestedInstances, name));
    }
  }

  const parentDir = path.dirname(primaryStorageDir);
  const siblingInstances = path.join(parentDir, "instances");
  if (siblingInstances !== nestedInstances && (await pathExists(siblingInstances))) {
    for (const name of await readDirectoryNames(siblingInstances)) {
      dirsToScan.add(path.join(siblingInstances, name));
    }
  }

  for (const dir of dirsToScan) {
    if (tokens.length >= 10) break;
    await add(dir);
  }

  return tokens.slice(0, 10);
}
