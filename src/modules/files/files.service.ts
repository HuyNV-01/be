import {
  BadRequestException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import * as crypto from 'crypto';
import { extname } from 'path';
import sharp from 'sharp';
import { FileProviderEnum } from 'src/common/enum';
import { FileSignatureHelper } from 'src/common/helper/file-signature.helper';
import { HTTP_RESPONSE } from 'src/constants/http-response';
import { ConfirmPresignedUploadDto, CreatePresignedUploadDto } from 'src/dto/file/file.dto';
import { FileEntity } from 'src/entity/file.entity';
import type {
  DownloadStreamOptions,
  IStorageProvider,
  PresignedUploadResponse,
  StorageHealthStatus,
  StorageStreamResult,
} from 'src/interface/storage.interface';
import { EntityManager, In, IsNull, Repository } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { StorageResolverService } from '../storage/storage-resolver.service';

export interface BufferedFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export interface FileUploadOptions {
  folder?: string;
  optimize?: boolean;
  resizeWidth?: number;
  quality?: number;
  generateThumbnail?: boolean;
  thumbnailWidth?: number;
  deduplicate?: boolean;
  retentionDays?: number;
}

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepo: Repository<FileEntity>,
    @Inject('STORAGE_PROVIDER')
    private readonly storageProvider: IStorageProvider,
    private readonly storageResolver: StorageResolverService,
  ) {}

  async uploadFile(
    file: BufferedFile,
    userId: string | null,
    options: FileUploadOptions = {},
    manager?: EntityManager,
  ): Promise<FileEntity> {
    const {
      folder = 'general',
      optimize = true,
      resizeWidth,
      quality = 80,
      generateThumbnail = false,
      thumbnailWidth = 240,
      deduplicate = true,
      retentionDays,
    } = options;

    if (FileSignatureHelper.isExecutableOrDangerous(file.buffer)) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.FILE.INVALID_SIGNATURE.message,
        code: HTTP_RESPONSE.FILE.INVALID_SIGNATURE.code,
      });
    }

    const { originalname } = file;
    let { buffer, mimetype, size } = file;
    let width: number | undefined;
    let height: number | undefined;
    let thumbnailBuffer: Buffer | undefined;
    let thumbnailMeta: { width?: number; height?: number } | undefined;

    const isSvgOrGif = mimetype.includes('svg') || mimetype.includes('gif');

    if (mimetype.startsWith('image/') && !isSvgOrGif && optimize) {
      try {
        const image = sharp(buffer, { failOn: 'none' }).rotate();
        const meta = await image.metadata();

        let pipeline = image.clone();
        if (resizeWidth && meta.width && meta.width > resizeWidth) {
          pipeline = pipeline.resize({ width: resizeWidth, withoutEnlargement: true });
        }

        const newBuffer = await pipeline.webp({ quality, effort: 4 }).toBuffer();
        const newMeta = await sharp(newBuffer).metadata();

        buffer = newBuffer;
        mimetype = 'image/webp';
        size = newBuffer.length;
        width = newMeta.width;
        height = newMeta.height;

        if (generateThumbnail) {
          thumbnailBuffer = await sharp(buffer)
            .resize({ width: thumbnailWidth, withoutEnlargement: true })
            .webp({ quality: 72, effort: 4 })
            .toBuffer();
          const thumbInfo = await sharp(thumbnailBuffer).metadata();
          thumbnailMeta = { width: thumbInfo.width, height: thumbInfo.height };
        }
      } catch (e: any) {
        this.logger.warn(`Image optimization fallback to original: ${e?.message || e}`);
      }
    }

    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const cleanFolder = folder.replace(/^\/+|\/+$/g, '') || 'general';
    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    let expiresAt: Date | null = null;
    if (retentionDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + retentionDays);
    }

    if (deduplicate) {
      const existingFile = await repo.findOne({
        where: {
          hash,
          provider: this.storageProvider.providerName,
          deletedAt: IsNull(),
        },
        order: { createdAt: 'DESC' },
      });

      if (existingFile) {
        this.logger.debug(
          `Deduplicated upload for "${originalname}" -> reusing physical object "${existingFile.path}"`,
        );
        const clonedRecord = repo.create({
          originalName: originalname,
          fileName: `${uuidv4()}${extname(existingFile.fileName)}`,
          mimeType: existingFile.mimeType,
          size: Number(existingFile.size),
          provider: existingFile.provider,
          bucket: existingFile.bucket,
          path: existingFile.path,
          url: existingFile.url,
          hash,
          expiresAt,
          uploaderId: userId || undefined,
          metadata: {
            ...existingFile.metadata,
            deduplicatedFrom: existingFile.id,
          },
        });
        return await repo.save(clonedRecord);
      }
    }

    const baseUuid = uuidv4();
    const ext = mimetype === 'image/webp' ? '.webp' : extname(originalname).toLowerCase();
    const fileName = `${baseUuid}${ext}`;
    const key = `${cleanFolder}/${fileName}`;

    const uploadRes = await this.storageProvider.upload(buffer, {
      path: key,
      mimeType: mimetype,
      isPublic: true,
    });

    let thumbnailUploadRes: { key: string; url: string } | undefined;
    if (thumbnailBuffer) {
      const thumbKey = `${cleanFolder}/thumbnails/${baseUuid}_thumb.webp`;
      try {
        const res = await this.storageProvider.upload(thumbnailBuffer, {
          path: thumbKey,
          mimeType: 'image/webp',
          isPublic: true,
        });
        thumbnailUploadRes = { key: res.key, url: res.url };
      } catch (thumbErr: any) {
        this.logger.warn(`Thumbnail upload failed: ${thumbErr?.message || thumbErr}`);
      }
    }

    try {
      const providerEnum = uploadRes.provider as FileProviderEnum;

      const newFile = repo.create({
        originalName: originalname,
        fileName,
        mimeType: mimetype,
        size,
        provider: providerEnum,
        bucket: uploadRes.bucket,
        path: uploadRes.key,
        url: uploadRes.url,
        hash,
        expiresAt,
        uploaderId: userId || undefined,
        metadata: {
          width,
          height,
          optimized: optimize && mimetype === 'image/webp',
          etag: uploadRes.etag,
          ...(thumbnailUploadRes
            ? {
                thumbnailKey: thumbnailUploadRes.key,
                thumbnailUrl: thumbnailUploadRes.url,
                thumbnailWidth: thumbnailMeta?.width,
                thumbnailHeight: thumbnailMeta?.height,
              }
            : {}),
        },
      });

      return await repo.save(newFile);
    } catch (error) {
      this.logger.error(`DB Save failed, rolling back storage: ${uploadRes.key}`);

      await this.storageProvider
        .delete(uploadRes.key, uploadRes.bucket)
        .catch((e) => this.logger.error(`Failed to rollback storage: ${e}`));

      if (thumbnailUploadRes) {
        await this.storageProvider
          .delete(thumbnailUploadRes.key, uploadRes.bucket)
          .catch(() => undefined);
      }

      throw error;
    }
  }

  async uploadMultipleFiles(
    files: BufferedFile[],
    userId: string | null,
    options: FileUploadOptions = {},
    manager?: EntityManager,
  ): Promise<FileEntity[]> {
    return Promise.all(files.map((file) => this.uploadFile(file, userId, options, manager)));
  }

  async createPresignedUpload(dto: CreatePresignedUploadDto): Promise<PresignedUploadResponse> {
    if (!this.storageProvider.getPresignedUploadUrl) {
      throw new BadRequestException('Active storage provider does not support presigned uploads');
    }

    const cleanFolder = (dto.folder || 'general').replace(/^\/+|\/+$/g, '') || 'general';
    const ext = extname(dto.originalName).toLowerCase();
    const fileName = `${uuidv4()}${ext}`;
    const key = `${cleanFolder}/${fileName}`;

    return this.storageProvider.getPresignedUploadUrl({
      path: key,
      mimeType: dto.mimeType,
      expiresIn: 900,
      maxSizeBytes: dto.size,
    });
  }

  async confirmPresignedUpload(
    dto: ConfirmPresignedUploadDto,
    userId: string | null,
  ): Promise<FileEntity> {
    if (!this.storageProvider.headObject) {
      throw new BadRequestException('Active storage provider does not support object verification');
    }

    const head = await this.storageProvider.headObject(dto.key, dto.bucket);
    if (!head) {
      throw new BadRequestException({
        status: HttpStatus.BAD_REQUEST,
        message: HTTP_RESPONSE.FILE.OBJECT_NOT_UPLOADED.message,
        code: HTTP_RESPONSE.FILE.OBJECT_NOT_UPLOADED.code,
      });
    }

    let expiresAt: Date | null = null;
    if (dto.retentionDays) {
      expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + dto.retentionDays);
    }

    const fileName = dto.key.split('/').pop() || `${uuidv4()}${extname(dto.originalName)}`;
    const presignedInfo = this.storageProvider.getPresignedUploadUrl
      ? await this.storageProvider.getPresignedUploadUrl({
          path: dto.key,
          mimeType: dto.mimeType,
          bucket: head.bucket,
        })
      : null;

    const entity = this.fileRepo.create({
      originalName: dto.originalName,
      fileName,
      mimeType: dto.mimeType || head.mimeType,
      size: head.size,
      provider: this.storageProvider.providerName,
      bucket: head.bucket,
      path: head.key,
      url: presignedInfo?.publicUrl || head.key,
      hash: head.etag || undefined,
      expiresAt,
      uploaderId: userId || undefined,
      metadata: {
        directUpload: true,
        etag: head.etag,
      },
    });

    return this.fileRepo.save(entity);
  }

  async getFileById(fileId: string): Promise<FileEntity & { signedUrl?: string }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.FILE.NOT_FOUND.message,
        code: HTTP_RESPONSE.FILE.NOT_FOUND.code,
      });
    }

    const provider = this.storageResolver.resolve(file.provider);
    let signedUrl: string | undefined;
    try {
      signedUrl = await provider.getPresignedUrl(file.path, file.bucket, 3600);
    } catch {
      signedUrl = file.url;
    }

    return Object.assign(file, { signedUrl });
  }

  async streamFileById(
    fileId: string,
    rangeHeader?: string,
  ): Promise<{ file: FileEntity; streamResult: StorageStreamResult; isPartial: boolean }> {
    const file = await this.fileRepo.findOne({ where: { id: fileId } });
    if (!file) {
      throw new NotFoundException({
        status: HttpStatus.NOT_FOUND,
        message: HTTP_RESPONSE.FILE.NOT_FOUND.message,
        code: HTTP_RESPONSE.FILE.NOT_FOUND.code,
      });
    }

    const provider = this.storageResolver.resolve(file.provider);
    if (!provider.downloadStream) {
      throw new BadRequestException('Storage provider does not support streaming');
    }

    const downloadOptions: DownloadStreamOptions = {
      bucket: file.bucket,
    };

    let isPartial = false;
    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const parts = rangeHeader.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : undefined;
      if (!Number.isNaN(start)) {
        downloadOptions.range = { start, end };
        isPartial = true;
      }
    }

    const streamResult = await provider.downloadStream(file.path, downloadOptions);
    return {
      file,
      streamResult: {
        ...streamResult,
        contentType: file.mimeType || streamResult.contentType,
      },
      isPartial,
    };
  }

  async getStorageHealth(): Promise<StorageHealthStatus> {
    if (this.storageProvider.healthCheck) {
      return this.storageProvider.healthCheck();
    }
    return {
      healthy: true,
      provider: this.storageProvider.providerName,
      bucket: 'default',
      latencyMs: 0,
    };
  }

  async softDeleteFile(fileId: string, manager?: EntityManager): Promise<boolean> {
    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const result = await repo.softDelete(fileId);

    return result.affected ? result.affected > 0 : false;
  }

  async hardDeleteFile(fileId: string, manager?: EntityManager): Promise<boolean> {
    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const file = await repo.findOne({
      where: { id: fileId },
      withDeleted: true,
    });

    if (!file) return false;

    const provider = this.storageResolver.resolve(file.provider);

    const refCount = await repo.count({
      where: {
        bucket: file.bucket,
        path: file.path,
      },
      withDeleted: true,
    });

    if (refCount <= 1) {
      try {
        await provider.delete(file.path, file.bucket);
        if (file.metadata?.thumbnailKey) {
          await provider
            .delete(String(file.metadata.thumbnailKey), file.bucket)
            .catch(() => undefined);
        }
      } catch (e) {
        this.logger.error(`Failed to delete physical file: ${file.path}`, e);
      }
    } else {
      this.logger.debug(
        `Skipped physical deletion for "${file.path}" because ${refCount - 1} other reference(s) exist.`,
      );
    }

    await repo.remove(file);

    return true;
  }

  async softDeleteMany(fileIds: string[], manager?: EntityManager): Promise<boolean> {
    if (!fileIds.length) return false;

    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const result = await repo.softDelete({
      id: In(fileIds),
    });

    this.logger.log(`Soft deleted ${result.affected} files`);
    return result.affected ? result.affected > 0 : false;
  }

  async hardDeleteMany(fileIds: string[], manager?: EntityManager): Promise<boolean> {
    if (!fileIds.length) return false;

    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const files = await repo.find({
      where: { id: In(fileIds) },
      withDeleted: true,
    });

    if (!files.length) return false;

    const deletingIds = new Set(files.map((f) => f.id));
    const groupedDeletes = new Map<
      string,
      { provider: FileProviderEnum; bucket: string; paths: string[] }
    >();

    for (const file of files) {
      const remainingRefs = await repo
        .createQueryBuilder('f')
        .withDeleted()
        .where('f.bucket = :bucket AND f.path = :path', {
          bucket: file.bucket,
          path: file.path,
        })
        .andWhere('f.id NOT IN (:...deletingIds)', {
          deletingIds: Array.from(deletingIds),
        })
        .getCount();

      if (remainingRefs === 0) {
        const groupKey = `${file.provider}:${file.bucket}`;
        const group = groupedDeletes.get(groupKey) || {
          provider: file.provider,
          bucket: file.bucket,
          paths: [],
        };
        group.paths.push(file.path);
        if (file.metadata?.thumbnailKey) {
          group.paths.push(String(file.metadata.thumbnailKey));
        }
        groupedDeletes.set(groupKey, group);
      }
    }

    const storageDeletePromises: Promise<void>[] = [];
    for (const { provider, bucket, paths } of groupedDeletes.values()) {
      const uniquePaths = Array.from(new Set(paths));
      const storage = this.storageResolver.resolve(provider);
      storageDeletePromises.push(
        storage.deleteMany(uniquePaths, bucket).catch((err) => {
          this.logger.error(`Failed to delete files in bucket ${bucket}: ${err}`);
        }),
      );
    }
    await Promise.all(storageDeletePromises);

    try {
      await repo.remove(files);
      this.logger.log(`Hard deleted ${files.length} files from DB and Storage`);
      return true;
    } catch (error) {
      this.logger.error('Failed to remove file records from DB', error);
      throw error;
    }
  }
}
