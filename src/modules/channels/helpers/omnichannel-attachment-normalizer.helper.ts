import { MessageTypeEnum } from 'src/common/enum';
import { MessageAttachmentMeta } from 'src/interface/message.interface';

export interface NormalizedOmnichannelAttachment {
  fileId: string;
  url: string;
  thumbnailUrl?: string;
  fileName: string;
  mimeType: string;
  size: number;
  attachmentKind: 'IMAGE' | 'STICKER' | 'GIF' | 'VIDEO' | 'AUDIO' | 'FILE' | 'LINK_SHARE';
  stickerId?: string;
  width?: number;
  height?: number;
  durationSec?: number;
  platformSourceUrl?: string;
}

export interface NormalizedMediaResolution {
  messageType: MessageTypeEnum;
  displayText: string;
  attachments: MessageAttachmentMeta[];
  primaryMediaUrl: string | null;
  hasSticker: boolean;
  stickerId: string | null;
}

/**
 * Meta Messenger Thumbs-Up (Like) sticker IDs luôn tồn tại trên mọi Page theo tài liệu Sticker API.
 */
export const META_LIKE_STICKER_IDS = new Set([
  '369239263222822',
  '369239343222814',
  '369239383222810',
]);

export const PLACEHOLDER_ATTACHMENT_LABELS = new Set([
  '[Khách hàng gửi tệp đính kèm]',
  '[Khách hàng gửi bình luận kèm hình ảnh/nhãn dán]',
  '[Tin nhắn đính kèm từ nền tảng]',
  '[Tin nhắn hình ảnh/vị trí Zalo OA]',
]);

function guessMimeTypeFromKindAndUrl(
  kind: NormalizedOmnichannelAttachment['attachmentKind'],
  url: string,
  explicitMime?: string | null,
): string {
  if (explicitMime && explicitMime.includes('/')) {
    return explicitMime;
  }
  const lowerUrl = (url || '').toLowerCase();
  if (kind === 'GIF' || lowerUrl.includes('.gif')) return 'image/gif';
  if (kind === 'STICKER' || lowerUrl.includes('.webp')) return 'image/webp';
  if (kind === 'IMAGE') {
    if (lowerUrl.includes('.png')) return 'image/png';
    return 'image/jpeg';
  }
  if (kind === 'VIDEO') return 'video/mp4';
  if (kind === 'AUDIO') {
    if (lowerUrl.includes('.ogg')) return 'audio/ogg';
    if (lowerUrl.includes('.m4a')) return 'audio/mp4';
    return 'audio/mpeg';
  }
  if (lowerUrl.includes('.pdf')) return 'application/pdf';
  return 'application/octet-stream';
}

function buildDefaultFileName(
  kind: NormalizedOmnichannelAttachment['attachmentKind'],
  index: number,
  explicitName?: string | null,
): string {
  if (explicitName && explicitName.trim()) {
    return explicitName.trim().slice(0, 180);
  }
  switch (kind) {
    case 'STICKER':
      return `sticker-${index + 1}.webp`;
    case 'GIF':
      return `animation-${index + 1}.gif`;
    case 'IMAGE':
      return `image-${index + 1}.jpg`;
    case 'VIDEO':
      return `video-${index + 1}.mp4`;
    case 'AUDIO':
      return `voice-${index + 1}.mp3`;
    case 'LINK_SHARE':
      return `shared-link-${index + 1}.html`;
    default:
      return `attachment-${index + 1}`;
  }
}

/**
 * Bóc tách toàn bộ tệp đính kèm từ Meta Webhook (`message.attachments[]` + `message.sticker_id`)
 * hoặc Graph API Historical Sync (`attachments.data[]` + `sticker` + `shares.data[]`).
 */
