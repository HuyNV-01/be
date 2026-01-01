import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse } from '@nestjs/swagger';

import { HTTP_RESPONSE } from 'src/constants/http-response';
import { DBaseQuery } from 'src/dto/base-query.dto';
import {
  GetContactsDto,
  SendFriendRequestDto,
  UpdateContactAliasDto,
} from 'src/dto/contact/contact.dto';
import type { IBaseReq } from 'src/interface';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ContactsService } from './contacts.service';

@Controller('contacts')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class ContactsController {
  constructor(private readonly contactsService: ContactsService) {}

  @ApiOperation({ summary: 'Get contact list/friend requests' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get successful list',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          data: [
            {
              id: '1459f2b5-1b8f-483a-892d-7e7f7828a794',
              userId: 'dbe79dd8-233d-45dd-8189-ab24d7e005b1',
              contactId: 'dfc46127-c6e3-4d57-be54-337e9f3c4b3a',
              contactUser: {
                id: 'dfc46127-c6e3-4d57-be54-337e9f3c4b3a',
                email: 'huynv020111@gmail.com',
                name: 'NguyễnHuy',
                avatar: null,
              },
              status: 'PENDING_SENT',
              alias: null,
            },
          ],
          meta: {
            total: 100,
            page: 1,
            limit: 10,
            totalPages: 10,
          },
        },
      },
    },
  })
  @Get()
  @HttpCode(HttpStatus.OK)
  async getContacts(@Req() req: IBaseReq, @Query() query: GetContactsDto) {
    const result = await this.contactsService.getContacts({
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

  @ApiOperation({ summary: 'Send friend request' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Invitation sent successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          success: true,
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'User not found',
    schema: {
      example: {
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.USER.NOT_FOUND.message,
        code: HTTP_RESPONSE.USER.NOT_FOUND.code,
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'Already friends or sent an invitation',
    schema: {
      example: {
        status: HttpStatus.CONFLICT,
        message: HTTP_RESPONSE.CONTACT.CONFLICT_FRIEND.message,
        code: HTTP_RESPONSE.CONTACT.CONFLICT_FRIEND.code,
      },
    },
  })
  @Post('request')
  @HttpCode(HttpStatus.OK)
  async sendRequest(@Req() req: IBaseReq, @Body() dto: SendFriendRequestDto) {
    const result = await this.contactsService.sendFriendRequest({
      userId: req.user.id,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Accept friend request' })
  @ApiParam({
    name: 'senderId',
    description: 'ID of the inviter (the person who wants to accept)',
    type: 'string',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Friend accepted',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.SUCCESS.code,
        data: {
          success: true,
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No invitation found',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.CONTACT.FRIEND_NOT_FOUND.message,
        code: HTTP_RESPONSE.CONTACT.FRIEND_NOT_FOUND.code,
      },
    },
  })
  @Post('accept/:senderId')
  @HttpCode(HttpStatus.OK)
  async acceptRequest(@Req() req: IBaseReq, @Param('senderId') senderId: string) {
    const result = await this.contactsService.acceptFriendRequest({
      userId: req.user.id,
      senderId,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Delete friend / Cancel invitation / Decline invitation',
  })
  @ApiParam({
    name: 'targetId',
    description: 'ID of the person you want to delete/cancel',
    type: 'string',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Delete successful',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
        data: {
          success: true,
        },
      },
    },
  })
  @Delete(':targetId')
  @HttpCode(HttpStatus.OK)
  async removeContact(@Req() req: IBaseReq, @Param('targetId') targetId: string) {
    const result = await this.contactsService.removeContact({
      userId: req.user.id,
      targetId,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Set Alias ​​for your friends' })
  @ApiParam({
    name: 'targetId',
    description: 'Friend ID needs to be named',
    type: 'string',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Update successful',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
        data: {
          id: 'uuid-1',
          userId: 'uuid-2',
          contactId: 'uuid-3',
          status: 'PENDING_SENT',
          alias: 'a',
        },
      },
    },
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'No friends found',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.CONTACT.NOT_FOUND.message,
        code: HTTP_RESPONSE.CONTACT.NOT_FOUND.code,
      },
    },
  })
  @Put('alias/:targetId')
  @HttpCode(HttpStatus.OK)
  async updateAlias(
    @Req() req: IBaseReq,
    @Param('targetId') targetId: string,
    @Body() dto: UpdateContactAliasDto,
  ) {
    const result = await this.contactsService.updateAlias({
      userId: req.user.id,
      targetId,
      dto,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Get list of contact users with search and pagination',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get contact users successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          data: [
            {
              id: '1ecabccf-e1af-46ed-8a23-9876cf27a04a',
              avatar: null,
              contactStatus: 'FRIEND',
              email: 'user@gmail.com',
              name: 'user',
              status: 1,
              createdAt: '2025-12-14T03:10:57.343Z',
            },
          ],
          meta: {
            total: 100,
            page: 1,
            limit: 10,
            totalPages: 10,
          },
        },
      },
    },
  })
  @Get('find-contact-users')
  @HttpCode(HttpStatus.OK)
  async findContactUsers(@Req() req: IBaseReq, @Query() query: DBaseQuery) {
    const result = await this.contactsService.findContactUsers({
      query,
      userId: req.user.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }
}
