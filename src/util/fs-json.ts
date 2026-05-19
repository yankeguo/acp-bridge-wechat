import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
  try {
    const raw = await readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    return undefined;
  }
}

export async function writeJsonFile(
  filePath: string,
  data: unknown,
  options?: { indent?: number },
): Promise<void> {
  await ensureDir(path.dirname(filePath));
  const indent = options?.indent;
  const content =
    indent != null ? JSON.stringify(data, null, indent) : JSON.stringify(data);
  await writeFile(filePath, content, "utf-8");
}

export async function readDirectoryNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
