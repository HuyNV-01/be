import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FileEntity } from 'src/entity/file.entity';

import { StorageModule } from '../storage/storage.module';
import { FileCleanupService } from './cron/file-cleanup.service';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), ScheduleModule.forRoot(), StorageModule],
  controllers: [FilesController],
  providers: [FilesService, FileCleanupService],
  exports: [FilesService],
})
export class FilesModule {}
