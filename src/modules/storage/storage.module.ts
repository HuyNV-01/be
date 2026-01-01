import { Global, Module } from '@nestjs/common';

import { MinioProvider } from './providers/minio.provider';

@Global()
@Module({
  providers: [
    {
      provide: 'STORAGE_PROVIDER',
      useClass: MinioProvider,
    },
  ],
  exports: ['STORAGE_PROVIDER'],
})
export class StorageModule {}
