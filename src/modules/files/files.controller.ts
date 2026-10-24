import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';

import type { Request, Response } from 'express';
import { ValidRolesEnum } from 'src/common/enum';
import { FileValidators } from 'src/common/pipes/file-validation.pipe';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import {
  ConfirmPresignedUploadDto,
  CreatePresignedUploadDto,
  MultipleFilesUploadBodyDto,
  SingleFileUploadBodyDto,
  UploadFileQueryDto,
} from 'src/dto/file/file.dto';
import type { IBaseReq } from 'src/interface';
import { Readable } from 'stream';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { LocalStorageProvider } from '../storage/providers/local-storage.provider';
import { FilesService } from './files.service';

@ApiTags('Files & Storage')
@Controller('files')
export class FilesController {
  constructor(
    private readonly filesService: FilesService,
    private readonly localStorageProvider: LocalStorageProvider,
  ) {}

  @Get('health')
  @ApiOperation({
    summary: 'Check active storage provider health & latency',
  })
  async checkStorageHealth() {
    const status = await this.filesService.getStorageHealth();
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: status,
    };
  }

  @Post('upload')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Upload a single file (auto WebP optimization, thumbnail, SHA-256 deduplication)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: SingleFileUploadBodyDto })
  @UseInterceptors(FileInterceptor('file'))
  @HttpCode(HttpStatus.CREATED)
  async uploadSingle(
    @Req() req: IBaseReq,
    @Query() query: UploadFileQueryDto,
    @UploadedFile(FileValidators.Message()) file: Express.Multer.File,
  ) {
    const uploaded = await this.filesService.uploadFile(file, req.user.id, {
      folder: query.folder,
      optimize: query.optimize,
      generateThumbnail: query.generateThumbnail,
      resizeWidth: query.resizeWidth,
      deduplicate: query.deduplicate,
      retentionDays: query.retentionDays,
    });

    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: uploaded,
    };
  }

  @Post('upload-multiple')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Upload multiple files (up to 10 files at once)',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: MultipleFilesUploadBodyDto })
  @UseInterceptors(FilesInterceptor('files', 10))
  @HttpCode(HttpStatus.CREATED)
  async uploadMultiple(
    @Req() req: IBaseReq,
    @Query() query: UploadFileQueryDto,
    @UploadedFiles(FileValidators.Message()) files: Express.Multer.File[],
  ) {
    if (!files || !files.length) {
      throw new BadRequestException('At least one file is required');
    }

    const uploaded = await this.filesService.uploadMultipleFiles(files, req.user.id, {
      folder: query.folder,
      optimize: query.optimize,
      generateThumbnail: query.generateThumbnail,
      resizeWidth: query.resizeWidth,
      deduplicate: query.deduplicate,
      retentionDays: query.retentionDays,
    });

    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: uploaded,
    };
  }

  @Post('presigned-upload')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Generate a Presigned PUT URL for direct large-file upload to storage',
  })
  @HttpCode(HttpStatus.OK)
  async createPresignedUpload(@Body() dto: CreatePresignedUploadDto) {
    const result = await this.filesService.createPresignedUpload(dto);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: result,
    };
  }

  @Post('confirm-upload')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Verify and persist file record after direct presigned upload finishes',
  })
  @HttpCode(HttpStatus.CREATED)
  async confirmPresignedUpload(@Req() req: IBaseReq, @Body() dto: ConfirmPresignedUploadDto) {
    const saved = await this.filesService.confirmPresignedUpload(dto, req.user.id);
    return {
      status: HttpStatus.CREATED,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: saved,
    };
  }

  @Put('local-upload/:bucket/*path')
  @ApiOperation({
    summary: 'Built-in signed direct upload endpoint when STORAGE_PROVIDER=LOCAL',
  })
  async handleLocalSignedUpload(
    @Param('bucket') bucket: string,
    @Param('path') pathParam: string | string[],
    @Query('expires') expires: string,
    @Query('mimeType') mimeType: string,
    @Query('signature') signature: string,
    @Req() req: Request,
  ) {
    const objectKey = Array.isArray(pathParam) ? pathParam.join('/') : pathParam;
    const isValid = this.localStorageProvider.verifySignedToken({
      method: 'PUT',
      bucket,
      key: objectKey,
      expires: Number(expires),
      signature,
      mimeType,
    });

    if (!isValid) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.FILE.EXPIRED_OR_INVALID_TOKEN.message,
        code: HTTP_RESPONSE.FILE.EXPIRED_OR_INVALID_TOKEN.code,
      });
    }

    const result = await this.localStorageProvider.uploadStream(req as unknown as Readable, {
      bucket,
      path: objectKey,
      mimeType: mimeType || req.headers['content-type'] || 'application/octet-stream',
    });

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.CREATE_SUCCESS.code,
      data: result,
    };
  }

  @Get('local-download/:bucket/*path')
  @ApiOperation({
    summary: 'Built-in signed download/stream endpoint when STORAGE_PROVIDER=LOCAL',
  })
  async handleLocalSignedDownload(
    @Param('bucket') bucket: string,
    @Param('path') pathParam: string | string[],
    @Query('expires') expires: string,
    @Query('signature') signature: string,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ) {
    const objectKey = Array.isArray(pathParam) ? pathParam.join('/') : pathParam;
    const isValid = this.localStorageProvider.verifySignedToken({
      method: 'GET',
      bucket,
      key: objectKey,
      expires: Number(expires),
      signature,
    });

    if (!isValid) {
      throw new ForbiddenException({
        status: HttpStatus.FORBIDDEN,
        message: HTTP_RESPONSE.FILE.EXPIRED_OR_INVALID_TOKEN.message,
        code: HTTP_RESPONSE.FILE.EXPIRED_OR_INVALID_TOKEN.code,
      });
    }

    let range: { start?: number; end?: number } | undefined;
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : undefined;
      if (!Number.isNaN(start)) {
        range = { start, end };
      }
    }

    const streamRes = await this.localStorageProvider.downloadStream(objectKey, {
      bucket,
      range,
    });

    res.setHeader('Content-Type', streamRes.contentType);
    res.setHeader('Accept-Ranges', streamRes.acceptRanges || 'bytes');
    if (streamRes.contentLength !== undefined) {
      res.setHeader('Content-Length', String(streamRes.contentLength));
    }
    if (streamRes.contentRange) {
      res.setHeader('Content-Range', streamRes.contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.status(HttpStatus.OK);
    }

    streamRes.stream.pipe(res);
  }

  @Get(':id')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Get file metadata and temporary signed download URL by ID',
  })
  @ApiParam({ name: 'id', description: 'File UUID' })
  async getFileMetadata(@Param('id') id: string) {
    const file = await this.filesService.getFileById(id);
    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.GET_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.GET_SUCCESS.code,
      data: file,
    };
  }

  @Get(':id/stream')
  @ApiOperation({
    summary: 'Stream file or media with HTTP Range (206 Partial Content) support',
  })
  @ApiParam({ name: 'id', description: 'File UUID' })
  @ApiQuery({ name: 'download', required: false, type: Boolean })
  async streamFile(
    @Param('id') id: string,
    @Query('download') download: string | undefined,
    @Headers('range') rangeHeader: string | undefined,
    @Res() res: Response,
  ) {
    const { file, streamResult, isPartial } = await this.filesService.streamFileById(
      id,
      rangeHeader,
    );

    res.setHeader('Content-Type', streamResult.contentType);
    res.setHeader('Accept-Ranges', streamResult.acceptRanges || 'bytes');

    const dispositionType = download === 'true' ? 'attachment' : 'inline';
    res.setHeader(
      'Content-Disposition',
      `${dispositionType}; filename="${encodeURIComponent(file.originalName)}"`,
    );

    if (streamResult.contentLength !== undefined) {
      res.setHeader('Content-Length', String(streamResult.contentLength));
    }
    if (streamResult.etag) {
      res.setHeader('ETag', `"${streamResult.etag}"`);
    }

    if (isPartial && streamResult.contentRange) {
      res.setHeader('Content-Range', streamResult.contentRange);
      res.status(HttpStatus.PARTIAL_CONTENT);
    } else {
      res.status(HttpStatus.OK);
    }

    streamResult.stream.pipe(res);
  }

  @Delete(':id')
  @ApiBearerAuth('access-token')
  @UseGuards(JwtAuthGuard)
  @ApiOperation({
    summary: 'Soft delete or hard delete a file by ID',
  })
  @ApiParam({ name: 'id', description: 'File UUID' })
  @ApiQuery({ name: 'hard', required: false, type: Boolean })
  @ApiResponse({ status: HttpStatus.OK, description: 'File deleted successfully' })
  async deleteFile(@Req() req: IBaseReq, @Param('id') id: string, @Query('hard') hard?: string) {
    const file = await this.filesService.getFileById(id);

    if (
      file.uploaderId &&
      file.uploaderId !== req.user.id &&
      req.user.role !== ValidRolesEnum.ADMIN
    ) {
      throw new ForbiddenException('You do not have permission to delete this file');
    }

    if (hard === 'true') {
      await this.filesService.hardDeleteFile(id);
    } else {
      await this.filesService.softDeleteFile(id);
    }

    return {
      status: HttpStatus.OK,
      message: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.message,
      code: HTTP_RESPONSE.COMMON.DELETE_SUCCESS.code,
    };
  }
}
