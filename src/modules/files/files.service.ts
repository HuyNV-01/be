import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, EntityManager, In } from 'typeorm';
import sharp from 'sharp';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { extname } from 'path';
import { FileEntity } from 'src/entity/file.entity';
import type { IStorageProvider } from 'src/interface/storage.interface';
import { FileProviderEnum } from 'src/common/enum';

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
      retentionDays,
    } = options;

    const { originalname } = file;
    let { buffer, mimetype, size } = file;
    let width: number | undefined;
    let height: number | undefined;

    if (mimetype.startsWith('image/') && optimize) {
      try {
        const image = sharp(buffer);
        const meta = await image.metadata();

        let pipeline = image.clone().webp({ quality: 80 });
        if (resizeWidth && meta.width && meta.width > resizeWidth) {
          pipeline = pipeline.resize({ width: resizeWidth });
        }

        const newBuffer = await pipeline.toBuffer();
        const newMeta = await sharp(newBuffer).metadata();

        buffer = newBuffer;
        mimetype = 'image/webp';
        size = newBuffer.length;
        width = newMeta.width;
        height = newMeta.height;
      } catch (e: any) {
        this.logger.warn(`Optimization failed, falling back to original: ${e}`);
      }
    }

    const hash = crypto.createHash('md5').update(buffer).digest('hex');
    const ext = mimetype === 'image/webp' ? '.webp' : extname(originalname);
    const fileName = `${uuidv4()}${ext}`;
    const key = `${folder}/${fileName}`;

    const uploadRes = await this.storageProvider.upload(buffer, {
      path: key,
      mimeType: mimetype,
      isPublic: true,
    });

    try {
      let expiresAt: Date | null = null;
      if (retentionDays) {
        expiresAt = new Date();
        expiresAt.setDate(expiresAt.getDate() + retentionDays);
      }

      const providerEnum = uploadRes.provider as FileProviderEnum;

      const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

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
        metadata: { width, height, optimized: optimize },
      });

      return await repo.save(newFile);
    } catch (error) {
      this.logger.error(
        `DB Save failed, rolling back storage: ${uploadRes.key}`,
      );

      await this.storageProvider
        .delete(uploadRes.key, uploadRes.bucket)
        .catch((e) => this.logger.error(`Failed to rollback storage: ${e}`));

      throw error;
    }
  }

  async softDeleteFile(
    fileId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const result = await repo.softDelete(fileId);

    return result.affected ? result.affected > 0 : false;
  }

  async hardDeleteFile(
    fileId: string,
    manager?: EntityManager,
  ): Promise<boolean> {
    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const file = await repo.findOne({
      where: { id: fileId },
      withDeleted: true,
    });

    if (!file) return false;

    try {
      await this.storageProvider.delete(file.path, file.bucket);
    } catch (e) {
      this.logger.error(`Failed to delete physical file: ${file.path}`, e);
    }

    await repo.remove(file);

    return true;
  }

  async softDeleteMany(
    fileIds: string[],
    manager?: EntityManager,
  ): Promise<boolean> {
    if (!fileIds.length) return false;

    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const result = await repo.softDelete({
      id: In(fileIds),
    });

    this.logger.log(`Soft deleted ${result.affected} files`);
    return result.affected ? result.affected > 0 : false;
  }

  async hardDeleteMany(
    fileIds: string[],
    manager?: EntityManager,
  ): Promise<boolean> {
    if (!fileIds.length) return false;

    const repo = manager ? manager.getRepository(FileEntity) : this.fileRepo;

    const files = await repo.find({
      where: { id: In(fileIds) },
      withDeleted: true,
    });

    if (!files.length) return false;

    const filesByBucket = new Map<string, string[]>();

    files.forEach((file) => {
      const currentPaths = filesByBucket.get(file.bucket) || [];
      currentPaths.push(file.path);
      filesByBucket.set(file.bucket, currentPaths);
    });

    const storageDeletePromises: Promise<void>[] = [];
    for (const [bucket, paths] of filesByBucket.entries()) {
      storageDeletePromises.push(
        this.storageProvider.deleteMany(paths, bucket).catch((err) => {
          this.logger.error(
            `Failed to delete files in bucket ${bucket}: ${err}`,
          );
        }),
      );
    }
    await Promise.all(storageDeletePromises);

    try {
      await repo.remove(files);
      this.logger.log(`Hard deleted ${files.length} files from DB and Storage`);
      return true;
    } catch (error) {
      this.logger.error(`DB Bulk Hard Delete Failed: ${error}`);
      throw error;
    }
  }
}
