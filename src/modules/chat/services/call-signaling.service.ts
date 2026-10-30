/* eslint-disable @typescript-eslint/no-misused-promises */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { CallStatusEnum, CallTypeEnum } from 'src/common/enum';
import {
  CallParticipantEntity,
  CallParticipantStatusEnum,
} from 'src/entity/call-participant.entity';
import { CallSessionEntity } from 'src/entity/call-session.entity';
import { Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

export interface CallParticipantState {
  userId: string;
  joinedAt: string;
  leftAt?: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  isHandRaised?: boolean;
  raisedHandAt?: string | null;
}

export interface ActiveCallSession {
  callId: string;
  conversationId: string;
  callType: CallTypeEnum;
  isGroupCall: boolean;
  topology: 'MESH' | 'SFU';
  initiatorId: string;
  invitedUserIds: string[];
  status: CallStatusEnum;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
  maxConcurrentParticipants: number;
  participants: Record<string, CallParticipantState>;
}

@Injectable()
export class CallSignalingService {
  private readonly logger = new Logger(CallSignalingService.name);
  private readonly CALL_KEY_PREFIX = 'webrtc_call_session:';
  private readonly USER_CALL_PREFIX = 'webrtc_user_active_call:';
  private readonly CONV_CALL_PREFIX = 'webrtc_conv_active_call:';
  private readonly CALL_TTL_SECONDS = 3600 * 4; // Tối đa 4 giờ
  private readonly RINGING_TIMEOUT_MS = 60_000; // Tự giải phóng nếu đổ chuông > 60s
  private readonly ringingTimers = new Map<string, NodeJS.Timeout>();
  private readonly SAFE_DEL_USER_CALL_LUA = `
    for i = 1, #KEYS do
      if redis.call("GET", KEYS[i]) == ARGV[1] then
        redis.call("DEL", KEYS[i])
      end
    end
    return 1
  `;

  private readonly ATOMIC_UPDATE_PARTICIPANT_LUA = `
    local raw = redis.call("GET", KEYS[1])
    if not raw then return nil end
    local session = cjson.decode(raw)
    local userId = ARGV[1]
    local patch = cjson.decode(ARGV[2])
    local ttl = tonumber(ARGV[3])

    if not session.participants or not session.participants[userId] then
      return nil
    end

    local p = session.participants[userId]
    if patch.isAudioMuted ~= nil then p.isAudioMuted = patch.isAudioMuted end
    if patch.isVideoOff ~= nil then
      p.isVideoOff = patch.isVideoOff
      if patch.isVideoOff == false and session.callType == "AUDIO" then
        session.callType = "VIDEO"
      end
    end
    if patch.isScreenSharing ~= nil then p.isScreenSharing = patch.isScreenSharing end
    if patch.isHandRaised ~= nil then
      p.isHandRaised = patch.isHandRaised
      p.raisedHandAt = patch.raisedHandAt
    end

    session.participants[userId] = p
    local updatedRaw = cjson.encode(session)
    redis.call("SET", KEYS[1], updatedRaw, "EX", ttl)
    return updatedRaw
  `;

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(CallSessionEntity)
    private readonly callSessionRepo: Repository<CallSessionEntity>,
    @InjectRepository(CallParticipantEntity)
    private readonly callParticipantRepo: Repository<CallParticipantEntity>,
  ) {}

  private async safeDeleteUserCallKeys(userIds: string[], callId: string): Promise<void> {
    if (!userIds.length) return;
    const keys = [...new Set(userIds)].map((uid) => `${this.USER_CALL_PREFIX}${uid}`);
    await this.redis.eval(this.SAFE_DEL_USER_CALL_LUA, keys.length, ...keys, callId);
  }

  private isStaleRingingSession(session: ActiveCallSession): boolean {
    if (session.status !== CallStatusEnum.RINGING) return false;
    const elapsed = Date.now() - new Date(session.createdAt).getTime();
    return elapsed > this.RINGING_TIMEOUT_MS;
  }

  scheduleRingingTimeout(
    callId: string,
    onTimeout: (session: ActiveCallSession) => Promise<void>,
  ): void {
    this.clearRingingTimeout(callId);
    const timer = setTimeout(async () => {
      this.ringingTimers.delete(callId);
      try {
        const session = await this.getCallSession(callId);
        if (session && session.status === CallStatusEnum.RINGING) {
          await onTimeout(session);
        }
      } catch (err) {
        this.logger.error(`Ringing timeout error for call ${callId}: ${(err as Error).message}`);
      }
    }, this.RINGING_TIMEOUT_MS);

    this.ringingTimers.set(callId, timer);
  }

  clearRingingTimeout(callId: string): void {
    const timer = this.ringingTimers.get(callId);
    if (timer) {
      clearTimeout(timer);
      this.ringingTimers.delete(callId);
    }
  }

  async initiateCall(params: {
    conversationId: string;
    initiatorId: string;
    memberIds: string[];
    callType: CallTypeEnum;
    isGroupCall?: boolean;
  }): Promise<{
    session: ActiveCallSession;
    busyUserIds: string[];
    ringingUserIds: string[];
    isJoinedExisting: boolean;
  }> {
    // Nếu phòng chat nhóm đang có cuộc gọi diễn ra, cho phép join vào luôn
    const existingConvCallId = await this.redis.get(
      `${this.CONV_CALL_PREFIX}${params.conversationId}`,
    );
    if (existingConvCallId) {
      const existingConvSession = await this.getCallSession(existingConvCallId);
      if (
        existingConvSession &&
        !this.isStaleRingingSession(existingConvSession) &&
        (existingConvSession.status === CallStatusEnum.ONGOING ||
          existingConvSession.status === CallStatusEnum.RINGING)
      ) {
        const accepted = await this.acceptCall(existingConvCallId, params.initiatorId);
        return {
          session: accepted,
          busyUserIds: [],
          ringingUserIds: [],
          isJoinedExisting: true,
        };
      }
    }

    const existingCallerCallId = await this.redis.get(
      `${this.USER_CALL_PREFIX}${params.initiatorId}`,
    );
    if (existingCallerCallId) {
      const existingCall = await this.getCallSession(existingCallerCallId);
      if (existingCall && !this.isStaleRingingSession(existingCall)) {
        throw new BadRequestException('Bạn đang ở trong một cuộc gọi khác');
      }
      await this.forceCleanupSession(existingCallerCallId, params.initiatorId);
    }

    const targetIds = params.memberIds.filter((id) => id !== params.initiatorId);
    const busyUserIds: string[] = [];
    const ringingUserIds: string[] = [];

    for (const targetId of targetIds) {
      const activeCallId = await this.redis.get(`${this.USER_CALL_PREFIX}${targetId}`);
      if (activeCallId) {
        const activeSession = await this.getCallSession(activeCallId);
        if (activeSession && !this.isStaleRingingSession(activeSession)) {
          busyUserIds.push(targetId);
          continue;
        }
        await this.forceCleanupSession(activeCallId, targetId);
      }
      ringingUserIds.push(targetId);
    }

    const callId = uuidv4();
    const now = new Date().toISOString();
    const isGroupCall = params.isGroupCall ?? targetIds.length > 1;

    const topology: 'MESH' | 'SFU' = targetIds.length + 1 > 6 ? 'SFU' : 'MESH';

    const session: ActiveCallSession = {
      callId,
      conversationId: params.conversationId,
      callType: params.callType,
      isGroupCall,
      topology,
      initiatorId: params.initiatorId,
      invitedUserIds: targetIds,
      status: ringingUserIds.length > 0 ? CallStatusEnum.RINGING : CallStatusEnum.BUSY,
      createdAt: now,
      maxConcurrentParticipants: 1,
      participants: {
        [params.initiatorId]: {
          userId: params.initiatorId,
          joinedAt: now,
          isAudioMuted: false,
          isVideoOff: params.callType === CallTypeEnum.AUDIO,
          isScreenSharing: false,
          isHandRaised: false,
          raisedHandAt: null,
        },
      },
    };

    if (ringingUserIds.length > 0) {
      await this.redis
        .multi()
        .set(
          `${this.CALL_KEY_PREFIX}${callId}`,
          JSON.stringify(session),
          'EX',
          this.CALL_TTL_SECONDS,
        )
        .set(`${this.USER_CALL_PREFIX}${params.initiatorId}`, callId, 'EX', this.CALL_TTL_SECONDS)
        .set(
          `${this.CONV_CALL_PREFIX}${params.conversationId}`,
          callId,
          'EX',
          this.CALL_TTL_SECONDS,
        )
        .exec();

      // Lưu bản ghi khởi tạo vào Database
      await this.callSessionRepo
        .save(
          this.callSessionRepo.create({
            id: callId,
            conversationId: params.conversationId,
            initiatorId: params.initiatorId,
            callType: params.callType,
            status: CallStatusEnum.RINGING,
            isGroupCall,
            topology,
            maxConcurrentParticipants: 1,
            invitedUserIds: targetIds,
            participants: session.participants,
          }),
        )
        .then(async () => {
          const partEntities = [
            this.callParticipantRepo.create({
              callId,
              conversationId: params.conversationId,
              userId: params.initiatorId,
              status: CallParticipantStatusEnum.JOINED,
              joinedAt: new Date(now),
            }),
            ...targetIds.map((uid) =>
              this.callParticipantRepo.create({
                callId,
                conversationId: params.conversationId,
                userId: uid,
                status: ringingUserIds.includes(uid)
                  ? CallParticipantStatusEnum.INVITED
                  : CallParticipantStatusEnum.BUSY,
              }),
            ),
          ];
          await this.callParticipantRepo.save(partEntities);
        })
        .catch((err) => this.logger.warn(`DB save call session warning: ${err.message}`));
    }

    return { session, busyUserIds, ringingUserIds, isJoinedExisting: false };
  }

  async getCallSession(callId: string): Promise<ActiveCallSession | null> {
    const raw = await this.redis.get(`${this.CALL_KEY_PREFIX}${callId}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ActiveCallSession;
    } catch {
      return null;
    }
  }

  async getActiveCallByConversation(conversationId: string): Promise<ActiveCallSession | null> {
    const callId = await this.redis.get(`${this.CONV_CALL_PREFIX}${conversationId}`);
    if (!callId) return null;
    const session = await this.getCallSession(callId);
    if (!session || this.isStaleRingingSession(session)) return null;
    return session;
  }

  async getActiveCallIdByUser(userId: string): Promise<string | null> {
    return this.redis.get(`${this.USER_CALL_PREFIX}${userId}`);
  }

  private async forceCleanupSession(callId: string, userId: string): Promise<void> {
    this.clearRingingTimeout(callId);
    const session = await this.getCallSession(callId);
    const keys = [`${this.CALL_KEY_PREFIX}${callId}`, `${this.USER_CALL_PREFIX}${userId}`];
    if (session?.conversationId) {
      keys.push(`${this.CONV_CALL_PREFIX}${session.conversationId}`);
    }
    await this.redis.del(...keys);
  }

  async acceptCall(callId: string, userId: string): Promise<ActiveCallSession> {
    const session = await this.getCallSession(callId);
    if (!session) {
      throw new BadRequestException('Phiên cuộc gọi đã hết hạn hoặc đã kết thúc');
    }

    if (session.initiatorId !== userId && !session.invitedUserIds.includes(userId)) {
      throw new ForbiddenException('Bạn không nằm trong danh sách tham gia cuộc gọi này');
    }

    this.clearRingingTimeout(callId);

    const now = new Date().toISOString();
    if (!session.answeredAt) {
      session.answeredAt = now;
    }
    session.status = CallStatusEnum.ONGOING;
    session.participants[userId] = {
      userId,
      joinedAt: now,
      isAudioMuted: false,
      isVideoOff: session.callType === CallTypeEnum.AUDIO,
      isScreenSharing: false,
    };

    const activeCount = Object.keys(session.participants).length;
    session.maxConcurrentParticipants = Math.max(
      session.maxConcurrentParticipants || 1,
      activeCount,
    );
    if (activeCount > 6) {
      session.topology = 'SFU';
    }

    await this.redis
      .multi()
      .set(`${this.CALL_KEY_PREFIX}${callId}`, JSON.stringify(session), 'EX', this.CALL_TTL_SECONDS)
      .set(`${this.USER_CALL_PREFIX}${userId}`, callId, 'EX', this.CALL_TTL_SECONDS)
      .set(`${this.CONV_CALL_PREFIX}${session.conversationId}`, callId, 'EX', this.CALL_TTL_SECONDS)
      .exec();

    await this.callSessionRepo
      .update(callId, {
        status: CallStatusEnum.ONGOING,
        answeredAt: new Date(session.answeredAt),
        participants: session.participants as any,
      })
      .catch(() => undefined);

    await this.callParticipantRepo
      .upsert(
        {
          callId,
          conversationId: session.conversationId,
          userId,
          status: CallParticipantStatusEnum.JOINED,
          joinedAt: new Date(now),
          leftAt: null,
        },
        ['callId', 'userId'],
      )
      .catch(() => undefined);

    return session;
  }

  async updateMediaState(params: {
    callId: string;
    userId: string;
    isAudioMuted?: boolean;
    isVideoOff?: boolean;
    isScreenSharing?: boolean;
    isHandRaised?: boolean;
  }): Promise<ActiveCallSession> {
    const patchPayload = JSON.stringify({
      ...(params.isAudioMuted !== undefined ? { isAudioMuted: params.isAudioMuted } : {}),
      ...(params.isVideoOff !== undefined ? { isVideoOff: params.isVideoOff } : {}),
      ...(params.isScreenSharing !== undefined ? { isScreenSharing: params.isScreenSharing } : {}),
      ...(params.isHandRaised !== undefined
        ? {
            isHandRaised: params.isHandRaised,
            raisedHandAt: params.isHandRaised ? new Date().toISOString() : null,
          }
        : {}),
    });

    const updatedRaw = (await this.redis.eval(
      this.ATOMIC_UPDATE_PARTICIPANT_LUA,
      1,
      `${this.CALL_KEY_PREFIX}${params.callId}`,
      params.userId,
      patchPayload,
      String(this.CALL_TTL_SECONDS),
    )) as string | null;

    if (!updatedRaw) {
      throw new BadRequestException('Không tìm thấy thành viên trong cuộc gọi');
    }

    return JSON.parse(updatedRaw) as ActiveCallSession;
  }

  async hostMuteParticipant(params: {
    callId: string;
    requesterId: string;
    targetUserId: string;
    isRequesterGroupAdmin?: boolean;
  }): Promise<ActiveCallSession> {
    const session = await this.getCallSession(params.callId);
    if (!session) {
      throw new BadRequestException('Phiên cuộc gọi không tồn tại');
    }
    if (session.initiatorId !== params.requesterId && !params.isRequesterGroupAdmin) {
      throw new ForbiddenException(
        'Chỉ người chủ trì hoặc Quản trị viên mới có thể tắt mic thành viên',
      );
    }
    return this.updateMediaState({
      callId: params.callId,
      userId: params.targetUserId,
      isAudioMuted: true,
    });
  }

  async rejectOrLeaveCall(params: {
    callId: string;
    userId: string;
    reason?: 'rejected' | 'busy' | 'hangup' | 'timeout';
    endForAll?: boolean;
  }): Promise<{
    session: ActiveCallSession | null;
    isCallTerminated: boolean;
    finalStatus: CallStatusEnum;
    durationSeconds: number;
  }> {
    const session = await this.getCallSession(params.callId);
    await this.safeDeleteUserCallKeys([params.userId], params.callId);

    if (!session) {
      this.clearRingingTimeout(params.callId);
      return {
        session: null,
        isCallTerminated: true,
        finalStatus: CallStatusEnum.COMPLETED,
        durationSeconds: 0,
      };
    }

    const leavingParticipant = session.participants[params.userId];
    delete session.participants[params.userId];

    const now = new Date();
    if (leavingParticipant?.joinedAt) {
      const userDuration = Math.max(
        0,
        Math.round((now.getTime() - new Date(leavingParticipant.joinedAt).getTime()) / 1000),
      );
      await this.callParticipantRepo
        .update(
          { callId: params.callId, userId: params.userId },
          {
            status: CallParticipantStatusEnum.LEFT,
            leftAt: now,
            durationSeconds: userDuration,
          },
        )
        .catch(() => undefined);
    } else if (params.reason === 'rejected' || params.reason === 'busy') {
      await this.callParticipantRepo
        .update(
          { callId: params.callId, userId: params.userId },
          {
            status:
              params.reason === 'busy'
                ? CallParticipantStatusEnum.BUSY
                : CallParticipantStatusEnum.REJECTED,
          },
        )
        .catch(() => undefined);
    }

    const remainingUserIds = Object.keys(session.participants);
    const isDirectCall = !session.isGroupCall && session.invitedUserIds.length === 1;
    const isHostEndingForAll = Boolean(params.endForAll) && params.userId === session.initiatorId;

    const shouldTerminate =
      isHostEndingForAll ||
      params.reason === 'timeout' ||
      remainingUserIds.length === 0 ||
      (isDirectCall && (params.reason === 'rejected' || params.reason === 'busy')) ||
      (session.status === CallStatusEnum.ONGOING && remainingUserIds.length <= 1 && isDirectCall) ||
      (session.status === CallStatusEnum.RINGING && params.userId === session.initiatorId);

    if (shouldTerminate) {
      this.clearRingingTimeout(params.callId);
      session.endedAt = now.toISOString();

      let finalStatus = CallStatusEnum.COMPLETED;
      let durationSeconds = 0;

      if (session.answeredAt) {
        finalStatus = CallStatusEnum.COMPLETED;
        durationSeconds = Math.max(
          0,
          Math.round((now.getTime() - new Date(session.answeredAt).getTime()) / 1000),
        );
      } else if (params.reason === 'timeout') {
        finalStatus = CallStatusEnum.MISSED;
      } else if (params.reason === 'rejected') {
        finalStatus = CallStatusEnum.REJECTED;
      } else if (params.reason === 'busy') {
        finalStatus = CallStatusEnum.BUSY;
      } else if (params.userId === session.initiatorId) {
        finalStatus = CallStatusEnum.CANCELLED;
      } else {
        finalStatus = CallStatusEnum.MISSED;
      }

      session.status = finalStatus;

      await this.redis.del(
        `${this.CALL_KEY_PREFIX}${params.callId}`,
        `${this.CONV_CALL_PREFIX}${session.conversationId}`,
      );
      await this.safeDeleteUserCallKeys(
        [session.initiatorId, ...session.invitedUserIds, ...remainingUserIds],
        params.callId,
      );

      await this.callSessionRepo
        .update(params.callId, {
          status: finalStatus,
          endedAt: now,
          durationSeconds,
          maxConcurrentParticipants: session.maxConcurrentParticipants || 1,
          endReason: params.reason || 'hangup',
        })
        .catch(() => undefined);

      return {
        session,
        isCallTerminated: true,
        finalStatus,
        durationSeconds,
      };
    }

    await this.redis.set(
      `${this.CALL_KEY_PREFIX}${params.callId}`,
      JSON.stringify(session),
      'EX',
      this.CALL_TTL_SECONDS,
    );

    return {
      session,
      isCallTerminated: false,
      finalStatus: session.status,
      durationSeconds: 0,
    };
  }
}
