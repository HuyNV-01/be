import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export type QuickReplyScopeType = 'SHOP' | 'CHANNEL' | 'PERSONAL';

export interface QuickReplyAttachmentItem {
  fileId?: string;
  url: string;
  fileName: string;
  mimeType?: string;
}

export interface QuickReplyProductCardItem {
  skuCode: string;
  name: string;
  retailPrice: number;
  imageUrl?: string | null;
  availableQty?: number;
}

export interface QuickReplySequenceStep {
  order: number;
  contentTemplate: string;
  delayMs?: number;
  attachments?: QuickReplyAttachmentItem[];
}

@Entity('quick_reply_templates')
@Index('uq_quick_reply_shop_shortcut', ['shopId', 'shortcut'], { unique: true })
@Index('idx_quick_reply_shop_cat', ['shopId', 'category', 'sortOrder'])
export class QuickReplyTemplateEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'shortcut', type: 'varchar', length: 64 })
  shortcut: string;

  @Column({ name: 'title', type: 'varchar', length: 150 })
  title: string;

  @Column({ name: 'category', type: 'varchar', length: 64, default: 'GENERAL' })
  category: string;

  @Column({ name: 'scope', type: 'varchar', length: 24, default: 'SHOP' })
  scope: QuickReplyScopeType;

  @Column({ name: 'owner_user_id', type: 'varchar', length: 36, nullable: true, default: null })
  ownerUserId: string | null;

  @Column({ name: 'allowed_channel_ids_json', type: 'json', nullable: true, default: null })
  allowedChannelIdsJson: string[] | null;

  @Column({ name: 'content_template', type: 'text' })
  contentTemplate: string;

  @Column({ name: 'message_sequence_json', type: 'json', nullable: true, default: null })
  messageSequenceJson: QuickReplySequenceStep[] | null;

  @Column({ name: 'attachments_json', type: 'json', nullable: true })
  attachmentsJson: QuickReplyAttachmentItem[] | null;

  @Column({ name: 'product_cards_json', type: 'json', nullable: true })
  productCardsJson: QuickReplyProductCardItem[] | null;

  @Column({ name: 'auto_assign_tag_ids_json', type: 'json', nullable: true, default: null })
  autoAssignTagIdsJson: string[] | null;

  @Column({ name: 'is_pinned', type: 'boolean', default: false })
  isPinned: boolean;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'usage_count', type: 'int', default: 0 })
  usageCount: number;

  @Column({ name: 'last_used_at', type: 'timestamp', nullable: true, default: null })
  lastUsedAt: Date | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
