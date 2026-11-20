import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export type QuickReplyVariableSourceType = 'STATIC_TEXT' | 'DYNAMIC_EXPRESSION' | 'PROMPT_ON_USE';

@Entity('quick_reply_custom_variables')
@Index('uq_qr_custom_var_shop_key', ['shopId', 'variableKey'], { unique: true })
@Index('idx_qr_custom_var_shop_active', ['shopId', 'isActive', 'sortOrder'])
export class QuickReplyCustomVariableEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'variable_key', type: 'varchar', length: 64 })
  variableKey: string;

  @Column({ name: 'label', type: 'varchar', length: 120 })
  label: string;

  @Column({ name: 'description', type: 'varchar', length: 255, nullable: true, default: null })
  description: string | null;

  @Column({ name: 'source_type', type: 'varchar', length: 32, default: 'STATIC_TEXT' })
  sourceType: QuickReplyVariableSourceType;

  @Column({ name: 'default_value', type: 'text', nullable: true, default: null })
  defaultValue: string | null;

  @Column({ name: 'sample_value', type: 'varchar', length: 255, nullable: true, default: null })
  sampleValue: string | null;

  @Column({ name: 'dynamic_path', type: 'varchar', length: 120, nullable: true, default: null })
  dynamicPath: string | null;

  @Column({ name: 'sort_order', type: 'int', default: 100 })
  sortOrder: number;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