export function extractMetaAttachmentsFromPayload(params: {
  rawAttachments?: any[];
  stickerId?: string | number | null;
  stickerUrl?: string | null;
  shares?: any[];
  fallbackIdPrefix: string;
}): NormalizedOmnichannelAttachment[] {
  const results: NormalizedOmnichannelAttachment[] = [];
  const seenUrls = new Set<string>();
  const rawStickerId = params.stickerId ? String(params.stickerId).trim() : null;

  const list = Array.isArray(params.rawAttachments) ? params.rawAttachments : [];
  for (let idx = 0; idx < list.length; idx++) {
    const att = list[idx];
    if (!att || typeof att !== 'object') continue;

    const rawType = String(att.type || '').toLowerCase();
    const mimeRaw = String(att.mime_type || att.payload?.mime_type || '').toLowerCase();
    const attStickerId = att.payload?.sticker_id
      ? String(att.payload.sticker_id)
      : rawStickerId || undefined;

    // Ưu tiên định dạng Graph API (`image_data`, `video_data`, `file_url`) lẫn Webhook (`payload.url`)
    const animatedGifUrl =
      att.image_data?.animated_gif_url || att.payload?.animated_gif_url || null;
    const imageUrl =
      animatedGifUrl || att.image_data?.url || att.payload?.url || att.media?.image?.src || null;
    const videoUrl =
      att.video_data?.url ||
      (rawType === 'video' || rawType === 'ig_reel' || rawType === 'reel'
        ? att.payload?.url
        : null);
    const audioUrl =
      rawType === 'audio' || mimeRaw.startsWith('audio/')
        ? att.file_url || att.payload?.url || null
        : null;
    const fileUrl = att.file_url || (rawType === 'file' ? att.payload?.url : null);

    let kind: NormalizedOmnichannelAttachment['attachmentKind'] = 'FILE';
    let resolvedUrl: string | null = null;
    let thumbnailUrl: string | undefined;

    if (
      rawType === 'sticker' ||
      Boolean(attStickerId) ||
      (rawType === 'image' && Boolean(att.image_data?.render_as_sticker))
    ) {
      kind = 'STICKER';
      resolvedUrl = imageUrl || params.stickerUrl || null;
      thumbnailUrl = att.image_data?.preview_url || resolvedUrl || undefined;
    } else if (animatedGifUrl || rawType === 'animated_image_share' || mimeRaw === 'image/gif') {
      kind = 'GIF';
      resolvedUrl = animatedGifUrl || imageUrl;
      thumbnailUrl =
        att.image_data?.animated_gif_preview_url || att.image_data?.preview_url || undefined;
    } else if (
      videoUrl ||
      rawType === 'video' ||
      rawType === 'reel' ||
      rawType === 'ig_reel' ||
      mimeRaw.startsWith('video/')
    ) {
      kind = 'VIDEO';
      resolvedUrl = videoUrl || att.payload?.url || null;
      thumbnailUrl = att.video_data?.preview_url || undefined;
    } else if (audioUrl || rawType === 'audio' || mimeRaw.startsWith('audio/')) {
      kind = 'AUDIO';
      resolvedUrl = audioUrl || att.payload?.url || null;
    } else if (imageUrl || rawType === 'image' || mimeRaw.startsWith('image/')) {
      kind = 'IMAGE';
      resolvedUrl = imageUrl;
      thumbnailUrl = att.image_data?.preview_url || undefined;
    } else if (fileUrl || rawType === 'file') {
      kind = 'FILE';
      resolvedUrl = fileUrl || att.payload?.url || null;
    } else if (rawType === 'share' || rawType === 'fallback' || att.payload?.url) {
      kind = 'LINK_SHARE';
      resolvedUrl = att.payload?.url || att.url || null;
    }

    if (!resolvedUrl && attStickerId && META_LIKE_STICKER_IDS.has(attStickerId)) {
      kind = 'STICKER';
      resolvedUrl = `meta-like-sticker://${attStickerId}`;
    }

    if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    results.push({
      fileId: String(att.id || `${params.fallbackIdPrefix}_att_${idx}`),
      url: resolvedUrl,
      thumbnailUrl,
      fileName: buildDefaultFileName(kind, idx, att.name || att.title),
      mimeType: guessMimeTypeFromKindAndUrl(kind, resolvedUrl, mimeRaw),
      size: Number(att.size || 0),
      attachmentKind: kind,
      stickerId: attStickerId,
      width: Number(att.image_data?.width || att.video_data?.width || 0) || undefined,
      height: Number(att.image_data?.height || att.video_data?.height || 0) || undefined,
      durationSec: Number(att.video_data?.length || 0) || undefined,
      platformSourceUrl: resolvedUrl,
    });
  }

  // Trường hợp Graph API trả `sticker` riêng ở root message hoặc webhook chỉ gửi `sticker_id`
  if (results.length === 0 && (params.stickerUrl || rawStickerId)) {
    const fallbackUrl =
      params.stickerUrl ||
      (rawStickerId && META_LIKE_STICKER_IDS.has(rawStickerId)
        ? `meta-like-sticker://${rawStickerId}`
        : null);
    if (fallbackUrl) {
      results.push({
        fileId: `${params.fallbackIdPrefix}_sticker_0`,
        url: fallbackUrl,
        thumbnailUrl: fallbackUrl,
        fileName: 'sticker.webp',
        mimeType: 'image/webp',
        size: 0,
        attachmentKind: 'STICKER',
        stickerId: rawStickerId || undefined,
        platformSourceUrl: fallbackUrl,
      });
    }
  }

  // Trường hợp tin nhắn chia sẻ bài viết / sản phẩm trong `shares.data[]`
  if (Array.isArray(params.shares)) {
    for (let sIdx = 0; sIdx < params.shares.length; sIdx++) {
      const share = params.shares[sIdx];
      const shareLink = share?.link ? String(share.link) : null;
      if (!shareLink || seenUrls.has(shareLink)) continue;
      seenUrls.add(shareLink);
      results.push({
        fileId: String(share.id || `${params.fallbackIdPrefix}_share_${sIdx}`),
        url: shareLink,
        fileName: String(share.name || share.description || 'Liên kết chia sẻ'),
        mimeType: 'text/uri-list',
        size: 0,
        attachmentKind: 'LINK_SHARE',
        platformSourceUrl: shareLink,
      });
    }
  }

  return results;
}

