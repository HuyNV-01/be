/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';

import { HTTP_RESPONSE } from 'src/constants/http-response';
import { DBaseQuery } from 'src/dto/base-query.dto';
import { CreateGroupDto } from 'src/dto/chat/chat.dto';
import { CreateDirectChatDto } from 'src/dto/chat/create-direct-chat.dto';
import * as queryTypes from 'src/types/query.types';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ChatService } from './chat.service';

@Controller('chat')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class ChatController {
  constructor(private readonly chatService: ChatService) {}
  private readonly logger = new Logger(ChatController.name, {
    timestamp: true,
  });

  @ApiOperation({ summary: 'Create a new group chat' })
  @ApiBody({ type: CreateGroupDto })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description: 'Group created successfully',
    schema: {
      example: {
        statusCode: HttpStatus.CREATED,
        message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
        data: {
          id: 'uuid',
          name: 'Team Project',
          type: 'GROUP',
          createdAt: '2023-10-01T00:00:00Z',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: 'Unauthorized' })
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

  @ApiOperation({ summary: 'Get user inbox (list of conversations)' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 10 })
  @ApiQuery({
    name: 'sort',
    required: false,
    type: String,
    example: 'lastMessageAt:DESC',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    type: String,
    example: 'user 1',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get inbox successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          data: [
            {
              id: 'uuid',
              name: 'Group A',
              lastMessage: 'Hello world',
              unreadCount: 2,
              avatar: 'https://example.com/avatar.png',
              isOnline: false,
              type: 'GROUP',
              lastMessageAt: '2023-10-01T12:00:00Z',
              partnerId: 'uuid', // only for DIRECT type
            },
          ],
          meta: {
            page: 1,
            limit: 10,
            total: 50,
          },
        },
      },
    },
  })
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

  @ApiOperation({ summary: 'Get message history of a conversation' })
  @ApiParam({ name: 'id', type: 'string', description: 'Conversation UUID' })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get messages successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          data: [
            {
              id: 'msg_uuid',
              content: 'Hello there',
              senderId: 'user_uuid',
              createdAt: '2023-10-01T10:00:00Z',
            },
          ],
          meta: {
            page: 1,
            limit: 20,
            total: 100,
          },
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.FORBIDDEN,
    description: 'User not in this conversation',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Conversation not found',
  })
  @Get('conversations/:id/messages')
  @HttpCode(HttpStatus.OK)
  async getMessages(
    @Req() req,
    @Param('id') id: string,
    @Query() query: queryTypes.PaginationOptions,
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

  @ApiOperation({ summary: 'Start a direct chat (1-1) with another user' })
  @ApiBody({ type: CreateDirectChatDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Create chat successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          id: 'b0122a22-98e7-422c-ae10-752f889456f9',
          createdAt: '2025-11-28T03:18:41.437Z',
          createdBy: null,
          updatedAt: '2025-11-28T03:18:41.437Z',
          updatedBy: null,
          deletedAt: null,
          deletedBy: null,
          type: 'DIRECT',
          name: null,
          avatar: null,
          lastMessage: null,
          lastMessageSenderId: null,
          lastMessageType: null,
          lastMessageAt: '2025-11-28T03:18:41.434Z',
          partnerInfo: {
            id: '45a0e4d1-8222-47d7-a639-f566ec198bac',
            email: 'huynv020111@gmail.com',
            name: 'Test user',
            status: 1,
          },
        },
      },
    },
  })
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

  @ApiOperation({ summary: 'Update read messages' })
  @ApiParam({ name: 'id', type: 'string', description: 'Conversation UUID' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Update read message successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
        data: {
          success: true,
        },
      },
    },
  })
  @Put('conversations/:id/read')
  @HttpCode(HttpStatus.OK)
  async markAsRead(@Req() req, @Param('id') id: string) {
    const label = `[markAsRead]`;
    this.logger.debug(`${label} id -> ${id}`);
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
}
