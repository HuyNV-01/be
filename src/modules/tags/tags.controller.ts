import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { PermissionCodeEnum } from 'src/common/enum/permission.enum';
import { DBaseRes } from 'src/dto/base-res.dto';
import {
  AssignMessageBookmarkTagDto,
  BulkAssignConversationTagsDto,
  CreateCustomTagDto,
  CreateTagEventDefinitionDto,
  FireTagEventDto,
  QueryCustomTagsDto,
  ToggleConversationTagDto,
  UpdateCustomTagDto,
  UpdateTagEventDefinitionDto,
} from 'src/dto/tags/tags.dto';
import { JwtAuthGuard } from 'src/modules/auth/guards/jwt-auth.guard';
import {
  RequireShopPermissions,
  ShopPermissionGuard,
} from 'src/modules/iam/guards/shop-permission.guard';
import { FieldLevelSecurityInterceptor } from 'src/modules/iam/interceptors/field-level-security.interceptor';

import { ConversationTaggingService } from './services/conversation-tagging.service';
import { CustomTagService } from './services/custom-tag.service';
import { MessageBookmarkTagService } from './services/message-bookmark-tag.service';
import { TagEventOrchestratorService } from './services/tag-event-orchestrator.service';

@ApiTags('Sprint 2 — Multi-Tier oklch Tagging, Mutually Exclusive Groups & Message Bookmarks')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard, ShopPermissionGuard)
@UseInterceptors(FieldLevelSecurityInterceptor)
@Controller('tags/:shopId')
export class TagsController {
  constructor(
    private readonly customTagService: CustomTagService,
    private readonly conversationTaggingService: ConversationTaggingService,
    private readonly messageBookmarkTagService: MessageBookmarkTagService,
    private readonly tagEventOrchestrator: TagEventOrchestratorService,
  ) {}