/**
 * Bóc tách tệp đính kèm từ Zalo OA Webhook (`image`, `sticker`, `gif`, `audio`, `video`, `file`).
 */
export function extractZaloAttachmentsFromPayload(params: {
  rawAttachments?: any[];
  fallbackIdPrefix: string;
}): NormalizedOmnichannelAttachment[] {
  const results: NormalizedOmnichannelAttachment[] = [];
  const list = Array.isArray(params.rawAttachments) ? params.rawAttachments : [];

  for (let idx = 0; idx < list.length; idx++) {
    const att = list[idx];
    if (!att || typeof att !== 'object') continue;
    const rawType = String(att.type || '').toLowerCase();
    const url = att.payload?.url || att.payload?.thumbnail || null;
    if (!url) continue;

    let kind: NormalizedOmnichannelAttachment['attachmentKind'] = 'FILE';
    if (rawType === 'sticker') kind = 'STICKER';
    else if (rawType === 'gif') kind = 'GIF';
    else if (rawType === 'image') kind = 'IMAGE';
    else if (rawType === 'video') kind = 'VIDEO';
    else if (rawType === 'audio' || rawType === 'voice') kind = 'AUDIO';

    results.push({
      fileId: String(att.payload?.id || `${params.fallbackIdPrefix}_zalo_${idx}`),
      url: String(url),
      thumbnailUrl: att.payload?.thumbnail ? String(att.payload.thumbnail) : undefined,
      fileName: buildDefaultFileName(kind, idx, att.payload?.name),
      mimeType: guessMimeTypeFromKindAndUrl(kind, String(url), att.payload?.type),
      size: Number(att.payload?.size || 0),
      attachmentKind: kind,
      stickerId: rawType === 'sticker' && att.payload?.id ? String(att.payload.id) : undefined,
      platformSourceUrl: String(url),
    });
  }

  return results;
}

