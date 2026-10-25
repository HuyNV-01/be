import {
  BaseEntity,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

export class BaseModel extends BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @CreateDateColumn({
    name: 'created_at',
    precision: 6,
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
  })
  @Index()
  createdAt: Date;

  @Column({ name: 'created_by', type: 'varchar', length: 36, nullable: true })
  createdBy: string | null;

  @UpdateDateColumn({
    name: 'updated_at',
    precision: 6,
    type: 'timestamp',
    default: () => 'CURRENT_TIMESTAMP(6)',
    onUpdate: 'CURRENT_TIMESTAMP(6)',
  })
  updatedAt: Date;

  @Column({ name: 'updated_by', type: 'varchar', length: 36, nullable: true })
  updatedBy: string | null;

  @DeleteDateColumn({
    name: 'deleted_at',
    precision: 6,
    type: 'timestamp',
    nullable: true,
  })
  deletedAt: Date | null;

  @Column({ name: 'deleted_by', type: 'varchar', length: 36, nullable: true })
  deletedBy: string | null;

  @VersionColumn({ name: 'version', default: 1 })
  version: number;
}
