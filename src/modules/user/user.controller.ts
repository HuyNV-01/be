import {
  Body,
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
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiResponse,
} from '@nestjs/swagger';

import { FileValidators } from 'src/common/pipes/file-validation.pipe';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { GetListUserDto } from 'src/dto/user/get-list-user.dto';
import { UpdateAvatarDto } from 'src/dto/user/update-avatar.dto';
import { UpdateProfileDto } from 'src/dto/user/update-profile.dto';
import type { IBaseReq } from 'src/interface';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { UserService } from './user.service';

@Controller('users')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: 'Get list of users with search and pagination' })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'Get users successfully',
  })
  @Get()
  @HttpCode(HttpStatus.OK)
  async findAll(@Req() req: IBaseReq, @Query() query: GetListUserDto) {
    const result = await this.userService.getList({
      query,
      requesterId: req.user?.id,
    });
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({
    summary: 'Get detailed user profile with 3-tier relationship privacy & block protection',
  })
  @ApiParam({
    name: 'id',
    description: 'Target User ID',
    example: 'dbe79dd8-233d-45dd-8189-ab24d7e005b1',
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

  @ApiOperation({ summary: 'Update my profile details (name, bio, phone, privacy settings)' })
  @Patch('profile')
  @HttpCode(HttpStatus.OK)
  async updateMyProfile(@Req() req: IBaseReq, @Body() dto: UpdateProfileDto) {
    const result = await this.userService.updateMyProfile(req.user.id, dto);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @ApiOperation({ summary: 'Update user avatar' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File ảnh avatar mới',
    type: UpdateAvatarDto,
  })
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
  async deleteAvatar(@Req() req: IBaseReq) {
    const userId = req.user.id;
    await this.userService.deleteAvatar(userId);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
    };
  }

  @ApiOperation({ summary: 'Update user cover photo' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    description: 'File ảnh bìa mới',
    type: UpdateAvatarDto,
  })
  @UseInterceptors(FileInterceptor('file'))
  @Put('cover')
  @HttpCode(HttpStatus.OK)
  async updateCover(
    @Req() req: IBaseReq,
    @UploadedFile(FileValidators.Image()) file: Express.Multer.File,
  ) {
    const userId = req.user.id;
    const result = await this.userService.updateCover(userId, file);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.UPDATE_SUCCESS.code,
      data: result,
    };
  }

  @Delete('cover')
  @ApiOperation({ summary: 'Delete user cover photo' })
  async deleteCover(@Req() req: IBaseReq) {
    const userId = req.user.id;
    await this.userService.deleteCover(userId);

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
    };
  }
}
