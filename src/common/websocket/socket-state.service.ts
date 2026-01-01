/* eslint-disable @typescript-eslint/no-unused-vars */
// src/common/websocket/services/socket-state.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class SocketStateService {
  private readonly logger = new Logger(SocketStateService.name);
  private readonly REDIS_PREFIX = 'socket_user:';

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async add(userId: string, socketId: string): Promise<boolean> {
    const key = `${this.REDIS_PREFIX}${userId}`;
    await this.redis.sadd(key, socketId);
    return true;
  }

  async remove(userId: string, socketId: string): Promise<boolean> {
    const key = `${this.REDIS_PREFIX}${userId}`;
    await this.redis.srem(key, socketId);

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
}
