import { extname } from 'path';

export interface DetectedFileSignature {
  ext: string;
  mime: string;
  category: 'image' | 'video' | 'audio' | 'document' | 'archive' | 'text' | 'unknown';
}

export class FileSignatureHelper {
  static isExecutableOrDangerous(buffer: Buffer): boolean {
    if (!buffer || buffer.length < 4) return false;

    // Windows PE / EXE / DLL ('MZ')
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) return true;

    // Linux ELF ('\x7FELF')
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      return true;
    }

    // Shell script ('#!')
    if (buffer[0] === 0x23 && buffer[1] === 0x21) return true;

    return false;
  }

  static detectByMagicBytes(buffer: Buffer, originalName = ''): DetectedFileSignature {
    const ext = extname(originalName).toLowerCase().replace('.', '');

    if (!buffer || buffer.length < 4) {
      return { ext, mime: 'application/octet-stream', category: 'unknown' };
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { ext: 'jpg', mime: 'image/jpeg', category: 'image' };
    }

    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return { ext: 'png', mime: 'image/png', category: 'image' };
    }

    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) {
      return { ext: 'gif', mime: 'image/gif', category: 'image' };
    }

    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF') {
      const format = buffer.subarray(8, 12).toString('ascii');
      if (format === 'WEBP') return { ext: 'webp', mime: 'image/webp', category: 'image' };
      if (format === 'WAVE') return { ext: 'wav', mime: 'audio/wav', category: 'audio' };
      if (format === 'AVI ') return { ext: 'avi', mime: 'video/x-msvideo', category: 'video' };
    }

    if (buffer[0] === 0x42 && buffer[1] === 0x4d) {
      return { ext: 'bmp', mime: 'image/bmp', category: 'image' };
    }

    if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) {
      return { ext: 'pdf', mime: 'application/pdf', category: 'document' };
    }

    if (
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07)
    ) {
      if (ext === 'docx') {
        return {
          ext: 'docx',
          mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          category: 'document',
        };
      }
      if (ext === 'xlsx') {
        return {
          ext: 'xlsx',
          mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          category: 'document',
        };
      }
      if (ext === 'pptx') {
        return {
          ext: 'pptx',
          mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          category: 'document',
        };
      }
      return { ext: 'zip', mime: 'application/zip', category: 'archive' };
    }

    if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
      if (ext === 'xls')
        return { ext: 'xls', mime: 'application/vnd.ms-excel', category: 'document' };
      if (ext === 'ppt')
        return { ext: 'ppt', mime: 'application/vnd.ms-powerpoint', category: 'document' };
      return { ext: 'doc', mime: 'application/msword', category: 'document' };
    }

    if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
      if (ext === 'm4a') return { ext: 'm4a', mime: 'audio/mp4', category: 'audio' };
      if (ext === 'mov') return { ext: 'mov', mime: 'video/quicktime', category: 'video' };
      return { ext: 'mp4', mime: 'video/mp4', category: 'video' };
    }

    if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
      if (ext === 'webm') return { ext: 'webm', mime: 'video/webm', category: 'video' };
      return { ext: 'mkv', mime: 'video/x-matroska', category: 'video' };
    }

    if (
      (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
    ) {
      return { ext: 'mp3', mime: 'audio/mpeg', category: 'audio' };
    }

    if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
      return { ext: 'ogg', mime: 'audio/ogg', category: 'audio' };
    }

    if (buffer.subarray(0, 4).toString('ascii') === 'Rar!') {
      return { ext: 'rar', mime: 'application/vnd.rar', category: 'archive' };
    }

    if (
      buffer.length >= 6 &&
      buffer[0] === 0x37 &&
      buffer[1] === 0x7a &&
      buffer[2] === 0xbc &&
      buffer[3] === 0xaf
    ) {
      return { ext: '7z', mime: 'application/x-7z-compressed', category: 'archive' };
    }

    if (buffer.length >= 5 && buffer.subarray(0, 5).toString('ascii') === '{\\rtf') {
      return { ext: 'rtf', mime: 'application/rtf', category: 'document' };
    }

    if (['txt', 'csv', 'svg'].includes(ext) && !this.hasBinaryNullBytes(buffer)) {
      if (ext === 'csv') return { ext: 'csv', mime: 'text/csv', category: 'text' };
      if (ext === 'svg') return { ext: 'svg', mime: 'image/svg+xml', category: 'image' };
      return { ext: 'txt', mime: 'text/plain', category: 'text' };
    }

    return { ext, mime: 'application/octet-stream', category: 'unknown' };
  }

  private static hasBinaryNullBytes(buffer: Buffer): boolean {
    const sampleLength = Math.min(buffer.length, 512);
    for (let i = 0; i < sampleLength; i++) {
      if (buffer[i] === 0x00) return true;
    }
    return false;
  }
}
