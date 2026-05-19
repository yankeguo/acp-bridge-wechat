import path from "node:path";

import { readJsonFile, writeJsonFile } from "../../util/fs-json.js";

export type SyncBufData = {
  get_updates_buf: string;
};

export function getSyncBufFilePath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

async function readSyncBufFile(filePath: string): Promise<string | undefined> {
  const data = await readJsonFile<{ get_updates_buf?: string }>(filePath);
  if (typeof data?.get_updates_buf === "string") {
    return data.get_updates_buf;
  }
  return undefined;
}

export async function loadGetUpdatesBuf(storageDir: string): Promise<string> {
  return (await readSyncBufFile(getSyncBufFilePath(storageDir))) ?? "";
}

export async function saveGetUpdatesBuf(
  storageDir: string,
  getUpdatesBuf: string,
): Promise<void> {
  const filePath = getSyncBufFilePath(storageDir);
  await writeJsonFile(filePath, { get_updates_buf: getUpdatesBuf });
}
