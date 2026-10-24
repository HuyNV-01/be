/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';

import { FileValidators } from 'src/common/pipes/file-validation.pipe';
import { RealtimeEmitterService } from 'src/common/websocket/realtime-emitter.service';
import { SOCKET_CONFIG } from 'src/config/websocket/socket.config';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { DBaseQuery } from 'src/dto/base-query.dto';
import {
  AddGroupMembersDto,
  EditMessageDto,
  MuteConversationDto,
  PinMessageDto,
  ReactMessageDto,
  RegisterPublicKeyDto,
} from 'src/dto/chat/call-and-security.dto';
import { CreateGroupDto } from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import * as queryTypes from 'src/types/query.types';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatService } from './chat.service';

@ApiTags('Chat & Real-Time Communication')
@Controller('chat')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class ChatController {
  private readonly logger = new Logger(ChatController.name, {
    timestamp: true,
  });

  constructor(
    private readonly chatService: ChatService,
    private readonly realtimeEmitter: RealtimeEmitterService,
  ) {}

  @ApiOperation({ summary: 'Create a new group chat' })
  @ApiBody({ type: CreateGroupDto })
  @Post('groups')
  @HttpCode(HttpStatus.CREATED)
  async createGroup(@Req() req, @Body() dto: CreateGroupDto) {
    const result = await this.chatService.createGroupChat({
      creatorId: req.user.id,
      dto,
    });

    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Add members to a group chat (Admin only)' })
  @ApiParam({ name: 'id', description: 'Group Conversation UUID' })
  @Post('groups/:id/members')
  @HttpCode(HttpStatus.OK)
  async addGroupMembers(@Req() req, @Param('id') id: string, @Body() dto: AddGroupMembersDto) {
    const result = await this.chatService.addGroupMembers({
      conversationId: id,
      requesterId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      id,
      SOCKET_CONFIG.events.CHAT.GROUP_UPDATED,
      { action: 'members_added', ...result },
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Remove a member or leave group chat' })
  @ApiParam({ name: 'id', description: 'Group Conversation UUID' })
  @ApiParam({ name: 'memberId', description: 'Target User UUID' })
  @Delete('groups/:id/members/:memberId')
  @HttpCode(HttpStatus.OK)
  async removeGroupMember(
    @Req() req,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    const result = await this.chatService.removeGroupMember({
      conversationId: id,
      requesterId: req.user.id,
      targetUserId: memberId,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      id,
      SOCKET_CONFIG.events.CHAT.GROUP_UPDATED,
      { action: 'member_removed', ...result },
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Get user inbox (list of conversations with decrypted lastMessage)' })
  @Get('inbox')
  @HttpCode(HttpStatus.OK)
  async getInbox(@Req() req, @Query() query: DBaseQuery) {
    const result = await this.chatService.getUserInbox({
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

  @ApiOperation({ summary: 'Get decrypted message history of a conversation' })
  @ApiParam({ name: 'id', type: 'string', description: 'Conversation UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, type: String })
  @Get('conversations/:id/messages')
  @HttpCode(HttpStatus.OK)
  async getMessages(
    @Req() req,
    @Param('id') id: string,
    @Query() query: queryTypes.PaginationOptions & { search?: string },
  ) {
    const result = await this.chatService.getMessages({
      conversationId: id,
      userId: req.user.id,
      pagination: query,
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Upload and send media/file attachments directly in a conversation',
  })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FilesInterceptor('files', 10))
  @Post('conversations/:id/attachments')
  @HttpCode(HttpStatus.CREATED)
  async uploadConversationAttachments(
    @Req() req,
    @Param('id') conversationId: string,
    @UploadedFiles(FileValidators.Message()) files: Express.Multer.File[],
    @Body('content') content?: string,
    @Body('replyToMessageId') replyToMessageId?: string,
    @Body('tempId') tempId?: string,
  ) {
    if (!files || !files.length) {
      throw new BadRequestException('At least one attachment file is required');
    }

    const { message, recipientIds } = await this.chatService.uploadAndSendAttachmentMessage({
      senderId: req.user.id,
      conversationId,
      files,
      content,
      replyToMessageId,
      tempId,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversationId,
      SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
      message,
    );

    recipientIds.forEach((uid) => {
      if (uid !== req.user.id) {
        this.realtimeEmitter.emitToUser(
          SOCKET_CONFIG.namespaces.CHAT,
          uid,
          SOCKET_CONFIG.events.CHAT.NEW_MESSAGE,
          message,
        );
      }
    });

    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: message,
    };
  }

  @ApiOperation({ summary: 'Edit a message in a conversation' })
  @Patch('messages/edit')
  @HttpCode(HttpStatus.OK)
  async editMessage(@Req() req, @Body() dto: EditMessageDto) {
    const { message, recipientIds } = await this.chatService.editMessage({
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
      SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
      message,
    );
    recipientIds.forEach((uid) => {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.MESSAGE_EDITED,
        message,
      );
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: message,
    };
  }

  @ApiOperation({ summary: 'Recall (unsend) a message in a conversation' })
  @Delete('conversations/:id/messages/:messageId')
  @HttpCode(HttpStatus.OK)
  async recallMessage(
    @Req() req,
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
  ) {
    const result = await this.chatService.recallMessage({
      userId: req.user.id,
      dto: { conversationId, messageId },
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversationId,
      SOCKET_CONFIG.events.CHAT.MESSAGE_RECALLED,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Toggle emoji reaction on a message' })
  @Post('messages/react')
  @HttpCode(HttpStatus.OK)
  async reactMessage(@Req() req, @Body() dto: ReactMessageDto) {
    const result = await this.chatService.toggleReaction({
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
      SOCKET_CONFIG.events.CHAT.MESSAGE_REACTION,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Pin or unpin a message in a conversation' })
  @Post('messages/pin')
  @HttpCode(HttpStatus.OK)
  async pinMessage(@Req() req, @Body() dto: PinMessageDto) {
    const result = await this.chatService.togglePinMessage({
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
      SOCKET_CONFIG.events.CHAT.MESSAGE_PINNED,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Start a direct chat (1-1) with another user' })
  @ApiBody({ type: CreateDirectChatDto })
  @Post('direct')
  @HttpCode(HttpStatus.OK)
  async createDirectChat(@Req() req, @Body() dto: CreateDirectChatDto) {
    const result = await this.chatService.getOrCreateDirectConversation({
      senderId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Mute or unmute a conversation' })
  @Put('conversations/:id/mute')
  @HttpCode(HttpStatus.OK)
  async muteConversation(@Req() req, @Param('id') id: string, @Body() dto: MuteConversationDto) {
    const result = await this.chatService.setMuteConversation({
      conversationId: id,
      userId: req.user.id,
      isMuted: dto.isMuted,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Mark all messages in a conversation as read' })
  @Put('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(@Req() req, @Param('id') id: string) {
    const result = await this.chatService.markConversationAsRead({
      userId: req.user.id,
      conversationId: id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Register E2EE Public Key for end-to-end encrypted conversations',
  })
  @Post('e2ee/keys')
  @HttpCode(HttpStatus.OK)
  async registerPublicKey(@Req() req, @Body() dto: RegisterPublicKeyDto) {
    const bundle = await this.chatService.registerE2EEPublicKey(req.user.id, dto);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: bundle,
    };
  }

  @ApiOperation({
    summary: 'Get E2EE Public Keys of all participants in a conversation',
  })
  @Get('conversations/:id/e2ee-keys')
  @HttpCode(HttpStatus.OK)
  async getConversationPublicKeys(@Req() req, @Param('id') id: string) {
    const keys = await this.chatService.getConversationPublicKeys(id, req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: keys,
    };
  }

  @ApiOperation({
    summary: 'Get WebRTC STUN/TURN ICE server credentials for voice & video calls',
  })
  @Get('calls/ice-servers')
  @HttpCode(HttpStatus.OK)
  getIceServers(@Req() req) {
    const data = this.chatService.getWebRtcIceServers(req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }
}
