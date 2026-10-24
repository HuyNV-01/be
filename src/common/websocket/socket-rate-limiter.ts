import { Injectable, Logger } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  points: number;
  windowMs: number;
}

@Injectable()
export class SocketRateLimiter {
  private readonly logger = new Logger(SocketRateLimiter.name);
  private readonly buckets = new Map<string, RateLimitBucket>();

  private readonly defaultRules: Record<string, RateLimitRule> = {
    send_message: { points: 30, windowMs: 10_000 },
    edit_message: { points: 15, windowMs: 10_000 },
    react_message: { points: 40, windowMs: 10_000 },
    typing: { points: 40, windowMs: 10_000 },
    'call:initiate': { points: 5, windowMs: 15_000 },
    'call:signal': { points: 150, windowMs: 10_000 },
    default: { points: 60, windowMs: 10_000 },
  };

  consume(userId: string, eventName: string, customRule?: RateLimitRule): void {
    const rule = customRule || this.defaultRules[eventName] || this.defaultRules.default;
    const key = `${userId}:${eventName}`;
    const now = Date.now();

    const bucket = this.buckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(key, {
        count: 1,
        resetAt: now + rule.windowMs,
      });
      return;
    }

    bucket.count += 1;
    if (bucket.count > rule.points) {
      this.logger.warn(`Rate limit exceeded for user ${userId} on event "${eventName}"`);
      throw new WsException({
        status: 429,
        code: 'SOCKET_RATE_LIMIT_EXCEEDED',
        message: `Too many "${eventName}" requests. Please slow down.`,
        retryAfterMs: bucket.resetAt - now,
      });
    }
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
      }
    }
  }
}
