import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';

import { HTTP_RESPONSE } from 'src/constants/http-response';
import { GetNotificationsQueryDto } from 'src/dto/notification/notification.dto';
import type { IBaseReq } from 'src/interface';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationsService } from './notifications.service';

@ApiTags('Notifications')
@Controller('notifications')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @ApiOperation({ summary: 'Lấy danh sách thông báo phân trang kèm số lượng chưa đọc' })
  @Get()
  @HttpCode(HttpStatus.OK)
  async getNotifications(@Req() req: IBaseReq, @Query() query: GetNotificationsQueryDto) {
    const result = await this.notificationsService.getUserNotifications({
      userId: req.user.id,
      query,
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Lấy số lượng thông báo chưa đọc' })
  @Get('unread-count')
  @HttpCode(HttpStatus.OK)
  async getUnreadCount(@Req() req: IBaseReq) {
    const unreadCount = await this.notificationsService.getUnreadCount(req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: { unreadCount },
    };
  }

  @ApiOperation({ summary: 'Đánh dấu tất cả thông báo là đã đọc' })
  @Put('read-all')
  @HttpCode(HttpStatus.OK)
  async markAllAsRead(@Req() req: IBaseReq) {
    const result = await this.notificationsService.markAllAsRead(req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Đánh dấu đã đọc toàn bộ thông báo của một cuộc hội thoại' })
  @ApiParam({ name: 'conversationId', description: 'Conversation UUID' })
  @Put('conversations/:conversationId/read')
  @HttpCode(HttpStatus.OK)
  async markConversationNotificationsRead(
    @Req() req: IBaseReq,
    @Param('conversationId') conversationId: string,
  ) {
    await this.notificationsService.markConversationNotificationsAsRead(
      req.user.id,
      conversationId,
    );
    const unreadCount = await this.notificationsService.getUnreadCount(req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: { unreadCount },
    };
  }

  @ApiOperation({ summary: 'Đánh dấu 1 thông báo là đã đọc' })
  @ApiParam({ name: 'id', description: 'Notification UUID' })
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(@Req() req: IBaseReq, @Param('id') id: string) {
    const result = await this.notificationsService.markAsRead({
      userId: req.user.id,
      notificationId: id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Xóa một thông báo' })
  @ApiParam({ name: 'id', description: 'Notification UUID' })
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deleteNotification(@Req() req: IBaseReq, @Param('id') id: string) {
    const result = await this.notificationsService.deleteNotification({
      userId: req.user.id,
      notificationId: id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }
}
