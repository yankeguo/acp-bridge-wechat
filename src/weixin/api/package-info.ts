import path from "node:path";
import { fileURLToPath } from "node:url";

import { pathExists, readJsonFile } from "../../util/fs-json.js";

interface PackageJson {
  name?: string;
  version?: string;
  ilink_appid?: string;
}

function isOwnPackageJson(parsed: PackageJson): boolean {
  if (parsed.ilink_appid !== undefined) return true;
  const name = parsed.name ?? "";
  return name.includes("openclaw-weixin") || name === "acp-bridge-wechat";
}

export async function readPackageJsonFromDir(startDir: string): Promise<PackageJson> {
  try {
    let dir = startDir;
    const { root } = path.parse(dir);
    while (dir && dir !== root) {
      const candidate = path.join(dir, "package.json");
      if (await pathExists(candidate)) {
        const parsed = await readJsonFile<PackageJson>(candidate);
        if (parsed && isOwnPackageJson(parsed)) {
          return parsed;
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    // fall through
  }
  return {};
}

let channelVersion = "unknown";
let ilinkAppId = "";

let initPromise: Promise<void> | null = null;

/** Load package.json metadata used for WeChat API headers. Safe to call multiple times. */
export async function initPackageInfo(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const pkg = await readPackageJsonFromDir(
        path.dirname(fileURLToPath(import.meta.url)),
      );
      channelVersion = pkg.version ?? "unknown";
      ilinkAppId = pkg.ilink_appid ?? "";
    })();
  }
  await initPromise;
}

export function getChannelVersion(): string {
  return channelVersion;
}

export function getIlinkAppId(): string {
  return ilinkAppId;
}
