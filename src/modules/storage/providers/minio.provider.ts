import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FileProviderEnum } from 'src/common/enum';

import { S3CompatibleProvider } from './s3-compatible.provider';

@Injectable()
export class MinioProvider extends S3CompatibleProvider {
  constructor(configService: ConfigService) {
    super(configService, {
      providerName: FileProviderEnum.MINIO,
      forcePathStyle: true,
    });
  }
}
