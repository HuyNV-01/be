import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

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

  @Column({ name: 'content_template', type: 'text' })
  contentTemplate: string;

  @Column({ name: 'attachments_json', type: 'json', nullable: true })
  attachmentsJson: QuickReplyAttachmentItem[] | null;

  @Column({ name: 'product_cards_json', type: 'json', nullable: true })
  productCardsJson: QuickReplyProductCardItem[] | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'usage_count', type: 'int', default: 0 })
  usageCount: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
