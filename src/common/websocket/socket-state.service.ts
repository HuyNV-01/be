import { Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';

@Injectable()
export class SocketStateService {
  private readonly logger = new Logger(SocketStateService.name);
  private readonly USER_SOCKETS_PREFIX = 'ws:user_sockets:';
  private readonly SOCKET_USER_PREFIX = 'ws:socket_user:';
  private readonly ONLINE_USERS_SET = 'ws:online_users';
  private readonly SOCKET_TTL_SECONDS = 86400; // 24 hours

  /**
   * L1 In-Memory Cache & Fallback State
   */
  private readonly localUserSockets = new Map<number, Set<string>>();
  private readonly localSocketUser = new Map<string, number>();
  private readonly presenceCache = new Map<number, { online: boolean; expiresAt: number }>();
  private readonly PRESENCE_CACHE_TTL_MS = 15_000; // 15s L1 cache

  constructor(@InjectRedis() private readonly redis: Redis) {}

  private setPresenceCache(userId: number, online: boolean): void {
    this.presenceCache.set(userId, {
      online,
      expiresAt: Date.now() + this.PRESENCE_CACHE_TTL_MS,
    });
  }

  async addSocket(userId: number, socketId: string): Promise<number> {
    // Cập nhật L1 Local State ngay lập tức
    const userSet = this.localUserSockets.get(userId) ?? new Set<string>();
    userSet.add(socketId);
    this.localUserSockets.set(userId, userSet);
    this.localSocketUser.set(socketId, userId);
    this.setPresenceCache(userId, true);

    try {
      const userSocketsKey = `${this.USER_SOCKETS_PREFIX}${userId}`;
      const socketUserKey = `${this.SOCKET_USER_PREFIX}${socketId}`;

      const pipeline = this.redis.pipeline();
      pipeline.sadd(userSocketsKey, socketId);
      pipeline.expire(userSocketsKey, this.SOCKET_TTL_SECONDS);
      pipeline.set(socketUserKey, String(userId), 'EX', this.SOCKET_TTL_SECONDS);
      pipeline.sadd(this.ONLINE_USERS_SET, String(userId));
      pipeline.scard(userSocketsKey);

      const results = await pipeline.exec();
      const activeCount = Number(results?.[4]?.[1] ?? userSet.size);
      return activeCount;
    } catch (error) {
      this.logger.warn(
        `[SocketState] Redis fallback on addSocket for user ${userId}: ${(error as Error).message}`,
      );
      return userSet.size;
    }
  }

  async removeSocket(
    socketId: string,
  ): Promise<{ userId: number | null; remainingConnections: number }> {
    const localUid = this.localSocketUser.get(socketId) ?? null;
    if (localUid !== null) {
      this.localSocketUser.delete(socketId);
      const set = this.localUserSockets.get(localUid);
      if (set) {
        set.delete(socketId);
        if (set.size === 0) {
          this.localUserSockets.delete(localUid);
          this.setPresenceCache(localUid, false);
        }
      }
    }

    try {
      const socketUserKey = `${this.SOCKET_USER_PREFIX}${socketId}`;
      const userIdStr = await this.redis.get(socketUserKey);

      const userId = userIdStr ? Number(userIdStr) : localUid;
      if (!userId || Number.isNaN(userId)) {
        return { userId: null, remainingConnections: 0 };
      }

      const userSocketsKey = `${this.USER_SOCKETS_PREFIX}${userId}`;
      const pipeline = this.redis.pipeline();
      pipeline.del(socketUserKey);
      pipeline.srem(userSocketsKey, socketId);
      pipeline.scard(userSocketsKey);

      const results = await pipeline.exec();
      const remaining = Number(results?.[2]?.[1] ?? 0);

      if (remaining <= 0) {
        await this.redis.srem(this.ONLINE_USERS_SET, String(userId));
        this.setPresenceCache(userId, false);
      } else {
        this.setPresenceCache(userId, true);
      }

      return { userId, remainingConnections: Math.max(0, remaining) };
    } catch (error) {
      this.logger.warn(
        `[SocketState] Redis fallback on removeSocket ${socketId}: ${(error as Error).message}`,
      );
      const remaining = localUid ? (this.localUserSockets.get(localUid)?.size ?? 0) : 0;
      return { userId: localUid, remainingConnections: remaining };
    }
  }

  async isUserOnline(userId: number): Promise<boolean> {
    const cached = this.presenceCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.online;
    }

    try {
      const isMember = await this.redis.sismember(this.ONLINE_USERS_SET, String(userId));
      const online = Boolean(isMember);
      this.setPresenceCache(userId, online);
      return online;
    } catch {
      return (this.localUserSockets.get(userId)?.size ?? 0) > 0;
    }
  }

  async getOnlineUsers(userIds?: number[]): Promise<number[]> {
    try {
      if (!userIds || userIds.length === 0) {
        const members = await this.redis.smembers(this.ONLINE_USERS_SET);
        return members.map((id) => Number(id)).filter((id) => !Number.isNaN(id));
      }

      const result: number[] = [];
      const uncachedIds: number[] = [];
      const now = Date.now();

      for (const uid of userIds) {
        const cached = this.presenceCache.get(uid);
        if (cached && cached.expiresAt > now) {
          if (cached.online) result.push(uid);
        } else {
          uncachedIds.push(uid);
        }
      }

      if (uncachedIds.length > 0) {
        const pipeline = this.redis.pipeline();
        uncachedIds.forEach((id) => pipeline.sismember(this.ONLINE_USERS_SET, String(id)));
        const res = await pipeline.exec();
        uncachedIds.forEach((uid, idx) => {
          const online = Boolean(res?.[idx]?.[1] === 1);
          this.setPresenceCache(uid, online);
          if (online) result.push(uid);
        });
      }

      return result;
    } catch {
      return Array.from(this.localUserSockets.keys());
    }
  }

  async getUserSockets(userId: number): Promise<string[]> {
    try {
      return await this.redis.smembers(`${this.USER_SOCKETS_PREFIX}${userId}`);
    } catch {
      return Array.from(this.localUserSockets.get(userId) ?? []);
    }
  }
}
