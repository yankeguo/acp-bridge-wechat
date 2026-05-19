import fs from "node:fs";
import path from "node:path";

import { getExtensionFromMime } from "./mime.js";
import { tempFileName } from "../util/random.js";

export type SaveMediaFn = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string,
) => Promise<{ path: string }>;

export function createSaveMediaFn(mediaRootDir: string): SaveMediaFn {
  return async (buffer, contentType, subdir = "inbound", maxBytes, originalFilename) => {
    if (maxBytes != null && buffer.length > maxBytes) {
      throw new Error(`Media exceeds max size (${buffer.length} > ${maxBytes})`);
    }

    const dir = path.join(mediaRootDir, subdir);
    fs.mkdirSync(dir, { recursive: true });

    const ext = originalFilename
      ? path.extname(originalFilename)
      : contentType
        ? getExtensionFromMime(contentType)
        : ".bin";
    const baseName = originalFilename
      ? path.basename(originalFilename)
      : tempFileName("media", ext.startsWith(".") ? ext : `.${ext}`);
    const filePath = path.join(dir, baseName);

    await fs.promises.writeFile(filePath, buffer);
    return { path: filePath };
  };
}
