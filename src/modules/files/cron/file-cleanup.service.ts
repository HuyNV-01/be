import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';

import { FileEntity } from 'src/entity/file.entity';
import { IsNull, LessThan, Repository } from 'typeorm';

import { FilesService } from '../files.service';

@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepo: Repository<FileEntity>,
    private readonly filesService: FilesService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async cleanExpired() {
    this.logger.log('Starting Clean Expired Files Job...');

    const expiredFiles = await this.fileRepo.find({
      where: {
        expiresAt: LessThan(new Date()),
        deletedAt: IsNull(),
      },
      take: 100,
    });

    if (!expiredFiles.length) return;

    const idsToDelete = expiredFiles.map((f) => f.id);
    await this.filesService.hardDeleteMany(idsToDelete);

    this.logger.log(`[Cron] Cleaned ${expiredFiles.length} expired files.`);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanOrphansAndSoftDeleted() {
    this.logger.log('Starting Garbage Collection Job...');

    const safeDate = new Date();
    safeDate.setDate(safeDate.getDate() - 7);

    const orphanFiles = await this.fileRepo
      .createQueryBuilder('f')
      .withDeleted()
      .leftJoin('media', 'm', 'm.file_id = f.id AND m.deleted_at IS NULL')
      .where('m.id IS NULL')
      .andWhere('f.created_at < :safeDate', { safeDate })
      .take(500)
      .getMany();

    if (!orphanFiles.length) return;

    const orphanIds = orphanFiles.map((f) => f.id);
    await this.filesService.hardDeleteMany(orphanIds);

    this.logger.log(`[Cron] Garbage Collected ${orphanFiles.length} orphan/soft-deleted files.`);
  }
}
