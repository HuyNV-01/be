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
  ForwardMessageDto,
  GetSharedAssetsQueryDto,
  MuteConversationDto,
  PinMessageDto,
  ReactMessageDto,
  RegisterPublicKeyDto,
  UpdateConversationSettingsDto,
  UpdateDisappearingMessagesDto,
  UpdateGroupMemberRoleDto,
  UpdateParticipantNicknameDto,
} from 'src/dto/chat/call-and-security.dto';
import {
  ClosePollDto,
  CreateGroupDto,
  CreatePollDto,
  FetchLinkPreviewQueryDto,
  SendMessageDto,
  VotePollDto,
} from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import {
  CreateInternalNoteDto,
  CreateQuickReplyTemplateDto,
  FinalizeMaskedVoipCallDto,
  InitiateMaskedVoipCallDto,
  OmnichannelInboxFilterDto,
  SendPrivateReplyFromCommentDto,
  SnoozeConversationDto,
  ToggleCommentLikeDto,
  ToggleCommentVisibilityDto,
  TransferConversationDto,
  TranslateChatMessageDto,
  UpdateQuickReplyTemplateDto,
} from 'src/dto/chat/omnichannel-inbox.dto';
import * as queryTypes from 'src/types/query.types';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { GranularIamService } from '../iam/iam.service';
import { ChatService } from './chat.service';
import { AccountabilityTimelineService } from './services/accountability-timeline.service';
import { AgentCollisionLockService } from './services/agent-collision-lock.service';
import { CallSignalingService } from './services/call-signaling.service';
import { ConversationSnoozeService } from './services/conversation-snooze.service';
import { LinkPreviewService } from './services/link-preview.service';
import { MaskedVoipCallService } from './services/masked-voip-call.service';
import { OmnichannelInboxQueryService } from './services/omnichannel-inbox-query.service';
import { QuickReplyService } from './services/quick-reply.service';
import { RealtimeChatTranslationService } from './services/realtime-chat-translation.service';

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
    private readonly linkPreviewService: LinkPreviewService,
    private readonly callSignalingService: CallSignalingService,
    private readonly granularIamService: GranularIamService,
    private readonly omnichannelInboxQueryService: OmnichannelInboxQueryService,
    private readonly agentCollisionLockService: AgentCollisionLockService,
    private readonly conversationSnoozeService: ConversationSnoozeService,
    private readonly quickReplyService: QuickReplyService,
    private readonly accountabilityTimelineService: AccountabilityTimelineService,
    private readonly maskedVoipCallService: MaskedVoipCallService,
    private readonly realtimeChatTranslationService: RealtimeChatTranslationService,
  ) {}

  @ApiOperation({
    summary: 'Get active ongoing call in a conversation (for Group Call Banner / Rejoin)',
  })
  @Get('conversations/:id/active-call')
  @HttpCode(HttpStatus.OK)
  async getConversationActiveCall(@Req() req, @Param('id') id: string) {
    await this.chatService.ensureParticipant(id, req.user.id);
    const session = await this.callSignalingService.getActiveCallByConversation(id);
    if (!session) {
      return {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: null,
      };
    }
    const membersInfo = await this.chatService.getConversationMembersInfo(id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: {
        ...session,
        membersInfo,
      },
    };
  }

  @ApiOperation({ summary: 'Get or create personal Saved Messages (My Cloud) conversation' })
  @Post('saved-messages')
  @HttpCode(HttpStatus.OK)
  async getOrCreateSavedMessages(@Req() req) {
    const result = await this.chatService.getOrCreateSavedMessages(req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Create a group poll message' })
  @Post('polls')
  @HttpCode(HttpStatus.CREATED)
  async createPoll(@Req() req, @Body() dto: CreatePollDto) {
    const { message, recipientIds } = await this.chatService.createPollMessage({
      senderId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
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

  @ApiOperation({ summary: 'Vote on a poll message' })
  @Post('polls/vote')
  @HttpCode(HttpStatus.OK)
  async votePoll(@Req() req, @Body() dto: VotePollDto) {
    const result = await this.chatService.votePollMessage({
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
      SOCKET_CONFIG.events.CHAT.POLL_UPDATED,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Close a poll message' })
  @Patch('polls/close')
  @HttpCode(HttpStatus.OK)
  async closePoll(@Req() req, @Body() dto: ClosePollDto) {
    const result = await this.chatService.closePollMessage({
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
      SOCKET_CONFIG.events.CHAT.POLL_UPDATED,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Fetch OpenGraph link preview metadata (SSRF-safe)' })
  @Get('link-preview')
  @HttpCode(HttpStatus.OK)
  async getLinkPreview(@Query() query: FetchLinkPreviewQueryDto) {
    const data = await this.linkPreviewService.fetchLinkPreview(query.url);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

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
    result.recipientIds?.forEach((uid) => {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.MESSAGE_RECALLED,
        result,
      );
    });

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

  @ApiOperation({
    summary: 'Send a message via HTTP REST (Automatic Fallback when Socket is reconnecting)',
  })
  @ApiBody({ type: SendMessageDto })
  @Post('messages')
  @HttpCode(HttpStatus.CREATED)
  async sendMessageHttpFallback(@Req() req, @Body() dto: SendMessageDto) {
    const { message, recipientIds } = await this.chatService.sendMessage({
      senderId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      dto.conversationId,
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

  @ApiOperation({ summary: 'Get conversation details, member nicknames, privacy and block state' })
  @Get('conversations/:id/details')
  @HttpCode(HttpStatus.OK)
  async getConversationDetails(@Req() req, @Param('id') id: string) {
    const data = await this.chatService.getConversationDetails(id, req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({ summary: 'Get all pinned messages in a conversation' })
  @Get('conversations/:id/pinned')
  @HttpCode(HttpStatus.OK)
  async getPinnedMessages(@Req() req, @Param('id') id: string) {
    const data = await this.chatService.getPinnedMessages(id, req.user.id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({ summary: 'Get shared media, files, and links in a conversation' })
  @Get('conversations/:id/shared-assets')
  @HttpCode(HttpStatus.OK)
  async getSharedAssets(
    @Req() req,
    @Param('id') id: string,
    @Query() query: GetSharedAssetsQueryDto,
  ) {
    const data = await this.chatService.getConversationSharedAssets({
      conversationId: id,
      userId: req.user.id,
      query,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({ summary: 'Update nickname of a participant in a conversation' })
  @Put('conversations/:id/nickname')
  @HttpCode(HttpStatus.OK)
  async updateNickname(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateParticipantNicknameDto,
  ) {
    const result = await this.chatService.updateParticipantNickname({
      conversationId: id,
      requesterId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      id,
      SOCKET_CONFIG.events.CHAT.NICKNAME_UPDATED,
      result,
    );

    result.recipientIds?.forEach((uid) => {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        uid,
        SOCKET_CONFIG.events.CHAT.NICKNAME_UPDATED,
        result,
      );
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Update conversation notification, sound, read receipts & restrict settings',
  })
  @Patch('conversations/:id/settings')
  @HttpCode(HttpStatus.OK)
  async updateConversationSettings(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateConversationSettingsDto,
  ) {
    const result = await this.chatService.updateConversationSettings({
      conversationId: id,
      userId: req.user.id,
      dto,
    });

    if (result.shouldBroadcastPresenceChange && result.partnerId) {
      this.realtimeEmitter.emitToUser(
        SOCKET_CONFIG.namespaces.CHAT,
        result.partnerId,
        SOCKET_CONFIG.events.USER_STATUS,
        {
          userId: req.user.id,
          isOnline: result.isUserCurrentlyOnline,
          lastActive: new Date(),
        },
      );
    }

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Configure disappearing (self-destructing) messages timer' })
  @Patch('conversations/:id/disappearing')
  @HttpCode(HttpStatus.OK)
  async updateDisappearingMessages(
    @Req() req,
    @Param('id') id: string,
    @Body() dto: UpdateDisappearingMessagesDto,
  ) {
    const result = await this.chatService.updateDisappearingMessages({
      conversationId: id,
      userId: req.user.id,
      dto,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      id,
      SOCKET_CONFIG.events.CHAT.CONVERSATION_SETTINGS_UPDATED,
      result,
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Delete (clear & hide) conversation history for current user' })
  @Delete('conversations/:id')
  @HttpCode(HttpStatus.OK)
  async deleteConversation(@Req() req, @Param('id') id: string) {
    const result = await this.chatService.deleteConversationForUser({
      conversationId: id,
      userId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Update member role or transfer ownership in a group chat (Owner only)',
  })
  @ApiParam({ name: 'id', description: 'Group Conversation UUID' })
  @ApiParam({ name: 'memberId', description: 'Target Member User UUID' })
  @Patch('groups/:id/members/:memberId/role')
  @HttpCode(HttpStatus.OK)
  async updateGroupMemberRole(
    @Req() req,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateGroupMemberRoleDto,
  ) {
    const result = await this.chatService.updateGroupMemberRole({
      conversationId: id,
      requesterId: req.user.id,
      targetUserId: memberId,
      role: dto.role,
    });

    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      id,
      SOCKET_CONFIG.events.CHAT.GROUP_UPDATED,
      { action: 'role_updated', ...result },
    );

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Forward a message to multiple conversations' })
  @Post('messages/forward')
  @HttpCode(HttpStatus.CREATED)
  async forwardMessage(@Req() req, @Body() dto: ForwardMessageDto) {
    const results = await this.chatService.forwardMessage({
      senderId: req.user.id,
      dto,
    });

    results.forEach(({ conversationId, message, recipientIds }) => {
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
    });

    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: results.map((r) => r.message),
    };
  }

  // ============================================================================
  // SPRINT 2 — OMNICHANNEL INBOX 18-CRITERIA FILTER, INTERNAL NOTE, SNOOZE,
  // COLLISION LOCK, QUICK REPLIES, MASKED VOIP & REAL-TIME TRANSLATION
  // ============================================================================

  @ApiOperation({
    summary:
      'F03.1 & F03.2: Truy vấn Hộp thư bán hàng đa kênh 18 tiêu chí kết hợp toán tử Tag AND / OR / NOT',
  })
  @Post('omnichannel/query')
  @HttpCode(HttpStatus.OK)
  async queryOmnichannelInbox(@Req() req, @Body() dto: OmnichannelInboxFilterDto) {
    const memberCtx = await this.granularIamService.getEffectiveMemberContext(
      dto.shopId,
      req.user.id,
    );
    const data = await this.omnichannelInboxQueryService.queryMergedConversations(dto, memberCtx);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.5: Tạo Ghi chú nội bộ (Alt+N) & @mention đồng nghiệp (Không gửi ra Facebook/Zalo bên ngoài)',
  })
  @Post('conversations/:id/internal-note')
  @HttpCode(HttpStatus.CREATED)
  async createInternalNote(
    @Req() req,
    @Param('id') conversationId: string,
    @Body() dto: CreateInternalNoteDto,
  ) {
    const { message, recipientIds } = await this.chatService.createInternalNote({
      senderId: req.user.id,
      conversationId,
      content: dto.content,
      mentionedUserIds: dto.mentionedUserIds,
      replyToMessageId: dto.replyToMessageId,
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

  @ApiOperation({
    summary: 'F03.6: Đặt lịch hẹn nhắc chăm sóc lại (Snooze Conversation)',
  })
  @Post('conversations/:id/snooze')
  @HttpCode(HttpStatus.OK)
  async snoozeConversation(
    @Req() req,
    @Param('id') conversationId: string,
    @Body() dto: SnoozeConversationDto,
  ) {
    const data = await this.conversationSnoozeService.snoozeConversation({
      conversationId,
      actorUserId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.6: Hủy hẹn giờ Snooze để đưa hội thoại về danh sách chờ trả lời ngay',
  })
  @Delete('conversations/:id/snooze')
  @HttpCode(HttpStatus.OK)
  async cancelSnooze(@Req() req, @Param('id') conversationId: string) {
    const data = await this.conversationSnoozeService.cancelSnooze({
      conversationId,
      actorUserId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.8 & F03.9: Chuyển giao hội thoại cho đồng nghiệp & ghi nhận Dòng thời gian Trách nhiệm',
  })
  @Post('conversations/:id/transfer')
  @HttpCode(HttpStatus.OK)
  async transferConversation(
    @Req() req,
    @Param('id') conversationId: string,
    @Body() dto: TransferConversationDto,
  ) {
    const data = await this.accountabilityTimelineService.transferConversation({
      conversationId,
      actorUserId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.7 & T03: Kiểm tra trạng thái Khóa chống đụng độ nhân viên (Collision Lock)',
  })
  @Get('conversations/:id/collision-lock')
  @HttpCode(HttpStatus.OK)
  async getCollisionLock(@Param('id') conversationId: string) {
    const data = await this.agentCollisionLockService.getLockStatus(conversationId);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.7 & T03: Giữ hoặc gia hạn Khóa chống đụng độ nhân viên (Heartbeat 30s)',
  })
  @Post('conversations/:id/collision-lock')
  @HttpCode(HttpStatus.OK)
  async acquireCollisionLock(@Req() req, @Param('id') conversationId: string) {
    const data = await this.agentCollisionLockService.acquireOrHeartbeatLock({
      conversationId,
      userId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.7 & T03: Giải phóng Khóa chống đụng độ khi nhân viên rời hội thoại',
  })
  @Delete('conversations/:id/collision-lock')
  @HttpCode(HttpStatus.OK)
  async releaseCollisionLock(@Req() req, @Param('id') conversationId: string) {
    const data = await this.agentCollisionLockService.releaseLock({
      conversationId,
      userId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.7: Quản lý / Trưởng ca chiếm quyền xử lý cuộc hội thoại đang bị khóa (Force Takeover)',
  })
  @Post('conversations/:id/collision-lock/takeover')
  @HttpCode(HttpStatus.OK)
  async forceTakeoverCollisionLock(
    @Req() req,
    @Param('id') conversationId: string,
    @Body('shopId') shopId: string,
  ) {
    const data = await this.agentCollisionLockService.forceTakeOverLock({
      shopId,
      conversationId,
      requesterUserId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.10 & T04: Khởi tạo cuộc gọi chốt đơn ẩn SĐT (Masked WebRTC-to-SIP VoIP — Sale chỉ thấy 098***678)',
  })
  @Post('conversations/:id/masked-call')
  @HttpCode(HttpStatus.CREATED)
  async initiateMaskedVoipCall(
    @Req() req,
    @Param('id') conversationId: string,
    @Body() dto: InitiateMaskedVoipCallDto,
  ) {
    const data = await this.maskedVoipCallService.initiateMaskedPstnCall({
      conversationId,
      agentUserId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.10 & T04: Kết thúc cuộc gọi VoIP ẩn SĐT & đính kèm bong bóng ghi âm cuộc gọi (AudioWaveformPlayer)',
  })
  @Post('conversations/:id/masked-call/finalize')
  @HttpCode(HttpStatus.OK)
  async finalizeMaskedVoipCall(
    @Req() req,
    @Param('id') conversationId: string,
    @Body() dto: FinalizeMaskedVoipCallDto,
  ) {
    const data = await this.maskedVoipCallService.finalizeCallAndAttachRecordingBubble({
      conversationId,
      agentUserId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.11: Dịch tự động đa ngôn ngữ hai chiều trong khung chat',
  })
  @Post('translate')
  @HttpCode(HttpStatus.OK)
  async translateChatMessage(@Body() dto: TranslateChatMessageDto) {
    const data = await this.realtimeChatTranslationService.translateMessageOrDraft(dto);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.3 & F03.4: Lấy danh sách thư viện mẫu câu trả lời nhanh (/shortcut) của cửa hàng',
  })
  @Get('quick-replies/:shopId')
  @HttpCode(HttpStatus.OK)
  async listQuickReplyTemplates(@Param('shopId') shopId: string, @Query('search') search?: string) {
    const data = await this.quickReplyService.listTemplates(shopId, search);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.3 & F03.4: Tạo mẫu câu trả lời nhanh (/shortcut) kèm biến động & thẻ sản phẩm',
  })
  @Post('quick-replies/:shopId')
  @HttpCode(HttpStatus.CREATED)
  async createQuickReplyTemplate(
    @Param('shopId') shopId: string,
    @Body() dto: CreateQuickReplyTemplateDto,
  ) {
    const data = await this.quickReplyService.createTemplate(shopId, dto);
    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.3 & F03.4: Cập nhật mẫu câu trả lời nhanh (/shortcut)',
  })
  @Patch('quick-replies/:shopId/:templateId')
  @HttpCode(HttpStatus.OK)
  async updateQuickReplyTemplate(
    @Param('shopId') shopId: string,
    @Param('templateId') templateId: string,
    @Body() dto: UpdateQuickReplyTemplateDto,
  ) {
    const data = await this.quickReplyService.updateTemplate(shopId, templateId, dto);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.3 & F03.4: Xóa mẫu câu trả lời nhanh (/shortcut)',
  })
  @Delete('quick-replies/:shopId/:templateId')
  @HttpCode(HttpStatus.OK)
  async deleteQuickReplyTemplate(
    @Param('shopId') shopId: string,
    @Param('templateId') templateId: string,
  ) {
    const data = await this.quickReplyService.deleteTemplate(shopId, templateId);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.3 & F03.4: Nội suy biến động ({{customer_name}}, {{salutation}}, {{agent_name}}, {{shop_name}})',
  })
  @Post('quick-replies/:shopId/:templateId/interpolate')
  @HttpCode(HttpStatus.OK)
  async interpolateQuickReplyTemplate(
    @Param('shopId') shopId: string,
    @Param('templateId') templateId: string,
    @Body()
    body: {
      customerName?: string;
      salutation?: string;
      agentName?: string;
      trackingLink?: string;
    },
  ) {
    const data = await this.quickReplyService.interpolateTemplate({
      shopId,
      templateId,
      ...body,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.3 & F03.4: Ẩn hoặc hiện bình luận của khách trên nền tảng gốc để chống đối thủ cướp SĐT',
  })
  @Post('conversations/:id/messages/:messageId/comment-visibility')
  @HttpCode(HttpStatus.OK)
  async toggleCommentVisibility(
    @Req() req,
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ToggleCommentVisibilityDto,
  ) {
    const data = await this.chatService.toggleCommentVisibilityOnPlatform({
      userId: req.user.id,
      conversationId,
      messageId,
      isHidden: dto.isHidden,
    });
    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_VISIBILITY_UPDATED,
      data,
    );
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary: 'F03.3 & F03.4: Thả tim / Thích bình luận của khách hàng dưới tư cách Fanpage',
  })
  @Post('conversations/:id/messages/:messageId/comment-like')
  @HttpCode(HttpStatus.OK)
  async toggleCommentLike(
    @Req() req,
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: ToggleCommentLikeDto,
  ) {
    const data = await this.chatService.toggleCommentLikeOnPlatform({
      userId: req.user.id,
      conversationId,
      messageId,
      isLiked: dto.isLiked,
    });
    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_LIKE_UPDATED,
      data,
    );
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data,
    };
  }

  @ApiOperation({
    summary:
      'F03.3 & F03.4: Gửi tin nhắn riêng (Private Reply Inbox) từ bình luận bài viết/Livestream trong hạn 7 ngày',
  })
  @Post('conversations/:id/messages/:messageId/private-reply')
  @HttpCode(HttpStatus.OK)
  async sendPrivateReplyFromComment(
    @Req() req,
    @Param('id') conversationId: string,
    @Param('messageId') messageId: string,
    @Body() dto: SendPrivateReplyFromCommentDto,
  ) {
    const data = await this.chatService.sendPrivateReplyFromComment({
      senderId: req.user.id,
      conversationId,
      commentMessageId: messageId,
      content: dto.content,
      autoHideComment: dto.autoHideComment,
      autoLikeComment: dto.autoLikeComment,
    });
    this.realtimeEmitter.emitToConversation(
      SOCKET_CONFIG.namespaces.CHAT,
      conversationId,
      SOCKET_CONFIG.events.OMNICHANNEL_INBOX.COMMENT_PRIVATE_REPLY_SENT,
      data,
    );
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data,
    };
  }
}
