import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as crypto from 'crypto';

export interface EncryptedPayloadResult {
  ciphertext: string;
  isEncrypted: true;
  algorithm: 'AES-256-GCM';
}

export interface TurnIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

@Injectable()
export class MessageCryptoService {
  private readonly logger = new Logger(MessageCryptoService.name);
  private readonly masterSecret: Buffer;
  private readonly ENVELOPE_PREFIX = 'enc:v1:';
  private readonly IV_LENGTH = 12;
  private readonly AUTH_TAG_LENGTH = 16;

  constructor(private readonly configService?: ConfigService) {
    const rawSecret =
      this.configService?.get<string>('CHAT_ENCRYPTION_KEY') ||
      this.configService?.get<string>('JWT_SECRET') ||
      process.env.CHAT_ENCRYPTION_KEY ||
      process.env.JWT_SECRET ||
      'default-chat-master-encryption-key-32b';

    this.masterSecret = crypto.createHash('sha256').update(rawSecret).digest();
  }

  private deriveConversationKey(conversationId: string): Buffer {
    const derived = crypto.hkdfSync(
      'sha256',
      this.masterSecret,
      Buffer.from(conversationId, 'utf8'),
      Buffer.from('chat-message-aes-256-gcm-v1', 'utf8'),
      32,
    );
    return Buffer.from(derived);
  }

  isEncryptedPayload(content?: string | null): boolean {
    return typeof content === 'string' && content.startsWith(this.ENVELOPE_PREFIX);
  }

  encryptForConversation(plainText: string, conversationId: string): EncryptedPayloadResult {
    if (!plainText) {
      return {
        ciphertext: plainText,
        isEncrypted: true,
        algorithm: 'AES-256-GCM',
      };
    }

    if (this.isEncryptedPayload(plainText)) {
      return {
        ciphertext: plainText,
        isEncrypted: true,
        algorithm: 'AES-256-GCM',
      };
    }

    const key = this.deriveConversationKey(conversationId);
    const iv = crypto.randomBytes(this.IV_LENGTH);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: this.AUTH_TAG_LENGTH,
    });
    cipher.setAAD(Buffer.from(conversationId, 'utf8'));

    const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    const envelope = `${this.ENVELOPE_PREFIX}${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;

    return {
      ciphertext: envelope,
      isEncrypted: true,
      algorithm: 'AES-256-GCM',
    };
  }

  decryptForConversation(cipherText: string | null | undefined, conversationId: string): string {
    if (!cipherText) return '';
    if (!this.isEncryptedPayload(cipherText)) {
      return cipherText;
    }

    try {
      const rawParts = cipherText.slice(this.ENVELOPE_PREFIX.length).split(':');
      if (rawParts.length !== 3) {
        return '[Tin nhắn không hợp lệ]';
      }

      const [ivB64, authTagB64, encryptedB64] = rawParts;
      const iv = Buffer.from(ivB64, 'base64');
      const authTag = Buffer.from(authTagB64, 'base64');
      const encrypted = Buffer.from(encryptedB64, 'base64');

      const key = this.deriveConversationKey(conversationId);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: this.AUTH_TAG_LENGTH,
      });
      decipher.setAAD(Buffer.from(conversationId, 'utf8'));
      decipher.setAuthTag(authTag);

      const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      return decrypted.toString('utf8');
    } catch (error: any) {
      this.logger.error(
        `Failed to decrypt message for conversation ${conversationId}: ${error?.message || error}`,
      );
      return '[Không thể giải mã tin nhắn]';
    }
  }

  generateIceServers(params: {
    userId: string;
    stunUrls: string[];
    turnUrls: string[];
    turnSecret: string;
    ttlSeconds?: number;
  }): { iceServers: TurnIceServerConfig[]; expiresAt: string } {
    const ttl = params.ttlSeconds || 86400;
    const unixExpiry = Math.floor(Date.now() / 1000) + ttl;
    const iceServers: TurnIceServerConfig[] = [];

    if (params.stunUrls.length > 0) {
      iceServers.push({ urls: params.stunUrls });
    }

    if (params.turnUrls.length > 0 && params.turnSecret) {
      const username = `${unixExpiry}:${params.userId}`;
      const credential = crypto
        .createHmac('sha1', params.turnSecret)
        .update(username)
        .digest('base64');

      iceServers.push({
        urls: params.turnUrls,
        username,
        credential,
      });
    }

    return {
      iceServers,
      expiresAt: new Date(unixExpiry * 1000).toISOString(),
    };
  }
}
