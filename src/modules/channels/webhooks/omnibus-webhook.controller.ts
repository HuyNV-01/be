import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';

import { InjectRedis } from '@nestjs-modules/ioredis';
import * as crypto from 'crypto';
import Redis from 'ioredis';
import { ChannelTypeEnum, PermissionCodeEnum } from 'src/common/enum/permission.enum';
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

  @Post(':channelType')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cổng nhận Webhook hợp nhất cho FB, IG, Zalo OA, TikTok Shop, Shopee, Lazada (Khử trùng Redis SETNX)',
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

    const dedupeRedisKey = `webhook:dedupe:${idempotencyKey}`;
    const isFirstSeen = await this.redis.set(dedupeRedisKey, '1', 'EX', 86400, 'NX');

    const logEntry = this.webhookLogRepo.create({
      channelType,
      idempotencyKey,
      eventType: String(payload?.object || payload?.event || payload?.type || 'MESSAGE_INBOUND'),
      headersJson: headers || {},
      rawPayloadJson: payload || {},
      processingStatus: isFirstSeen ? 'RECEIVED' : 'DUPLICATE_SKIPPED',
    });

    const savedLog = await this.webhookLogRepo.save(logEntry);

    if (!isFirstSeen) {
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

      await this.webhookLogRepo.update(
        { id: savedLog.id, createdAt: savedLog.createdAt },
        {
          shopId: result.shopId,
          channelIntegrationId: result.channelIntegrationId,
          processingStatus: 'PROCESSED',
          processingDurationMs: Date.now() - startTime,
        },
      );

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
    const result = await this.channelsService.dispatchInboundWebhookPayload({
      logId: log.id,
      channelType: log.channelType,
      headers: log.headersJson,
      payload: log.rawPayloadJson,
    });

    await this.webhookLogRepo.update(
      { id: log.id, createdAt: log.createdAt },
      {
        shopId: result.shopId || log.shopId,
        channelIntegrationId: result.channelIntegrationId || log.channelIntegrationId,
        processingStatus: 'REPLAYED_SUCCESS',
        replayedCount: (log.replayedCount || 0) + 1,
        processingDurationMs: Date.now() - startTime,
        errorStack: null,
      },
    );

    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Replayed webhook successfully',
      data: {
        logId: log.id,
        status: 'REPLAYED_SUCCESS',
        replayedCount: (log.replayedCount || 0) + 1,
      },
    };
  }
}
