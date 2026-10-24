import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { FileProviderEnum } from 'src/common/enum';
import { IStorageProvider } from 'src/interface/storage.interface';

import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3CompatibleProvider } from './providers/s3-compatible.provider';
import { StorageResolverService } from './storage-resolver.service';

@Global()
@Module({
  providers: [
    LocalStorageProvider,
    {
      provide: S3CompatibleProvider,
      useFactory: (configService: ConfigService) => {
        const rawProvider =
          configService.get<string>('STORAGE_PROVIDER')?.toUpperCase() ||
          (configService.get<string>('AWS_ENDPOINT')
            ? FileProviderEnum.SEAWEEDFS
            : FileProviderEnum.LOCAL);

        const s3ProviderType =
          rawProvider === FileProviderEnum.LOCAL
            ? FileProviderEnum.SEAWEEDFS
            : (rawProvider as FileProviderEnum);

        return new S3CompatibleProvider(configService, {
          providerName: s3ProviderType,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: 'STORAGE_PROVIDER',
      useFactory: (
        configService: ConfigService,
        localProvider: LocalStorageProvider,
        s3Provider: S3CompatibleProvider,
      ): IStorageProvider => {
        const logger = new Logger(StorageModule.name);
        const configuredProvider = (
          configService.get<string>('STORAGE_PROVIDER') ||
          (configService.get<string>('AWS_ENDPOINT')
            ? FileProviderEnum.SEAWEEDFS
            : FileProviderEnum.LOCAL)
        ).toUpperCase() as FileProviderEnum;

        if (configuredProvider === FileProviderEnum.LOCAL) {
          logger.log('Active Storage Provider: LOCAL (Local Disk Storage + Signed URLs)');
          return localProvider;
        }

        logger.log(`Active Storage Provider: ${configuredProvider} (S3-Compatible Object Storage)`);
        return s3Provider;
      },
      inject: [ConfigService, LocalStorageProvider, S3CompatibleProvider],
    },
    StorageResolverService,
  ],
  exports: ['STORAGE_PROVIDER', StorageResolverService, LocalStorageProvider, S3CompatibleProvider],
})
export class StorageModule {}
