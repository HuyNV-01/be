import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { FileEntity } from 'src/entity/file.entity';
import type { IStorageProvider } from 'src/interface/storage.interface';
import { Repository, LessThan, In, IsNull } from 'typeorm';

@Injectable()
export class FileCleanupService {
  private readonly logger = new Logger(FileCleanupService.name);

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepo: Repository<FileEntity>,
    @Inject('STORAGE_PROVIDER')
    private readonly storageProvider: IStorageProvider,
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

    const filesByBucket = this.groupFilesByBucket(expiredFiles);

    for (const [bucket, paths] of Object.entries(filesByBucket)) {
      await this.storageProvider.deleteMany(paths, bucket);
    }

    const idsToDelete = expiredFiles.map((f) => f.id);
    await this.fileRepo.softDelete({ id: In(idsToDelete) });

    this.logger.log(`[Cron] Cleaned ${expiredFiles.length} expired files.`);
  }

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async cleanOrphansAndSoftDeleted() {
    this.logger.log('Starting Garbage Collection Job...');

    const safeDate = new Date();
    safeDate.setDate(safeDate.getDate() - 7);

    const orphanFiles = await this.fileRepo
      .createQueryBuilder('f')
      .leftJoin('media', 'm', 'm.file_id = f.id AND m.deleted_at IS NULL')
      .where('m.id IS NULL')
      .andWhere('f.created_at < :safeDate', { safeDate })
      .andWhere('f.deleted_at IS NULL')
      .take(500)
      .getMany();

    if (!orphanFiles.length) return;

    const filesByBucket = this.groupFilesByBucket(orphanFiles);

    for (const [bucket, paths] of Object.entries(filesByBucket)) {
      try {
        await this.storageProvider.deleteMany(paths, bucket);
      } catch (error) {
        this.logger.error(`Failed to delete files in bucket ${bucket}`, error);
      }
    }

    await this.fileRepo.remove(orphanFiles);

    this.logger.log(`[Cron] Garbage Collected ${orphanFiles.length} files.`);
  }

  private groupFilesByBucket(files: FileEntity[]): Record<string, string[]> {
    return files.reduce(
      (acc, file) => {
        if (!acc[file.bucket]) {
          acc[file.bucket] = [];
        }
        acc[file.bucket].push(file.path);
        return acc;
      },
      {} as Record<string, string[]>,
    );
  }
}
