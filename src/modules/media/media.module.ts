import { Module } from '@nestjs/common';
import { MediaService } from './media.service';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaEntity } from 'src/entity/media.entity';
import { FilesModule } from '../files/files.module';

@Module({
  imports: [TypeOrmModule.forFeature([MediaEntity]), FilesModule],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
