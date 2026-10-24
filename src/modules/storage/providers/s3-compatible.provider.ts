import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  CopyObjectCommand,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutBucketPolicyCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { BuildHandlerArguments } from '@aws-sdk/types';
import * as crypto from 'crypto';
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

interface IS3RawRequest {
  headers: Record<string, string>;
  body?: string | Buffer | Uint8Array;
}

export interface S3ProviderConfig {
  providerName: FileProviderEnum;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string;
  publicEndpoint: string;
  bucketName: string;
  forcePathStyle: boolean;
  autoCreateBucket: boolean;
}

@Injectable()
export class S3CompatibleProvider implements IStorageProvider, OnModuleInit {
  public readonly providerName: FileProviderEnum;
  private readonly s3Client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucketName: string;
  private readonly publicEndpoint: string;
  private readonly forcePathStyle: boolean;
  private readonly autoCreateBucket: boolean;
  private readonly logger: Logger;

  constructor(
    private readonly configService: ConfigService,
    customConfig?: Partial<S3ProviderConfig>,
  ) {
    this.providerName =
      customConfig?.providerName ||
      this.configService.get<FileProviderEnum>('STORAGE_PROVIDER') ||
      FileProviderEnum.SEAWEEDFS;

    this.logger = new Logger(`${S3CompatibleProvider.name}:${this.providerName}`);

    const region =
      customConfig?.region ||
      this.configService.get<string>('STORAGE_REGION') ||
      this.configService.get<string>('AWS_REGION') ||
      (this.providerName === FileProviderEnum.R2 ? 'auto' : 'ap-southeast-1');

    const accessKeyId =
      customConfig?.accessKeyId ||
      this.configService.get<string>('STORAGE_ACCESS_KEY') ||
      this.configService.get<string>('AWS_ACCESS_KEY_ID') ||
      'seaweedadmin';

    const secretAccessKey =
      customConfig?.secretAccessKey ||
      this.configService.get<string>('STORAGE_SECRET_KEY') ||
      this.configService.get<string>('AWS_SECRET_ACCESS_KEY') ||
      'seaweedsecret123';

    const endpoint =
      customConfig?.endpoint ??
      this.configService.get<string>('STORAGE_ENDPOINT') ??
      this.configService.get<string>('AWS_ENDPOINT') ??
      'http://localhost:8333';

    const bucketName =
      customConfig?.bucketName ||
      this.configService.get<string>('STORAGE_BUCKET') ||
      this.configService.get<string>('AWS_BUCKET_NAME') ||
      'app-bucket';

    const publicEndpoint = (
      customConfig?.publicEndpoint ||
      this.configService.get<string>('STORAGE_PUBLIC_ENDPOINT') ||
      this.configService.get<string>('AWS_PUBLIC_ENDPOINT') ||
      endpoint ||
      `https://${bucketName}.s3.${region}.amazonaws.com`
    ).replace(/\/+$/, '');

    const forcePathStyleConfig = this.configService.get<string | boolean>(
      'STORAGE_FORCE_PATH_STYLE',
    );
    this.forcePathStyle =
      customConfig?.forcePathStyle ??
      (forcePathStyleConfig !== undefined
        ? String(forcePathStyleConfig) !== 'false'
        : this.providerName !== FileProviderEnum.S3);

    const autoCreateConfig = this.configService.get<string | boolean>('STORAGE_AUTO_CREATE_BUCKET');
    this.autoCreateBucket =
      customConfig?.autoCreateBucket ??
      (autoCreateConfig !== undefined
        ? String(autoCreateConfig) !== 'false'
        : this.providerName !== FileProviderEnum.S3 && this.providerName !== FileProviderEnum.R2);

    this.bucketName = bucketName;
    this.publicEndpoint = publicEndpoint;

    const baseClientConfig: S3ClientConfig = {
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      forcePathStyle: this.forcePathStyle,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };

    this.s3Client = new S3Client({
      ...baseClientConfig,
      ...(endpoint ? { endpoint } : {}),
    });

    const presignEndpoint =
      publicEndpoint && publicEndpoint.startsWith('http') ? publicEndpoint : endpoint;
    this.presignClient = new S3Client({
      ...baseClientConfig,
      ...(presignEndpoint ? { endpoint: presignEndpoint } : {}),
    });

    this.addMd5ChecksumMiddleware(this.s3Client);
  }

  async onModuleInit(): Promise<void> {
    if (!this.autoCreateBucket) return;
    await this.ensureBucketExists(this.bucketName);
  }

