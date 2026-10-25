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
  private readonly USER_SOCKETS_PREFIX = 'ws:user_sockets:';
  private readonly SOCKET_USER_PREFIX = 'ws:socket_user:';
  private readonly ONLINE_USERS_SET = 'ws:online_users';
  private readonly E2EE_PUBLIC_KEY_PREFIX = 'ws:e2ee_pubkey:';
  private readonly SOCKET_TTL_SECONDS = 86400; // 24 hours
  private readonly MAX_SOCKETS_PER_USER = 10;

  /**
   * L1 In-Memory Cache & Fallback State
   */
  private readonly localUserSockets = new Map<string, Set<string>>();
  private readonly localSocketUser = new Map<string, string>();
  private readonly localPublicKeys = new Map<string, UserPublicKeyBundle>();
  private readonly presenceCache = new Map<string, { online: boolean; expiresAt: number }>();
  private readonly PRESENCE_CACHE_TTL_MS = 15_000;

  constructor(@InjectRedis() private readonly redis: Redis) {}

  private setPresenceCache(userId: string, online: boolean): void {
    this.presenceCache.set(userId, {
      online,
      expiresAt: Date.now() + this.PRESENCE_CACHE_TTL_MS,
    });
  }

  async add(userId: string, socketId: string): Promise<number> {
    return this.addSocket(userId, socketId);
  }

  async addSocket(userId: string, socketId: string): Promise<number> {
    const userSet = this.localUserSockets.get(userId) ?? new Set<string>();
    if (userSet.size >= this.MAX_SOCKETS_PER_USER) {
      const oldestSocketId = userSet.values().next().value;
      if (oldestSocketId) {
        userSet.delete(oldestSocketId);
        this.localSocketUser.delete(oldestSocketId);
      }
    }
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
      pipeline.set(socketUserKey, userId, 'EX', this.SOCKET_TTL_SECONDS);
      pipeline.sadd(this.ONLINE_USERS_SET, userId);
      pipeline.scard(userSocketsKey);

      const results = await pipeline.exec();
      return Number(results?.[4]?.[1] ?? userSet.size);
    } catch (error) {
      this.logger.warn(
        `[SocketState] Redis fallback on addSocket for user ${userId}: ${(error as Error).message}`,
      );
      return userSet.size;
    }
  }

  /**
   * Xóa kết nối socket và trả về true nếu user đã offline hoàn toàn (không còn tab/thiết bị nào mở)
   */
  async remove(userId: string, socketId: string): Promise<boolean> {
    const { remainingConnections } = await this.removeSocket(socketId, userId);
    return remainingConnections <= 0;
  }

  async removeSocket(
    socketId: string,
    knownUserId?: string,
  ): Promise<{ userId: string | null; remainingConnections: number }> {
    const localUid = knownUserId ?? this.localSocketUser.get(socketId) ?? null;
    if (localUid) {
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
      const userId = knownUserId || (await this.redis.get(socketUserKey)) || localUid;

      if (!userId) {
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
        await this.redis.srem(this.ONLINE_USERS_SET, userId);
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

  /**
   * Gia hạn TTL cho phiên kết nối khi nhận được Heartbeat
   */
  async refreshHeartbeat(userId: string, socketId: string): Promise<void> {
    this.setPresenceCache(userId, true);
    try {
      const userSocketsKey = `${this.USER_SOCKETS_PREFIX}${userId}`;
      const socketUserKey = `${this.SOCKET_USER_PREFIX}${socketId}`;

      await this.redis
        .pipeline()
        .sadd(userSocketsKey, socketId)
        .expire(userSocketsKey, this.SOCKET_TTL_SECONDS)
        .set(socketUserKey, userId, 'EX', this.SOCKET_TTL_SECONDS)
        .sadd(this.ONLINE_USERS_SET, userId)
        .exec();
    } catch (error) {
      this.logger.debug(`Heartbeat Redis refresh skipped: ${(error as Error).message}`);
    }
  }

  async getSocketIds(userId: string): Promise<string[]> {
    return this.getUserSockets(userId);
  }

  async getUserSockets(userId: string): Promise<string[]> {
    try {
      return await this.redis.smembers(`${this.USER_SOCKETS_PREFIX}${userId}`);
    } catch {
      return Array.from(this.localUserSockets.get(userId) ?? []);
    }
  }

  async isUserOnline(userId: string): Promise<boolean> {
    const cached = this.presenceCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.online;
    }

    try {
      const isMember = await this.redis.sismember(this.ONLINE_USERS_SET, userId);
      const online = Boolean(isMember);
      this.setPresenceCache(userId, online);
      return online;
    } catch {
      return (this.localUserSockets.get(userId)?.size ?? 0) > 0;
    }
  }

  /**
   * Trả về Set<string> các userId đang online để tra cứu O(1) với `.has()`
   */
  async getOnlineUsers(userIds?: string[]): Promise<Set<string>> {
    try {
      if (!userIds || userIds.length === 0) {
        const members = await this.redis.smembers(this.ONLINE_USERS_SET);
        return new Set(members.filter(Boolean));
      }

      const result = new Set<string>();
      const uncachedIds: string[] = [];
      const now = Date.now();

      for (const uid of userIds) {
        const cached = this.presenceCache.get(uid);
        if (cached && cached.expiresAt > now) {
          if (cached.online) result.add(uid);
        } else {
          uncachedIds.push(uid);
        }
      }

      if (uncachedIds.length > 0) {
        const pipeline = this.redis.pipeline();
        uncachedIds.forEach((id) => pipeline.sismember(this.ONLINE_USERS_SET, id));
        const res = await pipeline.exec();
        uncachedIds.forEach((uid, idx) => {
          const online = Boolean(res?.[idx]?.[1] === 1);
          this.setPresenceCache(uid, online);
          if (online) result.add(uid);
        });
      }

      return result;
    } catch {
      const fallback = new Set<string>();
      for (const [uid, sockets] of this.localUserSockets.entries()) {
        if (sockets.size > 0 && (!userIds || userIds.includes(uid))) {
          fallback.add(uid);
        }
      }
      return fallback;
    }
  }

  /**
   * Lưu trữ và truy xuất khóa công khai E2EE của người dùng
   */
  async setPublicKeyBundle(bundle: UserPublicKeyBundle): Promise<void> {
    this.localPublicKeys.set(bundle.userId, bundle);
    try {
      await this.redis.set(
        `${this.E2EE_PUBLIC_KEY_PREFIX}${bundle.userId}`,
        JSON.stringify(bundle),
        'EX',
        86400 * 30, // Lưu 30 ngày
      );
    } catch (error) {
      this.logger.warn(`Failed to persist E2EE key in Redis: ${(error as Error).message}`);
    }
  }

  async getPublicKeyBundles(userIds: string[]): Promise<Record<string, UserPublicKeyBundle>> {
    const result: Record<string, UserPublicKeyBundle> = {};
    if (!userIds || userIds.length === 0) return result;

    try {
      const keys = userIds.map((id) => `${this.E2EE_PUBLIC_KEY_PREFIX}${id}`);
      const values = await this.redis.mget(...keys);

      values.forEach((raw, idx) => {
        const uid = userIds[idx];
        if (raw) {
          try {
            result[uid] = JSON.parse(raw) as UserPublicKeyBundle;
          } catch {
            // Bỏ qua JSON lỗi
          }
        } else if (this.localPublicKeys.has(uid)) {
          result[uid] = this.localPublicKeys.get(uid)!;
        }
      });
    } catch {
      userIds.forEach((uid) => {
        const local = this.localPublicKeys.get(uid);
        if (local) result[uid] = local;
      });
    }

    return result;
  }
}
