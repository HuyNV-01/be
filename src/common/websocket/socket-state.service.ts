import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

export interface UserPublicKeyBundle {
  userId: string;
  publicKey: string;
  algorithm: string;
  keyId: string;
  updatedAt: string;
}

@Injectable()
export class SocketStateService {
  private readonly logger = new Logger(SocketStateService.name);
  private readonly REDIS_PREFIX = 'socket_user:';
  private readonly LAST_SEEN_PREFIX = 'socket_last_seen:';
  private readonly E2EE_KEY_PREFIX = 'chat_e2ee_pubkey:';
  private readonly SOCKET_TTL_SECONDS = 120;

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async add(userId: string, socketId: string): Promise<boolean> {
    const key = `${this.REDIS_PREFIX}${userId}`;
    await this.redis
      .multi()
      .sadd(key, socketId)
      .expire(key, this.SOCKET_TTL_SECONDS)
      .set(`${this.LAST_SEEN_PREFIX}${userId}`, new Date().toISOString())
      .exec();
    return true;
  }

  async refreshHeartbeat(userId: string, socketId: string): Promise<void> {
    const key = `${this.REDIS_PREFIX}${userId}`;
    await this.redis
      .multi()
      .sadd(key, socketId)
      .expire(key, this.SOCKET_TTL_SECONDS)
      .set(`${this.LAST_SEEN_PREFIX}${userId}`, new Date().toISOString())
      .exec();
  }

  async remove(userId: string, socketId: string): Promise<boolean> {
    const key = `${this.REDIS_PREFIX}${userId}`;
    await this.redis.srem(key, socketId);
    await this.redis.set(`${this.LAST_SEEN_PREFIX}${userId}`, new Date().toISOString());

    const count = await this.redis.scard(key);
    if (count === 0) {
      await this.redis.del(key);
      return true;
    }
    return false;
  }

  async isOnline(userId: string): Promise<boolean> {
    const exists = await this.redis.exists(`${this.REDIS_PREFIX}${userId}`);
    return exists > 0;
  }

  async getLastSeen(userId: string): Promise<string | null> {
    return this.redis.get(`${this.LAST_SEEN_PREFIX}${userId}`);
  }

  async getSocketIds(userId: string): Promise<string[]> {
    return this.redis.smembers(`${this.REDIS_PREFIX}${userId}`);
  }

  async getOnlineUsers(userIds: string[]): Promise<Set<string>> {
    if (!userIds || userIds.length === 0) return new Set();

    const uniqueIds = [...new Set(userIds)];
    const pipeline = this.redis.pipeline();

    uniqueIds.forEach((id) => pipeline.exists(`${this.REDIS_PREFIX}${id}`));
    const results = await pipeline.exec();

    const onlineSet = new Set<string>();
    results?.forEach(([_err, count], index) => {
      if (count === 1) onlineSet.add(uniqueIds[index]);
    });

    return onlineSet;
  }

  async setPublicKeyBundle(bundle: UserPublicKeyBundle): Promise<void> {
    await this.redis.set(`${this.E2EE_KEY_PREFIX}${bundle.userId}`, JSON.stringify(bundle));
  }

  async getPublicKeyBundles(userIds: string[]): Promise<Record<string, UserPublicKeyBundle>> {
    if (!userIds.length) return {};
    const uniqueIds = [...new Set(userIds)];
    const keys = uniqueIds.map((id) => `${this.E2EE_KEY_PREFIX}${id}`);
    const values = await this.redis.mget(...keys);

    const map: Record<string, UserPublicKeyBundle> = {};
    values.forEach((raw, idx) => {
      if (raw) {
        try {
          map[uniqueIds[idx]] = JSON.parse(raw) as UserPublicKeyBundle;
        } catch {
          this.logger.warn(`Failed to parse E2EE public key bundle for user ${uniqueIds[idx]}`);
        }
      }
    });
    return map;
  }
}
