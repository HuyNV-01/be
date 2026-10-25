/* eslint-disable @typescript-eslint/no-misused-promises */
import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { CallStatusEnum, CallTypeEnum } from 'src/common/enum';
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
}

export interface ActiveCallSession {
  callId: string;
  conversationId: string;
  callType: CallTypeEnum;
  isGroupCall: boolean;
  initiatorId: string;
  invitedUserIds: string[];
  status: CallStatusEnum;
  createdAt: string;
  answeredAt?: string;
  endedAt?: string;
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

  constructor(
    @InjectRedis() private readonly redis: Redis,
    @InjectRepository(CallSessionEntity)
    private readonly callSessionRepo: Repository<CallSessionEntity>,
  ) {}

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

    const session: ActiveCallSession = {
      callId,
      conversationId: params.conversationId,
      callType: params.callType,
      isGroupCall,
      initiatorId: params.initiatorId,
      invitedUserIds: targetIds,
      status: ringingUserIds.length > 0 ? CallStatusEnum.RINGING : CallStatusEnum.BUSY,
      createdAt: now,
      participants: {
        [params.initiatorId]: {
          userId: params.initiatorId,
          joinedAt: now,
          isAudioMuted: false,
          isVideoOff: params.callType === CallTypeEnum.AUDIO,
          isScreenSharing: false,
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
            invitedUserIds: targetIds,
            participants: session.participants,
          }),
        )
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

    return session;
  }

  async updateMediaState(params: {
    callId: string;
    userId: string;
    isAudioMuted?: boolean;
    isVideoOff?: boolean;
    isScreenSharing?: boolean;
  }): Promise<ActiveCallSession> {
    const session = await this.getCallSession(params.callId);
    if (!session || !session.participants[params.userId]) {
      throw new BadRequestException('Không tìm thấy thành viên trong cuộc gọi');
    }

    const current = session.participants[params.userId];
    if (params.isAudioMuted !== undefined) current.isAudioMuted = params.isAudioMuted;
    if (params.isVideoOff !== undefined) {
      current.isVideoOff = params.isVideoOff;
      // Nếu bật camera trong cuộc gọi thoại, tự động nâng cấp phiên lên VIDEO
      if (!params.isVideoOff && session.callType === CallTypeEnum.AUDIO) {
        session.callType = CallTypeEnum.VIDEO;
      }
    }
    if (params.isScreenSharing !== undefined) current.isScreenSharing = params.isScreenSharing;

    await this.redis.set(
      `${this.CALL_KEY_PREFIX}${params.callId}`,
      JSON.stringify(session),
      'EX',
      this.CALL_TTL_SECONDS,
    );

    return session;
  }

  async rejectOrLeaveCall(params: {
    callId: string;
    userId: string;
    reason?: 'rejected' | 'busy' | 'hangup' | 'timeout';
  }): Promise<{
    session: ActiveCallSession | null;
    isCallTerminated: boolean;
    finalStatus: CallStatusEnum;
    durationSeconds: number;
  }> {
    const session = await this.getCallSession(params.callId);
    await this.redis.del(`${this.USER_CALL_PREFIX}${params.userId}`);

    if (!session) {
      this.clearRingingTimeout(params.callId);
      return {
        session: null,
        isCallTerminated: true,
        finalStatus: CallStatusEnum.COMPLETED,
        durationSeconds: 0,
      };
    }

    delete session.participants[params.userId];
    const remainingUserIds = Object.keys(session.participants);
    const isDirectCall = !session.isGroupCall && session.invitedUserIds.length === 1;

    const shouldTerminate =
      params.reason === 'timeout' ||
      remainingUserIds.length === 0 ||
      (isDirectCall && (params.reason === 'rejected' || params.reason === 'busy')) ||
      (session.status === CallStatusEnum.ONGOING && remainingUserIds.length <= 1 && isDirectCall) ||
      (session.status === CallStatusEnum.RINGING && params.userId === session.initiatorId);

    if (shouldTerminate) {
      this.clearRingingTimeout(params.callId);
      const now = new Date();
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

      const cleanupKeys = [
        `${this.CALL_KEY_PREFIX}${params.callId}`,
        `${this.CONV_CALL_PREFIX}${session.conversationId}`,
        `${this.USER_CALL_PREFIX}${session.initiatorId}`,
        ...session.invitedUserIds.map((id) => `${this.USER_CALL_PREFIX}${id}`),
        ...remainingUserIds.map((id) => `${this.USER_CALL_PREFIX}${id}`),
      ];
      await this.redis.del(...cleanupKeys);

      await this.callSessionRepo
        .update(params.callId, {
          status: finalStatus,
          endedAt: now,
          durationSeconds,
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
