import { BadRequestException, ForbiddenException, Injectable, Logger } from '@nestjs/common';

import { InjectRedis } from '@nestjs-modules/ioredis';
import Redis from 'ioredis';
import { CallStatusEnum, CallTypeEnum } from 'src/common/enum';
import { v4 as uuidv4 } from 'uuid';

export interface CallParticipantState {
  userId: string;
  joinedAt: string;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
}

export interface ActiveCallSession {
  callId: string;
  conversationId: string;
  callType: CallTypeEnum;
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
  private readonly CALL_TTL_SECONDS = 3600 * 4;

  constructor(@InjectRedis() private readonly redis: Redis) {}

  async initiateCall(params: {
    conversationId: string;
    initiatorId: string;
    memberIds: string[];
    callType: CallTypeEnum;
  }): Promise<{
    session: ActiveCallSession;
    busyUserIds: string[];
    ringingUserIds: string[];
  }> {
    const existingCallerCallId = await this.redis.get(
      `${this.USER_CALL_PREFIX}${params.initiatorId}`,
    );
    if (existingCallerCallId) {
      const existingCall = await this.getCallSession(existingCallerCallId);
      if (existingCall) {
        throw new BadRequestException('You are already in an active call');
      }
      await this.redis.del(`${this.USER_CALL_PREFIX}${params.initiatorId}`);
    }

    const targetIds = params.memberIds.filter((id) => id !== params.initiatorId);
    const busyUserIds: string[] = [];
    const ringingUserIds: string[] = [];

    for (const targetId of targetIds) {
      const activeCallId = await this.redis.get(`${this.USER_CALL_PREFIX}${targetId}`);
      if (activeCallId) {
        const activeSession = await this.getCallSession(activeCallId);
        if (activeSession) {
          busyUserIds.push(targetId);
          continue;
        }
        await this.redis.del(`${this.USER_CALL_PREFIX}${targetId}`);
      }
      ringingUserIds.push(targetId);
    }

    const callId = uuidv4();
    const now = new Date().toISOString();

    const session: ActiveCallSession = {
      callId,
      conversationId: params.conversationId,
      callType: params.callType,
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
        .exec();
    }

    return { session, busyUserIds, ringingUserIds };
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

  async acceptCall(callId: string, userId: string): Promise<ActiveCallSession> {
    const session = await this.getCallSession(callId);
    if (!session) {
      throw new BadRequestException('Call session has expired or already ended');
    }

    if (session.initiatorId !== userId && !session.invitedUserIds.includes(userId)) {
      throw new ForbiddenException('You are not invited to this call');
    }

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
      .exec();

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
      throw new BadRequestException('Active call participant not found');
    }

    const current = session.participants[params.userId];
    if (params.isAudioMuted !== undefined) current.isAudioMuted = params.isAudioMuted;
    if (params.isVideoOff !== undefined) current.isVideoOff = params.isVideoOff;
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
    reason?: 'rejected' | 'busy' | 'hangup';
  }): Promise<{
    session: ActiveCallSession | null;
    isCallTerminated: boolean;
    finalStatus: CallStatusEnum;
    durationSeconds: number;
  }> {
    const session = await this.getCallSession(params.callId);
    await this.redis.del(`${this.USER_CALL_PREFIX}${params.userId}`);

    if (!session) {
      return {
        session: null,
        isCallTerminated: true,
        finalStatus: CallStatusEnum.COMPLETED,
        durationSeconds: 0,
      };
    }

    delete session.participants[params.userId];
    const remainingUserIds = Object.keys(session.participants);
    const isDirectCall = session.invitedUserIds.length === 1;

    if (
      remainingUserIds.length === 0 ||
      (isDirectCall && params.reason === 'rejected') ||
      (session.status === CallStatusEnum.ONGOING && remainingUserIds.length <= 1 && isDirectCall) ||
      (session.status === CallStatusEnum.RINGING && params.userId === session.initiatorId)
    ) {
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
        `${this.USER_CALL_PREFIX}${session.initiatorId}`,
        ...session.invitedUserIds.map((id) => `${this.USER_CALL_PREFIX}${id}`),
        ...remainingUserIds.map((id) => `${this.USER_CALL_PREFIX}${id}`),
      ];
      await this.redis.del(...cleanupKeys);

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
