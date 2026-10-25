import { FileProviderEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne, ValueTransformer } from 'typeorm';

import { BaseModel } from './base-model';
import { UserEntity } from './user.entity';

const bigintNumberTransformer: ValueTransformer = {
  to(this: void, value?: number | null): number | null | undefined {
    return value;
  },
  from(this: void, value?: string | number | null): number {
    return value !== null && value !== undefined ? Number(value) : 0;
  },
};

@Entity('files')
export class FileEntity extends BaseModel {
  @Column({ name: 'original_name', type: 'varchar', length: 255 })
  originalName: string;

  @Column({ name: 'file_name', type: 'varchar', length: 255, unique: true })
  fileName: string; // UUID

  @Column({ name: 'mime_type', type: 'varchar', length: 128 })
  mimeType: string;

  @Column({ type: 'bigint', transformer: bigintNumberTransformer })
  size: number;

  @Column({ type: 'enum', enum: FileProviderEnum })
  provider: FileProviderEnum;

  @Column({ type: 'varchar', length: 255 })
  bucket: string;

  @Column({ type: 'varchar', length: 255 })
  path: string;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ type: 'varchar', length: 255, nullable: true })
  @Index()
  hash: string;

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  @Index()
  expiresAt: Date | null;

  @Column({ name: 'uploader_id', type: 'varchar', length: 36, nullable: true })
  @Index()
  uploaderId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'uploader_id' })
  uploader: UserEntity;
}
