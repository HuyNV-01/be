import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import type { Response } from 'express';
import Redis from 'ioredis';
import { ChannelTypeEnum, PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { envs } from 'src/config/envs/envs';
import { DBaseRes } from 'src/dto/base-res.dto';
import { ChannelWebhookLogEntity } from 'src/entity/channel-webhook-log.entity';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { Repository } from 'typeorm';

import { ChannelsService } from '../channels.service';

@ApiTags('Sprint 1 — Omnichannel Webhooks & Replay Inspector (T01)')
@Controller('webhooks/omnichannel')
export class OmnibusWebhookController {
  constructor(
    @InjectRepository(ChannelWebhookLogEntity)
    private readonly webhookLogRepo: Repository<ChannelWebhookLogEntity>,
    @InjectRedis() private readonly redis: Redis,
    private readonly channelsService: ChannelsService,
  ) {}

  @Get(':channelType')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Xác thực Webhook Challenge (hub.challenge / hub.verify_token / challenge) chuẩn Meta Graph API, Zalo OA, TikTok Shop, Shopee',
  })
  async verifyWebhookSubscription(
    @Param('channelType') channelTypeParam: string,
    @Query('hub.mode') hubMode?: string,
    @Query('hub.verify_token') hubVerifyToken?: string,
    @Query('hub.challenge') hubChallenge?: string,
    @Query('challenge') challenge?: string,
    @Query('shopId') shopId?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<string | { verified: boolean; mode: string; channelType: string }> {
    const channelType = channelTypeParam.toUpperCase() as ChannelTypeEnum;

    if (hubVerifyToken) {
      const isValidVerifyToken = await this.channelsService.verifyWebhookChallengeToken({
        channelType,
        verifyToken: hubVerifyToken,
        shopId,
      });

      if (!isValidVerifyToken) {
        if (res) {
          res.status(HttpStatus.FORBIDDEN);
        }
        return 'WEBHOOK_VERIFY_TOKEN_MISMATCH';
      }
    }

    if (hubChallenge !== undefined && hubChallenge !== '') {
      if (res) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      return String(hubChallenge);
    }

    if (challenge !== undefined && challenge !== '') {
      if (res) {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      return String(challenge);
    }

    return {
      verified: true,
      mode: hubMode || 'ACTIVE',
      channelType,
    };
  }

  @Post(':channelType')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cổng nhận Webhook hợp nhất cho FB, IG, Zalo OA, TikTok Shop, Shopee, Lazada (Khử trùng Redis SETNX, hỗ trợ batch entry[])',
  })
  async handleIncomingWebhook(
    @Param('channelType') channelTypeParam: string,
    @Headers() headers: Record<string, string>,
    @Body() payload: Record<string, unknown>,
  ): Promise<{ received: true; idempotencyKey: string; status: string }> {
    const startTime = Date.now();
    const channelType = channelTypeParam.toUpperCase() as ChannelTypeEnum;

    const rawHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(payload || {}))
      .digest('hex')
      .slice(0, 40);
    const idempotencyKey = `${channelType}:${rawHash}`;

    let isFirstSeen: string | null = 'OK';
    try {
      const dedupeRedisKey = `webhook:dedupe:${idempotencyKey}`;
      isFirstSeen = await this.redis.set(dedupeRedisKey, '1', 'EX', 86400, 'NX');
    } catch {
      isFirstSeen = 'OK';
    }

    const preResolvedChannel = await this.channelsService
      .resolveChannelByWebhookPayload(channelType, payload || {})
      .catch(() => null);

    const logEntry = this.webhookLogRepo.create({
      shopId: preResolvedChannel?.shopId || null,
      channelIntegrationId: preResolvedChannel?.id || null,
      channelType,
      idempotencyKey,
      eventType: String(
        payload?.object ||
          payload?.event_name ||
          payload?.event ||
          payload?.type ||
          'MESSAGE_INBOUND',
      ),
      headersJson: headers || {},
      rawPayloadJson: payload || {},
      processingStatus: isFirstSeen ? 'RECEIVED' : 'DUPLICATE_SKIPPED',
    });

    const savedLog = await this.webhookLogRepo.save(logEntry);

    if (!isFirstSeen) {
      await this.channelsService.notifyWebhookLogUpdated(preResolvedChannel?.shopId || null, {
        id: savedLog.id,
        channelType,
        eventType: savedLog.eventType,
        processingStatus: 'DUPLICATE_SKIPPED',
        replayedCount: 0,
      });

      return {
        received: true,
        idempotencyKey,
        status: 'DUPLICATE_SKIPPED',
      };
    }

    try {
      const result = await this.channelsService.dispatchInboundWebhookPayload({
        logId: savedLog.id,
        channelType,
        headers: headers || {},
        payload: payload || {},
      });

      const resolvedShopId = result.shopId || preResolvedChannel?.shopId || null;
      const resolvedChannelId = result.channelIntegrationId || preResolvedChannel?.id || null;

      await this.webhookLogRepo.update(
        { id: savedLog.id, createdAt: savedLog.createdAt },
        {
          shopId: resolvedShopId,
          channelIntegrationId: resolvedChannelId,
          processingStatus: 'PROCESSED',
          processingDurationMs: Date.now() - startTime,
        },
      );

      await this.channelsService.notifyWebhookLogUpdated(resolvedShopId, {
        id: savedLog.id,
        channelType,
        eventType: savedLog.eventType,
        processingStatus: 'PROCESSED',
        replayedCount: 0,
      });

      return {
        received: true,
        idempotencyKey,
        status: 'PROCESSED',
      };
    } catch (err: unknown) {
      const errorStack = err instanceof Error ? err.stack || err.message : String(err);
      await this.webhookLogRepo.update(
        { id: savedLog.id, createdAt: savedLog.createdAt },
        {
          processingStatus: 'FAILED_DLQ',
          processingDurationMs: Date.now() - startTime,
          errorStack,
        },
      );

      await this.channelsService.notifyWebhookLogUpdated(preResolvedChannel?.shopId || null, {
        id: savedLog.id,
        channelType,
        eventType: savedLog.eventType,
        processingStatus: 'FAILED_DLQ',
        replayedCount: 0,
      });

      return {
        received: true,
        idempotencyKey,
        status: 'FAILED_DLQ',
      };
    }
  }

  @Post('replay/:logId')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard, ShopPermissionGuard)
  @RequireShopPermissions(PermissionCodeEnum.CHANNEL_WEBHOOK_INSPECT_REPLAY)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Công cụ T01: Chạy lại (Replay) một sự kiện Webhook bị lỗi trong Dead-Letter Queue',
  })
  async replayFailedWebhook(@Param('logId') logId: string): Promise<DBaseRes> {
    const log = await this.webhookLogRepo.findOne({ where: { id: logId } });
    if (!log) {
      return {
        status: HttpStatus.NOT_FOUND,
        code: HttpStatus.NOT_FOUND,
        message: 'WEBHOOK_LOG_NOT_FOUND',
      };
    }

    const startTime = Date.now();
    try {
      const result = await this.channelsService.dispatchInboundWebhookPayload({
        logId: log.id,
        channelType: log.channelType,
        headers: log.headersJson,
        payload: log.rawPayloadJson,
      });

      const nextReplayCount = (log.replayedCount || 0) + 1;
      const resolvedShopId = result.shopId || log.shopId;

      await this.webhookLogRepo.update(
        { id: log.id, createdAt: log.createdAt },
        {
          shopId: resolvedShopId,
          channelIntegrationId: result.channelIntegrationId || log.channelIntegrationId,
          processingStatus: 'REPLAYED_SUCCESS',
          replayedCount: nextReplayCount,
          processingDurationMs: Date.now() - startTime,
          errorStack: null,
        },
      );

      await this.channelsService.notifyWebhookLogUpdated(resolvedShopId, {
        id: log.id,
        channelType: log.channelType,
        eventType: log.eventType,
        processingStatus: 'REPLAYED_SUCCESS',
        replayedCount: nextReplayCount,
      });

      return {
        status: HttpStatus.OK,
        code: HttpStatus.OK,
        message: 'Replayed webhook successfully',
        data: {
          logId: log.id,
          status: 'REPLAYED_SUCCESS',
          replayedCount: nextReplayCount,
        },
      };
    } catch (err: unknown) {
      const errorStack = err instanceof Error ? err.stack || err.message : String(err);
      await this.webhookLogRepo.update(
        { id: log.id, createdAt: log.createdAt },
        {
          processingStatus: 'FAILED_DLQ',
          processingDurationMs: Date.now() - startTime,
          errorStack,
        },
      );

      return {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        code: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Webhook replay failed',
        data: {
          logId: log.id,
          status: 'FAILED_DLQ',
          error: errorStack,
        },
      };
    }
  }
}