  @Get()
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F02.1: Lấy danh sách bộ Tag màu chuẩn oklch của cửa hàng theo phân nhóm & phạm vi',
  })
  async listShopTags(
    @Param('shopId') shopId: string,
    @Query() query: QueryCustomTagsDto,
  ): Promise<DBaseRes> {
    const data = await this.customTagService.listShopTags(shopId, query);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched custom tags successfully',
      data,
    };
  }

  @Post()
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_CREATE_EDIT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'F02.1: Tạo mới Tag màu chuẩn oklch, phím tắt Alt+1..9 & quy tắc tự động gắn',
  })
  async createTag(
    @Param('shopId') shopId: string,
    @Body() dto: CreateCustomTagDto,
  ): Promise<DBaseRes> {
    const data = await this.customTagService.createTag(shopId, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Created custom tag successfully',
      data,
    };
  }

  @Get('events')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Lấy danh sách sự kiện hệ thống & sự kiện tùy chỉnh kết nối 2 chiều với Tag',
  })
  async listTagEvents(@Param('shopId') shopId: string): Promise<DBaseRes> {
    const data = await this.tagEventOrchestrator.listEvents(shopId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched tag event definitions successfully',
      data,
    };
  }

  @Post('events')
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_CREATE_EDIT)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Tạo mới sự kiện tùy chỉnh kết nối hai chiều Event <-> Tag',
  })
  async createTagEvent(
    @Param('shopId') shopId: string,
    @Body() dto: CreateTagEventDefinitionDto,
  ): Promise<DBaseRes> {
    const data = await this.tagEventOrchestrator.createEvent(shopId, dto);
    return {
      status: HttpStatus.CREATED,
      code: HttpStatus.CREATED,
      message: 'Created tag event definition successfully',
      data,
    };
  }

  @Patch('events/:eventId')
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_CREATE_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cập nhật điều kiện, Tag liên kết hoặc hành động thực thi của sự kiện',
  })
  async updateTagEvent(
    @Param('shopId') shopId: string,
    @Param('eventId') eventId: string,
    @Body() dto: UpdateTagEventDefinitionDto,
  ): Promise<DBaseRes> {
    const data = await this.tagEventOrchestrator.updateEvent(shopId, eventId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated tag event definition successfully',
      data,
    };
  }

  @Delete('events/:eventId')
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Xóa mềm sự kiện tùy chỉnh của cửa hàng',
  })
  async deleteTagEvent(
    @Param('shopId') shopId: string,
    @Param('eventId') eventId: string,
  ): Promise<DBaseRes> {
    const data = await this.tagEventOrchestrator.deleteEvent(shopId, eventId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Deleted tag event definition successfully',
      data,
    };
  }

  @Post('events/:eventId/fire')
  @RequireShopPermissions(PermissionCodeEnum.TAG_CONVERSATION_ASSIGN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Kích hoạt thủ công hoặc kiểm thử (Test Fire) một sự kiện trên cuộc hội thoại',
  })
  async fireTagEvent(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('eventId') eventId: string,
    @Body() dto: FireTagEventDto,
  ): Promise<DBaseRes> {
    const data = await this.tagEventOrchestrator.fireEventManually(
      shopId,
      eventId,
      dto,
      req.user.id,
    );
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fired tag event successfully',
      data,
    };
  }

  @Patch(':tagId')
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_CREATE_EDIT)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F02.1 & F02.5: Cập nhật thông tin Tag màu oklch, nhóm loại trừ hoặc quy tắc tự động',
  })
  async updateTag(
    @Param('shopId') shopId: string,
    @Param('tagId') tagId: string,
    @Body() dto: UpdateCustomTagDto,
  ): Promise<DBaseRes> {
    const data = await this.customTagService.updateTag(shopId, tagId, dto);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Updated custom tag successfully',
      data,
    };
  }

  @Delete(':tagId')
  @RequireShopPermissions(PermissionCodeEnum.TAG_SCHEMA_DELETE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F02.1: Xóa mềm Tag phân loại khỏi danh mục cửa hàng',
  })
  async deleteTag(
    @Param('shopId') shopId: string,
    @Param('tagId') tagId: string,
  ): Promise<DBaseRes> {
    const data = await this.customTagService.deleteTag(shopId, tagId);
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Deleted custom tag successfully',
      data,
    };
  }

  @Post('conversations/:conversationId/toggle')
  @RequireShopPermissions(PermissionCodeEnum.TAG_CONVERSATION_ASSIGN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F02.2: Gắn/Gỡ Tag hội thoại tức thì (Hỗ trợ MutuallyExclusiveGroup & đồng bộ Socket < 30ms)',
  })
  async toggleConversationTag(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('conversationId') conversationId: string,
    @Body() dto: ToggleConversationTagDto,
  ): Promise<DBaseRes> {
    const data = await this.conversationTaggingService.toggleConversationTag({
      shopId,
      conversationId,
      tagId: dto.tagId,
      actorUserId: req.user.id,
      forceState: dto.forceState,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Toggled conversation tag successfully',
      data,
    };
  }

  @Post('conversations/bulk-assign')
  @RequireShopPermissions(PermissionCodeEnum.TAG_CONVERSATION_BULK_ASSIGN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'F02.6: Gắn hoặc gỡ Tag hàng loạt cho nhiều cuộc hội thoại',
  })
  async bulkAssignConversationTags(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Body() dto: BulkAssignConversationTagsDto,
  ): Promise<DBaseRes> {
    const data = await this.conversationTaggingService.bulkAssignConversationTags({
      shopId,
      conversationIds: dto.conversationIds,
      addTagIds: dto.addTagIds,
      removeTagIds: dto.removeTagIds,
      actorUserId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Bulk updated conversation tags successfully',
      data,
    };
  }

  @Post('messages/:messageId/bookmark')
  @RequireShopPermissions(PermissionCodeEnum.TAG_MESSAGE_BOOKMARK_ASSIGN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F02.3: Gắn/Gỡ Tag đánh dấu trực tiếp lên từng bong bóng tin nhắn (Địa chỉ giao, Bill CK, Lưu ý kho)',
  })
  async toggleMessageBookmarkTag(
    @Request() req: { user: { id: string } },
    @Param('shopId') shopId: string,
    @Param('messageId') messageId: string,
    @Body() dto: AssignMessageBookmarkTagDto,
  ): Promise<DBaseRes> {
    const data = await this.messageBookmarkTagService.toggleMessageBookmarkTag({
      shopId,
      conversationId: dto.conversationId,
      messageId,
      tagId: dto.tagId,
      actorUserId: req.user.id,
      noteText: dto.noteText,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Toggled message bookmark tag successfully',
      data,
    };
  }

  @Get('bookmarks')
  @RequireShopPermissions(PermissionCodeEnum.INBOX_CONVERSATION_VIEW)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'F02.4: Tra cứu danh sách các bong bóng tin nhắn đã gắn nhãn Bookmark cho Sale / Kho / Kế toán',
  })
  async listBookmarkedMessages(
    @Param('shopId') shopId: string,
    @Query('conversationId') conversationId?: string,
    @Query('tagId') tagId?: string,
  ): Promise<DBaseRes> {
    const data = await this.messageBookmarkTagService.listBookmarkedMessages({
      shopId,
      conversationId,
      tagId,
    });
    return {
      status: HttpStatus.OK,
      code: HttpStatus.OK,
      message: 'Fetched bookmarked messages successfully',
      data,
    };
  }
}
