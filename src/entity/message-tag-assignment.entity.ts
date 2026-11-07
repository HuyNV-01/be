import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

@Entity('message_tag_assignments')
@Index('uq_msg_tag_assign', ['conversationId', 'messageId', 'tagId'], { unique: true })
@Index('idx_msg_tag_conv_lookup', ['shopId', 'conversationId', 'tagId'])
@Index('idx_msg_tag_shop_tag_created', ['shopId', 'tagId', 'createdAt'])
export class MessageTagAssignmentEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'conversation_id', type: 'varchar', length: 36 })
  conversationId: string;

  @Column({ name: 'message_id', type: 'varchar', length: 36 })
  messageId: string;

  @Column({ name: 'tag_id', type: 'varchar', length: 36 })
  tagId: string;

  @Column({ name: 'assigned_by_user_id', type: 'varchar', length: 36 })
  assignedByUserId: string;

  @Column({
    name: 'message_snippet_preview',
    type: 'varchar',
    length: 500,
    nullable: true,
    default: null,
  })
  messageSnippetPreview: string | null;

  @Column({ name: 'note_text', type: 'varchar', length: 300, nullable: true, default: null })
  noteText: string | null;
}
