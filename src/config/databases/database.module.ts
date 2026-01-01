import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseConfigService } from './module-db/dbConfig.service';
import { DatabaseConfigModule } from './module-db/db.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [DatabaseConfigService],
      imports: [DatabaseConfigModule],
      useFactory: (configService: DatabaseConfigService) => {
        return configService.connections;
      },
    }),
  ],
  providers: [ConfigService, DatabaseConfigService],
  exports: [DatabaseConfigService],
})
export class DatabaseModule {}
