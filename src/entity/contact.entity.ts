import { ContactStatusEnum } from 'src/common/enum';
import { Column, Entity, Index, JoinColumn, ManyToOne, Unique } from 'typeorm';

import { BaseModel } from './base-model';
import { UserEntity } from './user.entity';

@Entity('contacts')
@Unique(['userId', 'contactId'])
@Index(['userId', 'status'])
export class ContactEntity extends BaseModel {
  @Column()
  userId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user: UserEntity;

  @Column()
  contactId: string;

  @ManyToOne(() => UserEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'contactId' })
  contactUser: UserEntity;

  @Column({
    type: 'enum',
    enum: ContactStatusEnum,
    default: ContactStatusEnum.PENDING_SENT,
  })
  status: ContactStatusEnum;

  @Column({ type: 'varchar', nullable: true })
  alias: string | null;
}