  async ensureBucketExists(bucket: string): Promise<void> {
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: bucket }));
      this.logger.log(`Bucket "${bucket}" is ready on ${this.providerName}.`);
    } catch (err: any) {
      const statusCode = err?.$metadata?.httpStatusCode;
      const errorName = err?.name || err?.Code;

      if (statusCode === 404 || errorName === 'NotFound' || errorName === 'NoSuchBucket') {
        try {
          this.logger.log(`Bucket "${bucket}" not found. Creating automatically...`);
          await this.s3Client.send(new CreateBucketCommand({ Bucket: bucket }));

          const publicPolicy = {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'PublicReadGetObject',
                Effect: 'Allow',
                Principal: '*',
                Action: ['s3:GetObject'],
                Resource: [`arn:aws:s3:::${bucket}/*`],
              },
            ],
          };

          await this.s3Client
            .send(
              new PutBucketPolicyCommand({
                Bucket: bucket,
                Policy: JSON.stringify(publicPolicy),
              }),
            )
            .catch((policyErr) => {
              this.logger.debug(
                `Public policy skipped or managed by gateway for "${bucket}": ${policyErr?.message || policyErr}`,
              );
            });

          this.logger.log(`Bucket "${bucket}" created and configured successfully.`);
        } catch (createErr: any) {
          this.logger.warn(
            `Could not auto-create bucket "${bucket}" (${createErr?.message || createErr}). Will retry on upload.`,
          );
        }
      } else {
        this.logger.warn(
          `Storage endpoint check warning for "${bucket}" on ${this.providerName}: ${err?.message || err}`,
        );
      }
    }
  }

  private addMd5ChecksumMiddleware(client: S3Client) {
    client.middlewareStack.add(
      (next, context) => async (args: BuildHandlerArguments<any>) => {
        const request = args.request as IS3RawRequest;

        if (
          request &&
          request.headers &&
          context.commandName === 'DeleteObjectsCommand' &&
          request.body
        ) {
          const md5 = crypto.createHash('md5').update(request.body).digest('base64');
          request.headers['Content-MD5'] = md5;
        }

        return next(args);
      },
      {
        step: 'build',
        priority: 'low',
        tags: ['S3_BULK_DELETE_MD5'],
      },
    );
  }

  private buildPublicUrl(bucket: string, key: string): string {
    const cleanKey = key.replace(/^\/+/, '');
    if (!this.forcePathStyle && this.publicEndpoint.includes(bucket)) {
      return `${this.publicEndpoint}/${cleanKey}`;
    }
    return `${this.publicEndpoint}/${bucket}/${cleanKey}`;
  }

  async upload(buffer: Buffer, options: UploadFileOptions): Promise<UploadResponse> {
    const bucket = options.bucket || this.bucketName;
    const cleanKey = options.path.replace(/^\/+/, '');

    try {
      const result = await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: cleanKey,
          Body: buffer,
          ContentType: options.mimeType,
          ContentLength: buffer.length,
          ...(options.metadata ? { Metadata: options.metadata } : {}),
          ...(options.cacheControl
            ? { CacheControl: options.cacheControl }
            : { CacheControl: 'public, max-age=31536000, immutable' }),
          ...(options.contentDisposition ? { ContentDisposition: options.contentDisposition } : {}),
        }),
      );

      return {
        key: cleanKey,
        bucket,
        url: this.buildPublicUrl(bucket, cleanKey),
        provider: this.providerName,
        etag: result.ETag?.replace(/"/g, ''),
      };
    } catch (error: any) {
      if (error?.name === 'NoSuchBucket' || error?.Code === 'NoSuchBucket') {
        await this.ensureBucketExists(bucket);
        const retryResult = await this.s3Client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: cleanKey,
            Body: buffer,
            ContentType: options.mimeType,
            ContentLength: buffer.length,
          }),
        );
        return {
          key: cleanKey,
          bucket,
          url: this.buildPublicUrl(bucket, cleanKey),
          provider: this.providerName,
          etag: retryResult.ETag?.replace(/"/g, ''),
        };
      }
      this.logger.error(
        `[${this.providerName}] Upload Error (${cleanKey}): ${error?.message || error}`,
      );
      throw error;
    }
  }

  async uploadStream(
    stream: Readable,
    options: UploadFileOptions & { contentLength?: number },
  ): Promise<UploadResponse> {
    const bucket = options.bucket || this.bucketName;
    const cleanKey = options.path.replace(/^\/+/, '');

    const result = await this.s3Client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: cleanKey,
        Body: stream,
        ContentType: options.mimeType,
        ...(options.contentLength ? { ContentLength: options.contentLength } : {}),
        ...(options.metadata ? { Metadata: options.metadata } : {}),
      }),
    );

    return {
      key: cleanKey,
      bucket,
      url: this.buildPublicUrl(bucket, cleanKey),
      provider: this.providerName,
      etag: result.ETag?.replace(/"/g, ''),
    };
  }

  async downloadStream(
    path: string,
    options: DownloadStreamOptions = {},
  ): Promise<StorageStreamResult> {
    const bucket = options.bucket || this.bucketName;
    const cleanKey = path.replace(/^\/+/, '');

    let rangeHeader: string | undefined;
    if (options.range && (options.range.start !== undefined || options.range.end !== undefined)) {
      const start = options.range.start ?? 0;
      const end = options.range.end !== undefined ? options.range.end : '';
      rangeHeader = `bytes=${start}-${end}`;
    }

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: cleanKey,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
      }),
    );

    return {
      stream: response.Body as Readable,
      contentType: response.ContentType || 'application/octet-stream',
      contentLength: response.ContentLength,
      contentRange: response.ContentRange,
      acceptRanges: response.AcceptRanges || 'bytes',
      etag: response.ETag?.replace(/"/g, ''),
      lastModified: response.LastModified,
    };
  }

  async headObject(path: string, bucket?: string): Promise<StorageObjectMetadata | null> {
    const targetBucket = bucket || this.bucketName;
    const cleanKey = path.replace(/^\/+/, '');

    try {
      const res = await this.s3Client.send(
        new HeadObjectCommand({
          Bucket: targetBucket,
          Key: cleanKey,
        }),
      );

      return {
        key: cleanKey,
        bucket: targetBucket,
        size: res.ContentLength ?? 0,
        mimeType: res.ContentType || 'application/octet-stream',
        etag: res.ETag?.replace(/"/g, ''),
        lastModified: res.LastModified,
      };
    } catch (error: any) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') {
        return null;
      }
      throw error;
    }
  }

  async copy(
    sourcePath: string,
    destinationPath: string,
    bucket?: string,
  ): Promise<UploadResponse> {
    const targetBucket = bucket || this.bucketName;
    const cleanSource = sourcePath.replace(/^\/+/, '');
    const cleanDest = destinationPath.replace(/^\/+/, '');

    await this.s3Client.send(
      new CopyObjectCommand({
        Bucket: targetBucket,
        CopySource: `${targetBucket}/${encodeURIComponent(cleanSource)}`,
        Key: cleanDest,
      }),
    );

    return {
      key: cleanDest,
      bucket: targetBucket,
      url: this.buildPublicUrl(targetBucket, cleanDest),
      provider: this.providerName,
    };
  }

  async delete(path: string, bucket?: string): Promise<void> {
    const cleanKey = path.replace(/^\/+/, '');
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket || this.bucketName,
        Key: cleanKey,
      }),
    );
  }

  async deleteMany(paths: string[], bucket?: string): Promise<void> {
    if (!paths.length) return;
    const targetBucket = bucket || this.bucketName;

    const batchSize = 1000;
    for (let i = 0; i < paths.length; i += batchSize) {
      const chunk = paths.slice(i, i + batchSize);
      const objects = chunk.map((key) => ({ Key: key.replace(/^\/+/, '') }));

      try {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: targetBucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
      } catch (error: any) {
        this.logger.warn(
          `[${this.providerName}] Bulk delete fallback to sequential delete: ${error?.message || error}`,
        );
        await Promise.allSettled(chunk.map((k) => this.delete(k, targetBucket)));
      }
    }
  }

  async getPresignedUrl(path: string, bucket?: string, expiresIn = 3600): Promise<string> {
    const targetBucket = bucket || this.bucketName;
    const cleanKey = path.replace(/^\/+/, '');

    try {
      const command = new GetObjectCommand({
        Bucket: targetBucket,
        Key: cleanKey,
      });

      return await getSignedUrl(this.presignClient, command, {
        expiresIn,
      });
    } catch (error: any) {
      this.logger.error(`Get Presigned URL Error: ${error?.message || error}`);
      throw new Error('Could not generate presigned download URL');
    }
  }

  async getPresignedUploadUrl(options: PresignedUploadOptions): Promise<PresignedUploadResponse> {
    const targetBucket = options.bucket || this.bucketName;
    const cleanKey = options.path.replace(/^\/+/, '');
    const expiresIn = options.expiresIn || 900;

    const command = new PutObjectCommand({
      Bucket: targetBucket,
      Key: cleanKey,
      ContentType: options.mimeType,
    });

    const uploadUrl = await getSignedUrl(this.presignClient, command, {
      expiresIn,
    });

    return {
      uploadUrl,
      publicUrl: this.buildPublicUrl(targetBucket, cleanKey),
      key: cleanKey,
      bucket: targetBucket,
      provider: this.providerName,
      expiresIn,
      method: 'PUT',
      headers: {
        'Content-Type': options.mimeType,
      },
    };
  }

  async healthCheck(): Promise<StorageHealthStatus> {
    const start = Date.now();
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: this.bucketName }));
      return {
        healthy: true,
        provider: this.providerName,
        bucket: this.bucketName,
        latencyMs: Date.now() - start,
      };
    } catch (error: any) {
      return {
        healthy: false,
        provider: this.providerName,
        bucket: this.bucketName,
        latencyMs: Date.now() - start,
        message: error?.message || 'Storage connection failed',
      };
    }
  }
}
