import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type ResolveDirectoryResult =
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

/**
 * Resolve and validate a directory path for //cd.
 * Relative paths are resolved against `baseCwd` (bridge default agent cwd).
 */
export function resolveAgentDirectory(rawPath: string, baseCwd: string): ResolveDirectoryResult {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "目录路径不能为空" };
  }

  const expanded = expandHomeDir(trimmed);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseCwd, expanded);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `目录不存在: ${resolved}` };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `不是目录: ${resolved}` };
  }

  return { ok: true, path: resolved };
}

/**
 * Resolve and validate a file path for //file.
 * Relative paths are resolved against `baseCwd` (this user's effective agent cwd).
 */
export function resolveAgentFile(rawPath: string, baseCwd: string): ResolveDirectoryResult {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return { ok: false, error: "文件路径不能为空" };
  }

  const expanded = expandHomeDir(trimmed);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseCwd, expanded);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return { ok: false, error: `文件不存在: ${resolved}` };
  }

  if (!stat.isFile()) {
    return { ok: false, error: `不是文件: ${resolved}` };
  }

  return { ok: true, path: resolved };
}
