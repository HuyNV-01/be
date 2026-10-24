import { BadRequestException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { dirname, join, normalize, resolve } from 'path';
import { FileProviderEnum } from 'src/common/enum';
import {
  DownloadStreamOptions,
  IStorageProvider,
  PresignedUploadOptions,
  PresignedUploadResponse,
  StorageHealthStatus,
  StorageObjectMetadata,
  StorageStreamResult,
  UploadFileOptions,
  UploadResponse,
} from 'src/interface/storage.interface';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

@Injectable()
export class LocalStorageProvider implements IStorageProvider, OnModuleInit {
  public readonly providerName = FileProviderEnum.LOCAL;
  private readonly rootDir: string;
  private readonly defaultBucket: string;
  private readonly appUrl: string;
  private readonly signingSecret: string;
  private readonly logger = new Logger(LocalStorageProvider.name);

  constructor(private readonly configService: ConfigService) {
    const localDir = this.configService.get<string>('STORAGE_LOCAL_DIR') || 'uploads';
    this.rootDir = resolve(process.cwd(), localDir);
    this.defaultBucket =
      this.configService.get<string>('STORAGE_BUCKET') ||
      this.configService.get<string>('AWS_BUCKET_NAME') ||
      'app-bucket';
    this.appUrl = (this.configService.get<string>('APP_URL') || 'http://localhost:3000').replace(
      /\/+$/,
      '',
    );
    this.signingSecret =
      this.configService.get<string>('STORAGE_SIGNING_SECRET') ||
      this.configService.get<string>('JWT_SECRET') ||
      'local-storage-hmac-secret';
  }

  async onModuleInit(): Promise<void> {
    const bucketPath = join(this.rootDir, this.defaultBucket);
    await fsp.mkdir(bucketPath, { recursive: true });
    this.logger.log(`Local Storage initialized at: ${bucketPath}`);
  }

  private resolveSafePath(bucket: string, key: string): { fullPath: string; cleanKey: string } {
    const cleanBucket = bucket.replace(/[^a-zA-Z0-9._-]/g, '');
    const cleanKey = normalize(key)
      .replace(/^(\.\.(\/|\\|$))+/, '')
      .replace(/^\/+|^\\+/, '')
      .replace(/\\/g, '/');

    const bucketRoot = resolve(this.rootDir, cleanBucket);
    const fullPath = resolve(bucketRoot, cleanKey);

    if (!fullPath.startsWith(bucketRoot)) {
      throw new BadRequestException('Invalid storage path');
    }

    return { fullPath, cleanKey };
  }

  private buildPublicUrl(bucket: string, cleanKey: string): string {
    return `${this.appUrl}/api/${bucket}/${cleanKey}`;
  }

  async upload(buffer: Buffer, options: UploadFileOptions): Promise<UploadResponse> {
    const bucket = options.bucket || this.defaultBucket;
    const { fullPath, cleanKey } = this.resolveSafePath(bucket, options.path);

    await fsp.mkdir(dirname(fullPath), { recursive: true });
    await fsp.writeFile(fullPath, buffer);

    const etag = crypto.createHash('md5').update(buffer).digest('hex');

    return {
      key: cleanKey,
      bucket,
      url: this.buildPublicUrl(bucket, cleanKey),
      provider: FileProviderEnum.LOCAL,
      etag,
    };
  }

  async uploadStream(
    stream: Readable,
    options: UploadFileOptions & { contentLength?: number },
  ): Promise<UploadResponse> {
    const bucket = options.bucket || this.defaultBucket;
    const { fullPath, cleanKey } = this.resolveSafePath(bucket, options.path);

    await fsp.mkdir(dirname(fullPath), { recursive: true });
    const writeStream = fs.createWriteStream(fullPath);
    await pipeline(stream, writeStream);

    return {
      key: cleanKey,
      bucket,
      url: this.buildPublicUrl(bucket, cleanKey),
      provider: FileProviderEnum.LOCAL,
    };
  }

  async downloadStream(
    path: string,
    options: DownloadStreamOptions = {},
  ): Promise<StorageStreamResult> {
    const bucket = options.bucket || this.defaultBucket;
    const { fullPath } = this.resolveSafePath(bucket, path);

    const stat = await fsp.stat(fullPath);
    const totalSize = stat.size;

    if (options.range && (options.range.start !== undefined || options.range.end !== undefined)) {
      const start = options.range.start ?? 0;
      const end =
        options.range.end !== undefined
          ? Math.min(options.range.end, totalSize - 1)
          : totalSize - 1;
      const chunkSize = end - start + 1;

      return {
        stream: fs.createReadStream(fullPath, { start, end }),
        contentType: 'application/octet-stream',
        contentLength: chunkSize,
        contentRange: `bytes ${start}-${end}/${totalSize}`,
        acceptRanges: 'bytes',
        lastModified: stat.mtime,
      };
    }

    return {
      stream: fs.createReadStream(fullPath),
      contentType: 'application/octet-stream',
      contentLength: totalSize,
      acceptRanges: 'bytes',
      lastModified: stat.mtime,
    };
  }

  async headObject(path: string, bucket?: string): Promise<StorageObjectMetadata | null> {
    const targetBucket = bucket || this.defaultBucket;
    const { fullPath, cleanKey } = this.resolveSafePath(targetBucket, path);

    try {
      const stat = await fsp.stat(fullPath);
      return {
        key: cleanKey,
        bucket: targetBucket,
        size: stat.size,
        mimeType: 'application/octet-stream',
        lastModified: stat.mtime,
      };
    } catch {
      return null;
    }
  }

  async copy(
    sourcePath: string,
    destinationPath: string,
    bucket?: string,
  ): Promise<UploadResponse> {
    const targetBucket = bucket || this.defaultBucket;
    const source = this.resolveSafePath(targetBucket, sourcePath);
    const dest = this.resolveSafePath(targetBucket, destinationPath);

    await fsp.mkdir(dirname(dest.fullPath), { recursive: true });
    await fsp.copyFile(source.fullPath, dest.fullPath);

    return {
      key: dest.cleanKey,
      bucket: targetBucket,
      url: this.buildPublicUrl(targetBucket, dest.cleanKey),
      provider: FileProviderEnum.LOCAL,
    };
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const targetBucket = bucket || this.defaultBucket;
    const { fullPath } = this.resolveSafePath(targetBucket, path);
    await fsp.unlink(fullPath).catch((err) => {
      if (err?.code !== 'ENOENT') throw err;
    });
  }

  async deleteMany(paths: string[], bucket?: string): Promise<void> {
    if (!paths.length) return;
    const targetBucket = bucket || this.defaultBucket;
    await Promise.allSettled(paths.map((p) => this.delete(p, targetBucket)));
  }

  async getPresignedUrl(path: string, bucket?: string, expiresIn = 3600): Promise<string> {
    const targetBucket = bucket || this.defaultBucket;
    const { cleanKey } = this.resolveSafePath(targetBucket, path);
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const signature = this.signToken('GET', targetBucket, cleanKey, expiresAt);

    return `${this.appUrl}/api/files/local-download/${targetBucket}/${cleanKey}?expires=${expiresAt}&signature=${signature}`;
  }

  async getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUploadResponse> {
    const targetBucket = options.bucket || this.defaultBucket;
    const { cleanKey } = this.resolveSafePath(targetBucket, options.path);
    const expiresIn = options.expiresIn || 900;
    const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;
    const signature = this.signToken('PUT', targetBucket, cleanKey, expiresAt, options.mimeType);

    const uploadUrl = `${this.appUrl}/api/files/local-upload/${targetBucket}/${cleanKey}?expires=${expiresAt}&mimeType=${encodeURIComponent(options.mimeType)}&signature=${signature}`;

    return {
      uploadUrl,
      publicUrl: this.buildPublicUrl(targetBucket, cleanKey),
      key: cleanKey,
      bucket: targetBucket,
      provider: FileProviderEnum.LOCAL,
      expiresIn,
      method: 'PUT',
      headers: {
        'Content-Type': options.mimeType,
      },
    };
  }

  verifySignedToken(params: {
    method: 'GET' | 'PUT';
    bucket: string;
    key: string;
    expires: number;
    signature: string;
    mimeType?: string;
  }): boolean {
    const now = Math.floor(Date.now() / 1000);
    if (!params.expires || now > params.expires) {
      return false;
    }
    const expected = this.signToken(
      params.method,
      params.bucket,
      params.key,
      params.expires,
      params.mimeType,
    );
    try {
      return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(params.signature));
    } catch {
      return false;
    }
  }

  private signToken(
    method: 'GET' | 'PUT',
    bucket: string,
    key: string,
    expiresAt: number,
    mimeType = '',
  ): string {
    const payload = `${method}:${bucket}:${key}:${expiresAt}:${mimeType}`;
    return crypto.createHmac('sha256', this.signingSecret).update(payload).digest('hex');
  }

  async healthCheck(): Promise<StorageHealthStatus> {
    const start = Date.now();
    try {
      const bucketPath = join(this.rootDir, this.defaultBucket);
      await fsp.mkdir(bucketPath, { recursive: true });
      await fsp.access(bucketPath, fs.constants.R_OK | fs.constants.W_OK);
      return {
        healthy: true,
        provider: FileProviderEnum.LOCAL,
        bucket: this.defaultBucket,
        latencyMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        healthy: false,
        provider: FileProviderEnum.LOCAL,
        bucket: this.defaultBucket,
        latencyMs: Date.now() - start,
        message: error?.message || 'Local storage directory is not writable',
      };
    }
  }
}
