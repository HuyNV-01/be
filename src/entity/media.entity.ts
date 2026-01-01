import { MediaTypeEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';

import { BaseModel } from './base-model';
import { FileEntity } from './file.entity';

@Entity('media')
@Index(['targetId', 'type'])
export class MediaEntity extends BaseModel {
  @Column({ name: 'file_id' })
  fileId: string;

  @ManyToOne(() => FileEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'file_id' })
  file: FileEntity;

  @Column({ name: 'target_id', type: 'uuid' })
  targetId: string;

  @Column({ type: 'enum', enum: MediaTypeEnum })
  type: MediaTypeEnum;

  @Column({ type: 'int', default: 0 })
  order: number;
}
