/**
 * Inbound adapter: convert WeChat messages to ACP ContentBlock[].
 */

import fs from "node:fs";
import path from "node:path";
import type * as acp from "@agentclientprotocol/sdk";
import type { WeixinMessage } from "../weixin/api/types.js";
import { MessageItemType } from "../weixin/api/types.js";
import { downloadMediaFromItem } from "../weixin/media/media-download.js";
import { createSaveMediaFn } from "../weixin/media/save-media.js";
import { getMimeFromFilename } from "../weixin/media/mime.js";
import {
  bodyFromItemList,
  findInboundMediaItem,
  type WeixinInboundMediaOpts,
} from "../weixin/messaging/inbound.js";

export interface InboundConvertOpts {
  cdnBaseUrl: string;
  mediaDir: string;
  log: (msg: string) => void;
}

/**
 * Convert a WeChat message to ACP ContentBlock[] for use in session/prompt.
 */
export async function weixinMessageToPrompt(
  msg: WeixinMessage,
  opts: InboundConvertOpts,
): Promise<acp.ContentBlock[]> {
  const blocks: acp.ContentBlock[] = [];
  const { cdnBaseUrl, mediaDir, log } = opts;

  const text = bodyFromItemList(msg.item_list);
  if (text) {
    blocks.push({ type: "text", text });
  }

  const mediaItem = findInboundMediaItem(msg);
  if (mediaItem) {
    try {
      const saveMedia = createSaveMediaFn(mediaDir);
      const downloaded: WeixinInboundMediaOpts = await downloadMediaFromItem(mediaItem, {
        cdnBaseUrl,
        saveMedia,
        log,
        errLog: log,
        label: "inbound",
      });
      const attached = await mediaOptsToContentBlock(downloaded, log);
      if (attached) blocks.push(attached);
    } catch (err) {
      log(`Media download failed, skipping: ${String(err)}`);
      blocks.push({
        type: "text",
        text: `[Received media - download failed: ${String(err)}]`,
      });
    }
  }

  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "[empty message]" });
  }

  return blocks;
}

async function mediaOptsToContentBlock(
  media: WeixinInboundMediaOpts,
  log: (msg: string) => void,
): Promise<acp.ContentBlock | null> {
  if (media.decryptedPicPath) {
    log(`Downloaded image: ${media.decryptedPicPath}`);
    const buffer = await fs.promises.readFile(media.decryptedPicPath);
    return {
      type: "image",
      data: buffer.toString("base64"),
      mimeType: "image/jpeg",
    } as acp.ContentBlock;
  }

  if (media.decryptedFilePath) {
    const fileName = path.basename(media.decryptedFilePath);
    log(`Downloaded file: ${fileName}`);
    const buffer = await fs.promises.readFile(media.decryptedFilePath);
    if (isTextFile(fileName)) {
      return {
        type: "resource",
        resource: {
          uri: `file:///${fileName}`,
          mimeType: media.fileMediaType ?? getMimeFromFilename(fileName),
          text: buffer.toString("utf-8"),
        },
      } as acp.ContentBlock;
    }
    return {
      type: "text",
      text: `[Received file: ${fileName}, ${buffer.length} bytes]`,
    };
  }

  if (media.decryptedVoicePath) {
    log(`Downloaded voice: ${media.decryptedVoicePath} (${media.voiceMediaType ?? "audio"})`);
    return {
      type: "text",
      text: `[Received voice message at ${media.decryptedVoicePath}]`,
    };
  }

  if (media.decryptedVideoPath) {
    log(`Downloaded video: ${media.decryptedVideoPath}`);
    return {
      type: "text",
      text: `[Received video: ${path.basename(media.decryptedVideoPath)}]`,
    };
  }

  return null;
}

function isTextFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return [
    "txt", "md", "json", "js", "ts", "py", "java", "c", "cpp", "h",
    "css", "html", "xml", "yaml", "yml", "toml", "ini", "cfg", "sh",
    "bash", "rs", "go", "rb", "php", "sql", "csv", "log", "env",
  ].includes(ext);
}
