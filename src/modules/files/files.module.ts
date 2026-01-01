import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FilesService } from './files.service';
import { FileEntity } from 'src/entity/file.entity';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [TypeOrmModule.forFeature([FileEntity]), StorageModule],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
