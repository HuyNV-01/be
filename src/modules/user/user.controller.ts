import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { UserService } from './user.service';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';
import { GetListUserDto } from 'src/dto/user/get-list-user.dto';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { IBaseReq } from 'src/interface';
import { UpdateAvatarDto } from 'src/dto/user/update-avatar.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { FileValidators } from 'src/common/pipes/file-validation.pipe';

@Controller('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: 'Get list of users with search and pagination' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get users successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          data: [
            {
              id: 'uuid-1',
              email: 'john@example.com',
              name: 'John Doe',
              status: 1,
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
  async findAll(@Query() query: GetListUserDto) {
    const result = await this.userService.getList({ query });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Get detailed user profile',
    description:
      'Returns user info along with friend count, group count, and relationship status relative to the requester.',
  })
  @ApiParam({
    name: 'id',
    description: 'Target User ID',
    example: 'dbe79dd8-233d-45dd-8189-ab24d7e005b1',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get profile successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          relationship: 'FRIEND',
          isMe: false,
          email: 'u@gmail.com',
          name: 'example',
          role: 'USER',
          status: 1,
          currentSignInAt: '',
          lastSignInAt: '',
          id: 'dbe79dd8-233d-45dd-8189-ab24d7e005b1',
          createdAt: '',
          createdBy: null,
          updatedAt: '',
          updatedBy: null,
          deletedAt: null,
          deletedBy: null,
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
  @Get('profile/:id')
  @HttpCode(HttpStatus.OK)
  async getProfile(@Req() req: IBaseReq, @Param('id') id: string) {
    const result = await this.userService.getUserProfile({
      targetUserId: id,
      requesterId: req.user.id,
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Get my own profile details' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get my profile successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
        data: {
          relationship: null,
          isMe: true,
          email: 'u@gmail.com',
          name: 'example',
          role: 'USER',
          status: 1,
          currentSignInAt: '',
          lastSignInAt: '',
          id: 'dbe79dd8-233d-45dd-8189-ab24d7e005b1',
          createdAt: '',
          createdBy: null,
          updatedAt: '',
          updatedBy: null,
          deletedAt: null,
          deletedBy: null,
        },
      },
    },
  })
  @Get('me')
  @HttpCode(HttpStatus.OK)
  async getMyProfile(@Req() req: IBaseReq) {
    const result = await this.userService.getUserProfile({
      targetUserId: req.user.id,
      requesterId: req.user.id,
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Update user avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File ảnh avatar mới',
    type: UpdateAvatarDto,
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Updated avatar successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
        data: {
          url: 'https://example.com/path/to/new-avatar.jpg',
        },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid file' })
  @UseInterceptors(FileInterceptor('file'))
  @Put('avatar')
  @HttpCode(HttpStatus.OK)
  async updateAvatar(
    @Req() req: IBaseReq,
    @UploadedFile(FileValidators.Image()) file: Express.Multer.File,
  ) {
    const userId = req.user.id;
    const result = await this.userService.updateAvatar(userId, file);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @Delete('avatar')
  @ApiOperation({ summary: 'Delete user avatar' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Avatar has been deleted successfully',
    schema: {
      example: {
        status: HttpStatus.OK,
        message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
        code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
      },
    },
  })
  async deleteAvatar(@Req() req: IBaseReq) {
    const userId = req.user.id;
    await this.userService.deleteAvatar(userId);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
    };
  }
}
