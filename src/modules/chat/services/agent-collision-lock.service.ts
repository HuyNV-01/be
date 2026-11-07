import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { UserEntity } from 'src/entity/user.entity';
import { GranularIamService } from 'src/modules/iam/iam.service';
import { Repository } from 'typeorm';

export interface ActiveCollisionLockPayload {
  conversationId: string;
  holderAgentId: string;
  holderAgentName: string;
  holderAgentAvatar: string | null;
  lockedAt: string;
  expiresAt: string;
}

@Injectable()
export class AgentCollisionLockService {
  private readonly LOCK_PREFIX = 'chat:collision_lock:';
  private readonly LOCK_TTL_SECONDS = 35;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(UserEntity)
    private readonly userRepo: Repository<UserEntity>,
    private readonly granularIamService: GranularIamService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  private buildLockKey(conversationId: string): string {
    return `${this.LOCK_PREFIX}${conversationId}`;
  }

  async acquireOrHeartbeatLock(params: { conversationId: string; userId: string }): Promise<{
    isLockedByOther: boolean;
    lock: ActiveCollisionLockPayload;
  }> {
    const key = this.buildLockKey(params.conversationId);
    const existingRaw = await this.redis.get(key);

    if (existingRaw) {
      try {
        const existing = JSON.parse(existingRaw) as ActiveCollisionLockPayload;
        if (existing.holderAgentId !== params.userId) {
          return {
            isLockedByOther: true,
            lock: existing,
          };
        }
      } catch {
        // Ignore malformed lock
      }
    }

    const user = await this.userRepo.findOne({
      where: { id: params.userId },
      select: ['id', 'name', 'email'],
    });

    const now = new Date();
    const lockPayload: ActiveCollisionLockPayload = {
      conversationId: params.conversationId,
      holderAgentId: params.userId,
      holderAgentName: user?.name || user?.email || 'Nhân viên tư vấn',
      holderAgentAvatar: null,
      lockedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.LOCK_TTL_SECONDS * 1000).toISOString(),
    };

    await this.redis.set(key, JSON.stringify(lockPayload), 'EX', this.LOCK_TTL_SECONDS);

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      params.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.AGENT_COLLISION_LOCK,
      lockPayload,
    );

    return {
      isLockedByOther: false,
      lock: lockPayload,
    };
  }

  async getLockStatus(conversationId: string): Promise<ActiveCollisionLockPayload | null> {
    const raw = await this.redis.get(this.buildLockKey(conversationId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ActiveCollisionLockPayload;
    } catch {
      return null;
    }
  }

  async releaseLock(params: {
    conversationId: string;
    userId: string;
  }): Promise<{ released: boolean }> {
    const key = this.buildLockKey(params.conversationId);
    const existing = await this.getLockStatus(params.conversationId);

    if (!existing || existing.holderAgentId !== params.userId) {
      return { released: false };
    }

    await this.redis.del(key);

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      params.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.AGENT_COLLISION_UNLOCK,
      {
        conversationId: params.conversationId,
        releasedByUserId: params.userId,
      },
    );

    return { released: true };
  }

  async forceTakeOverLock(params: {
    shopId: string;
    conversationId: string;
    requesterUserId: string;
  }): Promise<ActiveCollisionLockPayload> {
    const memberCtx = await this.granularIamService.getEffectiveMemberContext(
      params.shopId,
      params.requesterUserId,
    );

    if (!memberCtx.permissions.includes(PermissionCodeEnum.INBOX_COLLISION_FORCE_TAKEOVER)) {
      throw new ForbiddenException('INSUFFICIENT_PERMISSION_TO_TAKEOVER_CONVERSATION');
    }

    const user = await this.userRepo.findOne({
      where: { id: params.requesterUserId },
      select: ['id', 'name', 'email'],
    });

    const now = new Date();
    const lockPayload: ActiveCollisionLockPayload = {
      conversationId: params.conversationId,
      holderAgentId: params.requesterUserId,
      holderAgentName: user?.name || user?.email || 'Quản lý',
      holderAgentAvatar: null,
      lockedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.LOCK_TTL_SECONDS * 1000).toISOString(),
    };

    await this.redis.set(
      this.buildLockKey(params.conversationId),
      JSON.stringify(lockPayload),
      'EX',
      this.LOCK_TTL_SECONDS,
    );

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      params.conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.AGENT_COLLISION_LOCK,
      {
        ...lockPayload,
        isForcedTakeOver: true,
      },
    );

    return lockPayload;
  }
}
