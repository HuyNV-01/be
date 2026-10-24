import { Inject, Injectable, Logger } from '@nestjs/common';

import { FileProviderEnum } from 'src/common/enum';
import type { IStorageProvider } from 'src/interface/storage.interface';

import { LocalStorageProvider } from './providers/local-storage.provider';
import { S3CompatibleProvider } from './providers/s3-compatible.provider';

@Injectable()
export class StorageResolverService {
  private readonly logger = new Logger(StorageResolverService.name);

  constructor(
    @Inject('STORAGE_PROVIDER')
    private readonly activeProvider: IStorageProvider,
    private readonly localProvider: LocalStorageProvider,
    private readonly s3Provider: S3CompatibleProvider,
  ) {}

  getActiveProvider(): IStorageProvider {
    return this.activeProvider;
  }

  resolve(provider?: FileProviderEnum | string): IStorageProvider {
    if (!provider || provider === this.activeProvider.providerName) {
      return this.activeProvider;
    }

    if (provider === FileProviderEnum.LOCAL) {
      return this.localProvider;
    }

    if (
      provider === FileProviderEnum.SEAWEEDFS ||
      provider === FileProviderEnum.S3 ||
      provider === FileProviderEnum.R2
    ) {
      return this.s3Provider;
    }

    this.logger.warn(`Unknown storage provider "${provider}", using active provider.`);
    return this.activeProvider;
  }
}
