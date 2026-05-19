/**
 * Inbound message helpers (vendored from openclaw-weixin messaging/inbound.ts).
 */

import type { MessageItem, WeixinMessage } from "../api/types.js";
import { MessageItemType } from "../api/types.js";

export type WeixinInboundMediaOpts = {
  decryptedPicPath?: string;
  decryptedVoicePath?: string;
  voiceMediaType?: string;
  decryptedFilePath?: string;
  fileMediaType?: string;
  decryptedVideoPath?: string;
};

export function isMediaItem(item: MessageItem): boolean {
  return (
    item.type === MessageItemType.IMAGE ||
    item.type === MessageItemType.VIDEO ||
    item.type === MessageItemType.FILE ||
    item.type === MessageItemType.VOICE
  );
}

export function bodyFromItemList(itemList?: MessageItem[]): string {
  if (!itemList?.length) return "";
  for (const item of itemList) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      if (!parts.length) return text;
      return `[引用: ${parts.join(" | ")}]\n${text}`;
    }
    if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

export function extractTextBody(msg: WeixinMessage): string {
  return bodyFromItemList(msg.item_list);
}

const hasDownloadableMedia = (m?: { encrypt_query_param?: string; full_url?: string }) =>
  Boolean(m?.encrypt_query_param || m?.full_url);

/** Find primary media item (IMAGE > VIDEO > FILE > VOICE), then quoted media fallback. */
export function findInboundMediaItem(msg: WeixinMessage): MessageItem | undefined {
  const list = msg.item_list;
  const main =
    list?.find((i) => i.type === MessageItemType.IMAGE && hasDownloadableMedia(i.image_item?.media)) ??
    list?.find((i) => i.type === MessageItemType.VIDEO && hasDownloadableMedia(i.video_item?.media)) ??
    list?.find((i) => i.type === MessageItemType.FILE && hasDownloadableMedia(i.file_item?.media)) ??
    list?.find(
      (i) =>
        i.type === MessageItemType.VOICE &&
        hasDownloadableMedia(i.voice_item?.media) &&
        !i.voice_item?.text,
    );

  if (main) return main;

  const refItem = list?.find(
    (i) =>
      i.type === MessageItemType.TEXT &&
      i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  )?.ref_msg?.message_item;

  return refItem;
}
