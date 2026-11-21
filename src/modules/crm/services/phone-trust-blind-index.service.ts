import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import * as net from 'net';
import { envs } from 'src/config/envs/envs';

/**
 * Provides cross-tenant cryptographic phone normalization, global blind indexing,
 * SSRF validation for shop-supplied webhook URLs, and a Redis-backed circuit breaker
 * so slow or degraded external 3PL/aggregator APIs never stall chat message ingestion.
 */
@Injectable()
export class PhoneTrustBlindIndexService {
  private readonly logger = new Logger(PhoneTrustBlindIndexService.name);

  constructor(@InjectRedis() private readonly redis: Redis) {}

  public normalizeVietnamesePhone(rawPhone?: string | null): string {
    const digits = String(rawPhone || '').replace(/\D/g, '');
    if (digits.startsWith('84') && digits.length === 11) {
      return `0${digits.slice(2)}`;
    }
    if (digits.startsWith('0084') && digits.length === 13) {
      return `0${digits.slice(4)}`;
    }
    return digits;
  }

  public isValidVietnamesePhone(normalizedPhone: string): boolean {
    return /^0(?:3|5|7|8|9)\d{8}$/.test(normalizedPhone) || /^02\d{8,9}$/.test(normalizedPhone);
  }

  public maskPhone(rawPhone?: string | null): string {
    const normalized = this.normalizeVietnamesePhone(rawPhone);
    if (normalized.length < 7) {
      return '***';
    }
    return `${normalized.slice(0, 3)}***${normalized.slice(-3)}`;
  }

  /**
   * Computes a platform-wide blind index separated from shop-specific PII salts,
   * allowing multi-tenant reputation aggregation without storing plaintext phone numbers
   * in consortium tables.
   */
  public computeGlobalPhoneHash(rawPhone: string): string {
    const normalized = this.normalizeVietnamesePhone(rawPhone);
    return crypto
      .createHmac('sha256', envs.phoneTrust.globalBlindPepper)
      .update(normalized)
      .digest('hex');
  }

  public computeRawSha256(rawPhone: string): string {
    const normalized = this.normalizeVietnamesePhone(rawPhone);
    return crypto.createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Blocks private, loopback, and link-local destinations so sellers cannot abuse
   * custom lookup webhook settings to probe internal cloud metadata or LAN services.
   */
  public assertSafeExternalWebhookUrl(rawUrl: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl.trim());
    } catch {
      throw new Error('INVALID_EXTERNAL_WEBHOOK_URL');
    }

    if (parsed.protocol !== 'https:' && (envs.isProduction || parsed.protocol !== 'http:')) {
      throw new Error('EXTERNAL_WEBHOOK_MUST_USE_HTTPS');
    }

    const hostname = parsed.hostname.toLowerCase();
    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname === 'metadata.google.internal'
    ) {
      throw new Error('EXTERNAL_WEBHOOK_PRIVATE_HOST_BLOCKED');
    }

    if (net.isIP(hostname)) {
      if (this.isPrivateIpAddress(hostname)) {
        throw new Error('EXTERNAL_WEBHOOK_PRIVATE_IP_BLOCKED');
      }
    }

    return parsed;
  }

  private isPrivateIpAddress(ip: string): boolean {
    if (ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:')) {
      return true;
    }
    const octets = ip.split('.').map((part) => Number(part));
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n))) {
      return true;
    }
    const [a, b] = octets;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  public async isCircuitOpen(providerKey: string): Promise<boolean> {
    try {
      const openFlag = await this.redis.get(`trust:cb:open:${providerKey}`);
      return openFlag === '1';
    } catch {
      return false;
    }
  }

  public async recordProviderSuccess(providerKey: string): Promise<void> {
    try {
      await this.redis.del(`trust:cb:fail:${providerKey}`, `trust:cb:open:${providerKey}`);
    } catch {
      // Cache failure must not interrupt trust lookup pipeline.
    }
  }

  public async recordProviderFailure(providerKey: string): Promise<void> {
    try {
      const failKey = `trust:cb:fail:${providerKey}`;
      const failures = await this.redis.incr(failKey);
      if (failures === 1) {
        await this.redis.expire(failKey, envs.phoneTrust.circuitBreakerCooldownSeconds * 2);
      }
      if (failures >= envs.phoneTrust.circuitBreakerFailureThreshold) {
        await this.redis.set(
          `trust:cb:open:${providerKey}`,
          '1',
          'EX',
          envs.phoneTrust.circuitBreakerCooldownSeconds,
        );
        this.logger.warn(
          `Circuit breaker opened for trust provider "${providerKey}" after ${failures} consecutive failures`,
        );
      }
    } catch {
      // Cache failure must not interrupt trust lookup pipeline.
    }
  }
}
