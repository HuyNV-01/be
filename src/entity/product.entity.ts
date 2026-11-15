import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';

export interface ProductSizeChartRowItem {
  sizeCode: string;
  minHeightCm: number;
  maxHeightCm: number;
  minWeightKg: number;
  maxWeightKg: number;
  chestCm?: number;
  waistCm?: number;
  hipCm?: number;
  fitNote?: string;
}

export interface ProductFreeGiftRuleItem {
  ruleId: string;
  ruleName: string;
  minOrderSubtotalVnd: number;
  giftVariantId: string;
  giftSkuCode: string;
  giftVariantName: string;
  giftQty: number;
  isActive: boolean;
}

@Entity('products')
@Index('uq_product_shop_code', ['shopId', 'code'], { unique: true })
@Index('idx_product_shop_category', ['shopId', 'categoryName', 'isActive'])
export class ProductEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'code', type: 'varchar', length: 64 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 255 })
  name: string;

  @Column({ name: 'category_name', type: 'varchar', length: 120, default: 'Thời trang & Phụ kiện' })
  categoryName: string;

  @Column({ name: 'brand_name', type: 'varchar', length: 120, nullable: true, default: null })
  brandName: string | null;

  @Column({ name: 'unit_name', type: 'varchar', length: 32, default: 'Cái' })
  unitName: string;

  @Column({ name: 'thumbnail_url', type: 'text', nullable: true, default: null })
  thumbnailUrl: string | null;

  @Column({ name: 'description', type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ name: 'size_chart_metadata_json', type: 'json', nullable: true, default: null })
  sizeChartMetadataJson: ProductSizeChartRowItem[] | null;

  @Column({ name: 'free_gift_rules_json', type: 'json', nullable: true, default: null })
  freeGiftRulesJson: ProductFreeGiftRuleItem[] | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
