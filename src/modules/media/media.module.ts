import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MediaEntity } from 'src/entity/media.entity';

import { FilesModule } from '../files/files.module';
import { MediaService } from './media.service';

@Module({
  imports: [TypeOrmModule.forFeature([MediaEntity]), FilesModule],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