/**
 * Chuyển đổi danh sách attachment đã chuẩn hóa sang `MessageTypeEnum`, `MessageAttachmentMeta[]`
 * và nhãn hiển thị gọn gàng cho `conversation.lastMessage` (không còn hiện "tệp đính kèm" chung chung).
 */
export function resolveMessageTypeAndAttachments(params: {
  rawText?: string | null;
  attachments: NormalizedOmnichannelAttachment[];
  rewriteUrl?: (att: NormalizedOmnichannelAttachment, index: number) => string;
}): NormalizedMediaResolution {
  const trimmedText = String(params.rawText || '').trim();
  const hasRealText = Boolean(trimmedText && !PLACEHOLDER_ATTACHMENT_LABELS.has(trimmedText));

  if (!params.attachments || params.attachments.length === 0) {
    return {
      messageType: MessageTypeEnum.TEXT,
      displayText: trimmedText,
      attachments: [],
      primaryMediaUrl: null,
      hasSticker: false,
      stickerId: null,
    };
  }

  const mappedAttachments: MessageAttachmentMeta[] = params.attachments.map((att, idx) => {
    const finalUrl = params.rewriteUrl ? params.rewriteUrl(att, idx) : att.url;
    const finalThumb =
      att.thumbnailUrl && params.rewriteUrl && !att.thumbnailUrl.startsWith('meta-like-sticker://')
        ? finalUrl
        : att.thumbnailUrl || finalUrl;

    return {
      fileId: att.fileId,
      url: finalUrl,
      thumbnailUrl: finalThumb,
      fileName: att.fileName,
      mimeType: att.mimeType,
      size: att.size,
      attachmentKind: att.attachmentKind,
      stickerId: att.stickerId,
      width: att.width,
      height: att.height,
      durationSec: att.durationSec,
      isSticker: att.attachmentKind === 'STICKER',
      isAnimatedGif: att.attachmentKind === 'GIF',
      platformSourceUrl: att.platformSourceUrl,
    } as MessageAttachmentMeta;
  });

  const first = params.attachments[0];
  let messageType = MessageTypeEnum.FILE;
  if (
    first.attachmentKind === 'IMAGE' ||
    first.attachmentKind === 'STICKER' ||
    first.attachmentKind === 'GIF'
  ) {
    messageType = MessageTypeEnum.IMAGE;
  } else if (first.attachmentKind === 'VIDEO') {
    messageType = MessageTypeEnum.VIDEO;
  } else if (first.attachmentKind === 'AUDIO') {
    messageType = MessageTypeEnum.AUDIO;
  } else if (first.attachmentKind === 'LINK_SHARE') {
    messageType = MessageTypeEnum.TEXT;
  }

  let fallbackSummary = '[Tệp đính kèm]';
  if (first.attachmentKind === 'STICKER') {
    fallbackSummary =
      first.stickerId && META_LIKE_STICKER_IDS.has(first.stickerId) ? '👍' : '[Nhãn dán]';
  } else if (first.attachmentKind === 'GIF') {
    fallbackSummary = '[Ảnh động GIF]';
  } else if (first.attachmentKind === 'IMAGE') {
    fallbackSummary =
      params.attachments.length > 1 ? `[${params.attachments.length} hình ảnh]` : '[Hình ảnh]';
  } else if (first.attachmentKind === 'VIDEO') {
    fallbackSummary = '[Video]';
  } else if (first.attachmentKind === 'AUDIO') {
    fallbackSummary = '[Tin nhắn thoại]';
  } else if (first.attachmentKind === 'LINK_SHARE') {
    fallbackSummary = first.url;
  } else {
    fallbackSummary = `[Tệp: ${first.fileName}]`;
  }

  return {
    messageType,
    displayText: hasRealText ? trimmedText : fallbackSummary,
    attachments: mappedAttachments,
    primaryMediaUrl: mappedAttachments[0]?.url || null,
    hasSticker: params.attachments.some((a) => a.attachmentKind === 'STICKER'),
    stickerId: params.attachments.find((a) => a.stickerId)?.stickerId || null,
  };
}
