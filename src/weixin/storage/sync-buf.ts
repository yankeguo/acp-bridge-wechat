import fs from "node:fs";
import path from "node:path";

export type SyncBufData = {
  get_updates_buf: string;
};

export function getSyncBufFilePath(storageDir: string): string {
  return path.join(storageDir, "sync-buf.json");
}

function readSyncBufFile(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === "string") {
      return data.get_updates_buf;
    }
  } catch {
    // missing or invalid
  }
  return undefined;
}

export function loadGetUpdatesBuf(storageDir: string): string {
  return readSyncBufFile(getSyncBufFilePath(storageDir)) ?? "";
}

export function saveGetUpdatesBuf(storageDir: string, getUpdatesBuf: string): void {
  const filePath = getSyncBufFilePath(storageDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
