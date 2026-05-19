import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type ResolvePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Expand a leading `~` to the user home directory.
 */
export function expandHomeDir(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

function resolvePath(rawPath: string, baseCwd: string): string | { ok: false; error: string } {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "路径不能为空" };
  }

  const expanded = expandHomeDir(trimmed);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseCwd, expanded);

  return resolved;
}

/**
 * Resolve and validate a directory path for //cd.
 * Relative paths are resolved against `baseCwd` (bridge default agent cwd).
 */
export async function resolveAgentDirectory(
  rawPath: string,
  baseCwd: string,
): Promise<ResolvePathResult> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "目录路径不能为空" };
  }

  const resolved = resolvePath(rawPath, baseCwd);
  if (typeof resolved !== "string") {
    return resolved;
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isDirectory()) {
      return { ok: false, error: `不是目录: ${resolved}` };
    }
    return { ok: true, path: resolved };
  } catch {
    return { ok: false, error: `目录不存在: ${resolved}` };
  }
}

/**
 * Resolve and validate a file path for //file.
 * Relative paths are resolved against `baseCwd` (this user's effective agent cwd).
 */
export async function resolveAgentFile(
  rawPath: string,
  baseCwd: string,
): Promise<ResolvePathResult> {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "文件路径不能为空" };
  }

  const resolved = resolvePath(rawPath, baseCwd);
  if (typeof resolved !== "string") {
    return resolved;
  }

  try {
    const fileStat = await stat(resolved);
    if (!fileStat.isFile()) {
      return { ok: false, error: `不是文件: ${resolved}` };
    }
    return { ok: true, path: resolved };
  } catch {
    return { ok: false, error: `文件不存在: ${resolved}` };
  }
}
