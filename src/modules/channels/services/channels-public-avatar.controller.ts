import { Controller, Get, HttpStatus, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { ChannelsService } from '../channels.service';

@ApiTags('Sprint 4 — Omnichannel Customer Avatar Proxy')
@Controller('channels/public-avatar')
export class ChannelsPublicAvatarController {
  constructor(private readonly channelsService: ChannelsService) {}

  @Get(':shopId/:channelId/:psid')
  @ApiOperation({
    summary:
      'Proxy ảnh đại diện khách hàng Meta/Instagram/Ads (chống hết hạn chữ ký ext & chặn Referer trên trình duyệt)',
  })
  async streamCustomerAvatar(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
    @Param('psid') psid: string,
    @Res() res: Response,
  ): Promise<void> {
    const media = await this.channelsService.getCustomerAvatarBinaryForProxy({
      shopId,
      channelId,
      externalCustomerPsid: psid,
    });

    if (!media) {
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }

    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', 'public, max-age=21600, stale-while-revalidate=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(HttpStatus.OK).send(media.buffer);
  }
}
