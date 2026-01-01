import { FileProviderEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { UserEntity } from './user.entity';

@Entity('files')
export class FileEntity extends BaseModel {
  @Column({ name: 'original_name' })
  originalName: string;

  @Column({ name: 'file_name', unique: true })
  fileName: string; // UUID

  @Column({ name: 'mime_type' })
  mimeType: string;

  @Column({ type: 'bigint' })
  size: number;

  @Column({ type: 'enum', enum: FileProviderEnum })
  provider: FileProviderEnum;

  @Column()
  bucket: string;

  @Column()
  path: string;

  @Column({ type: 'text' })
  url: string;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, any>;

  @Column({ nullable: true })
  @Index()
  hash: string;

  @Column({ name: 'expires_at', type: 'timestamp', nullable: true })
  @Index()
  expiresAt: Date | null;

  @Column({ name: 'uploader_id', nullable: true })
  uploaderId: string;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'uploader_id' })
  uploader: UserEntity;
}
