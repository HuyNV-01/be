import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { MediaTypeEnum } from 'src/common/enum';
import { FileEntity } from 'src/entity/file.entity';
import { MediaEntity } from 'src/entity/media.entity';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { BufferedFile, FileUploadOptions, FilesService } from '../files/files.service';

@Injectable()
export class MediaService {
  constructor(
    @InjectRepository(MediaEntity)
    private readonly mediaRepo: Repository<MediaEntity>,
    private readonly dataSource: DataSource,
    private readonly filesService: FilesService,
  ) {}

  async attachFiles(
    files: FileEntity[],
    targetId: string,
    type: MediaTypeEnum,
    manager?: EntityManager,
  ) {
    const repo = manager ? manager.getRepository(MediaEntity) : this.mediaRepo;

    const entities = files.map((file, idx) =>
      repo.create({
        fileId: file.id,
        targetId,
        type,
        order: idx,
      }),
    );
    return repo.save(entities);
  }

  async updateSingleMedia(
    fileId: string,
    targetId: string,
    type: MediaTypeEnum,
    externalManager?: EntityManager,
  ) {
    const executeLogic = async (manager: EntityManager) => {
      const repo = manager.getRepository(MediaEntity);

      await repo.softDelete({ targetId, type });

      const newMedia = repo.create({
        fileId,
        targetId,
        type,
        order: 0,
      });
      return repo.save(newMedia);
    };

    if (externalManager) {
      return executeLogic(externalManager);
    } else {
      return this.dataSource.transaction(async (manager) => {
        return executeLogic(manager);
      });
    }
  }

  async getMediaUrl(targetId: string, type: MediaTypeEnum): Promise<string | null> {
    const media = await this.mediaRepo.findOne({
      where: { targetId, type },
      relations: ['file'],
      order: { createdAt: 'DESC' },
    });
    return media?.file?.url || null;
  }

  async processSingleUpload(
    params: {
      file: BufferedFile;
      targetId: string;
      type: MediaTypeEnum;
      userId: string;
      options?: FileUploadOptions;
    },
    externalManager?: EntityManager,
  ) {
    const execute = async (manager: EntityManager) => {
      const uploadedFile = await this.filesService.uploadFile(
        params.file,
        params.userId,
        params.options,
        manager,
      );

      await this.updateSingleMedia(uploadedFile.id, params.targetId, params.type, manager);

      return uploadedFile;
    };

    if (externalManager) {
      return execute(externalManager);
    }
    return this.dataSource.transaction((manager) => execute(manager));
  }

  async processMultipleUploads(
    params: {
      files: BufferedFile[];
      targetId: string;
      type: MediaTypeEnum;
      userId: string;
      options?: FileUploadOptions;
    },
    externalManager?: EntityManager,
  ) {
    const execute = async (manager: EntityManager) => {
      const uploadPromises = params.files.map((file) =>
        this.filesService.uploadFile(file, params.userId, params.options, manager),
      );
      const uploadedFiles = await Promise.all(uploadPromises);

      await this.attachFiles(uploadedFiles, params.targetId, params.type, manager);

      return uploadedFiles;
    };

    if (externalManager) {
      return execute(externalManager);
    }
    return this.dataSource.transaction((manager) => execute(manager));
  }

  async processDelete(
    params: {
      targetId: string;
      type: MediaTypeEnum;
      hardDelete?: boolean;
    },
    externalManager?: EntityManager,
  ) {
    const execute = async (manager: EntityManager) => {
      const mediaRepo = manager.getRepository(MediaEntity);

      const medias = await mediaRepo.find({
        where: { targetId: params.targetId, type: params.type },
        withDeleted: params.hardDelete,
      });

      if (!medias.length) return;

      const fileIds = medias.map((m) => m.fileId).filter((id) => !!id);

      if (params.hardDelete) {
        await mediaRepo.remove(medias);

        if (fileIds.length) {
          await this.filesService.hardDeleteMany(fileIds, manager);
        }
      } else {
        await mediaRepo.softRemove(medias);

        if (fileIds.length) {
          await this.filesService.softDeleteMany(fileIds, manager);
        }
      }
    };

    if (externalManager) {
      return execute(externalManager);
    }
    return this.dataSource.transaction((manager) => execute(manager));
  }

  async restoreMedia(targetId: string, type: MediaTypeEnum, externalManager?: EntityManager) {
    const execute = async (manager: EntityManager) => {
      const mediaRepo = manager.getRepository(MediaEntity);
      const fileRepo = manager.getRepository(FileEntity);

      await mediaRepo.restore({ targetId, type });

      const medias = await mediaRepo.find({
        where: { targetId, type },
      });
      const fileIds = medias.map((m) => m.fileId).filter(Boolean);

      if (fileIds.length) {
        await fileRepo.restore(fileIds);
      }
    };

    if (externalManager) {
      return execute(externalManager);
    }
    return this.dataSource.transaction((manager) => execute(manager));
  }
}
