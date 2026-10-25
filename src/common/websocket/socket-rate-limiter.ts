import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

export interface RateLimitRule {
  points: number;
  windowMs: number;
}

@Injectable()
export class SocketRateLimiter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SocketRateLimiter.name);
  private readonly buckets = new Map<string, RateLimitBucket>();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly REDIS_PREFIX = 'ws:rl:';

  private readonly defaultRules: Record<string, RateLimitRule> = {
    join_room: { points: 30, windowMs: 10_000 },
    leave_room: { points: 30, windowMs: 10_000 },
    send_message: { points: 25, windowMs: 10_000 },
    edit_message: { points: 15, windowMs: 10_000 },
    recall_message: { points: 15, windowMs: 10_000 },
    react_message: { points: 45, windowMs: 10_000 },
    pin_message: { points: 15, windowMs: 10_000 },
    typing: { points: 40, windowMs: 10_000 },
    mark_read: { points: 45, windowMs: 10_000 },
    message_received: { points: 120, windowMs: 10_000 },
    'e2ee:register_key': { points: 10, windowMs: 60_000 },
    'call:initiate': { points: 6, windowMs: 15_000 },
    'call:accept': { points: 12, windowMs: 10_000 },
    'call:reject': { points: 12, windowMs: 10_000 },
    'call:hangup': { points: 15, windowMs: 10_000 },
    'call:media_state': { points: 50, windowMs: 10_000 },
    'call:signal': { points: 300, windowMs: 10_000 },
    default: { points: 60, windowMs: 10_000 },
  };

  constructor(@InjectRedis() private readonly redis?: Redis) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpired();
    }, 60_000);
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

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
    } else {
      bucket.count += 1;
      if (bucket.count > rule.points) {
        this.logger.warn(`Rate limit exceeded for user ${userId} on event "${eventName}"`);
        throw new WsException({
          status: 429,
          code: 'SOCKET_RATE_LIMIT_EXCEEDED',
          message: `Thao tác "${eventName}" quá nhanh. Vui lòng thử lại sau giây lát.`,
          retryAfterMs: bucket.resetAt - now,
        });
      }
    }

    if (this.redis) {
      const redisKey = `${this.REDIS_PREFIX}${key}`;
      this.redis
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, rule.windowMs, 'NX')
        .exec()
        .then((res) => {
          const globalCount = Number(res?.[0]?.[1] ?? 1);
          if (globalCount > rule.points && bucket) {
            bucket.count = globalCount;
          }
        })
        .catch(() => undefined);
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
