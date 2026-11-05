import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export enum TagCategoryEnum {
  CONSULTATION_STATUS = 'CONSULTATION_STATUS',
  CUSTOMER_TIER = 'CUSTOMER_TIER',
  MESSAGE_BOOKMARK = 'MESSAGE_BOOKMARK',
  DELIVERY_ISSUE = 'DELIVERY_ISSUE',
  MARKETING_SOURCE = 'MARKETING_SOURCE',
}

export type TagApplicableScope = 'CONVERSATION' | 'MESSAGE' | 'CUSTOMER' | 'ORDER';

export interface AutoTagRuleConfig {
  triggerEvent:
    | 'NER_PHONE_EXTRACTED'
    | 'NER_ADDRESS_EXTRACTED'
    | 'POS_DRAFT_CREATED'
    | 'POS_ORDER_CONFIRMED'
    | 'VIETQR_PAID'
    | 'CARRIER_DELIVERY_FAILED'
    | 'KEYWORD_MATCH';
  keywords?: string[];
  removeTagIdsOnApply?: string[];
}

@Entity('custom_tags')
@Index('uq_custom_tag_shop_slug', ['shopId', 'slug'], { unique: true })
@Index('idx_custom_tag_shop_cat_sort', ['shopId', 'category', 'sortOrder'])
export class CustomTagEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'name', type: 'varchar', length: 80 })
  name: string;

  @Column({ name: 'slug', type: 'varchar', length: 100 })
  slug: string;

  @Column({ name: 'color_hex', type: 'varchar', length: 16, default: '#3B82F6' })
  colorHex: string;

  @Column({ name: 'color_oklch', type: 'varchar', length: 64, default: 'oklch(0.62 0.19 259)' })
  colorOklch: string;

  @Column({
    name: 'category',
    type: 'enum',
    enum: TagCategoryEnum,
    default: TagCategoryEnum.CONSULTATION_STATUS,
  })
  category: TagCategoryEnum;

  @Column({ name: 'is_mutually_exclusive_group', type: 'boolean', default: false })
  isMutuallyExclusiveGroup: boolean;

  @Column({ name: 'applicable_scopes_json', type: 'json' })
  applicableScopesJson: TagApplicableScope[];

  @Column({ name: 'shortcut_key', type: 'varchar', length: 8, nullable: true, default: null })
  shortcutKey: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 0 })
  sortOrder: number;

  @Column({ name: 'auto_rule_config_json', type: 'json', nullable: true, default: null })
  autoRuleConfigJson: AutoTagRuleConfig | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
