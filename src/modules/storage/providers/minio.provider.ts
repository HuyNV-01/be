import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  S3ClientConfig,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import {
  IStorageProvider,
  UploadFileOptions,
  UploadResponse,
} from 'src/interface/storage.interface';
import { FileProviderEnum } from 'src/common/enum';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import { BuildHandlerArguments } from '@aws-sdk/types';

interface IMinioRequest {
  headers: Record<string, string>;
  body?: any;
}

@Injectable()
export class MinioProvider implements IStorageProvider {
  private s3Client: S3Client;
  private bucketName: string;
  private publicEndpoint: string;
  private readonly logger = new Logger(MinioProvider.name);

  constructor(private readonly configService: ConfigService) {
    const region = this.configService.get<string>('AWS_REGION');
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID');
    const secretAccessKey = this.configService.get<string>(
      'AWS_SECRET_ACCESS_KEY',
    );
    const endpoint = this.configService.get<string>('AWS_ENDPOINT');
    const bucketName = this.configService.get<string>('AWS_BUCKET_NAME');
    const publicEndpoint = this.configService.get<string>(
      'AWS_PUBLIC_ENDPOINT',
    );

    if (
      !region ||
      !accessKeyId ||
      !secretAccessKey ||
      !endpoint ||
      !bucketName ||
      !publicEndpoint
    ) {
      throw new Error('MinIO/AWS S3 Configuration is missing in .env');
    }

    this.bucketName = bucketName;
    this.publicEndpoint = publicEndpoint;

    const s3Config: S3ClientConfig = {
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
      endpoint,
      forcePathStyle: true,
    };

    this.s3Client = new S3Client(s3Config);

    this.addMd5ChecksumMiddleware();
  }

  private addMd5ChecksumMiddleware() {
    this.s3Client.middlewareStack.add(
      (next, context) => async (args: BuildHandlerArguments<any>) => {
        const request = args.request as IMinioRequest;

        if (request && request.headers) {
          if (context.commandName === 'DeleteObjectsCommand') {
            if (request.body) {
              const md5 = crypto
                .createHash('md5')
                .update(request.body)
                .digest('base64');

              request.headers['Content-MD5'] = md5;
            }
          }
        }

        return next(args);
      },
      {
        step: 'build',
        priority: 'low',
        tags: ['FIX_MINIO_MD5'],
      },
    );
  }

  async upload(
    buffer: Buffer,
    options: UploadFileOptions,
  ): Promise<UploadResponse> {
    const bucket = options.bucket || this.bucketName;
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: options.path,
          Body: buffer,
          ContentType: options.mimeType,
        }),
      );

      const url = `${this.publicEndpoint}/${bucket}/${options.path}`;

      return {
        key: options.path,
        bucket: bucket,
        url: url,
        provider: FileProviderEnum.MINIO,
      };
    } catch (error: any) {
      this.logger.error(`MinIO Upload Error: ${error}`);
      throw error;
    }
  }

  async delete(path: string, bucket?: string): Promise<void> {
    await this.s3Client.send(
      new DeleteObjectCommand({
        Bucket: bucket || this.bucketName,
        Key: path,
      }),
    );
  }

  async deleteMany(paths: string[], bucket?: string): Promise<void> {
    if (!paths.length) return;
    const targetBucket = bucket || this.bucketName;

    const objects = paths.map((key) => ({ Key: key }));

    try {
      await this.s3Client.send(
        new DeleteObjectsCommand({
          Bucket: targetBucket,
          Delete: { Objects: objects, Quiet: true },
        }),
      );
    } catch (error: any) {
      this.logger.error(`Bulk Delete Error: ${error}`);
    }
  }

  async getPresignedUrl(
    path: string,
    bucket?: string,
    expiresIn = 3600,
  ): Promise<string> {
    const targetBucket = bucket || this.bucketName;

    try {
      const command = new GetObjectCommand({
        Bucket: targetBucket,
        Key: path,
      });

      const url = await getSignedUrl(this.s3Client, command, {
        expiresIn: expiresIn,
      });

      return url;
    } catch (error: any) {
      this.logger.error(`Get Presigned URL Error: ${error}`);
      throw new Error('Could not generate presigned URL');
    }
  }
}
