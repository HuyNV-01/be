import { Controller, Get, HttpStatus, Param, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import type { Response } from 'express';

import { OmnichannelAvatarAndMediaService } from './omnichannel-avatar-and-media.service';

@ApiTags('Omnichannel Customer Avatar & Media Proxy')
@Controller('channels')
export class ChannelsPublicAvatarController {
  constructor(private readonly avatarAndMediaService: OmnichannelAvatarAndMediaService) {}

  @Get('public-avatar/:shopId/:channelId/:psid')
  @ApiOperation({
    summary:
      'Proxy ảnh đại diện khách hàng đa kênh (Meta Ads/Business Suite, Instagram, Zalo OA, Shopee, TikTok) — luôn trả 200 OK',
  })
  async streamCustomerAvatar(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
    @Param('psid') psid: string,
    @Res() res: Response,
  ): Promise<void> {
    const media = await this.avatarAndMediaService.getCustomerAvatarBinaryForProxy({
      shopId,
      channelId,
      externalCustomerPsid: psid,
    });

    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', media.cacheControl);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(HttpStatus.OK).send(media.buffer);
  }

  @Get('public-media/:shopId/:channelId/:mediaToken')
  @ApiOperation({
    summary:
      'Proxy tệp đính kèm/ảnh/sticker/GIF/audio từ các nền tảng ngoài (chống hết hạn chữ ký Meta CDN & chặn Referer)',
  })
  async streamOmnichannelMedia(
    @Param('shopId') shopId: string,
    @Param('channelId') channelId: string,
    @Param('mediaToken') mediaToken: string,
    @Res() res: Response,
  ): Promise<void> {
    const media = await this.avatarAndMediaService.getAttachmentBinaryForProxy({
      shopId,
      channelId,
      mediaToken,
    });

    if (!media) {
      res.status(HttpStatus.NOT_FOUND).end();
      return;
    }

    res.setHeader('Content-Type', media.contentType);
    res.setHeader('Cache-Control', media.cacheControl);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.status(HttpStatus.OK).send(media.buffer);
  }
}
