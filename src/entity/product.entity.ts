import { ProductIndustryTypeEnum } from 'src/common/enum';
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
  minAgeMonths?: number;
  maxAgeMonths?: number;
  skinTypeRecommendation?: string;
  fitNote?: string;
  numericRanges?: Record<string, { min: number; max: number }>;
  exactMatches?: Record<string, string>;
}

export interface ProductFreeGiftRuleItem {
  ruleId: string;
  ruleName: string;
  minOrderSubtotalVnd: number;
  requiredCategoryId?: string | null;
  giftVariantId: string;
  giftSkuCode: string;
  giftVariantName: string;
  giftQty: number;
  isActive: boolean;
}

export interface ProductUomConversionItem {
  unitName: string;
  conversionFactor: number;
  barcode?: string;
  retailPrice?: number;
}

@Entity('products')
@Index('uq_product_shop_code', ['shopId', 'code'], { unique: true })
@Index('idx_product_shop_category', ['shopId', 'categoryName', 'isActive'])
@Index('idx_product_shop_industry', ['shopId', 'industryType', 'isActive'])
export class ProductEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'code', type: 'varchar', length: 64 })
  code: string;

  @Column({ name: 'name', type: 'varchar', length: 255 })
  name: string;

  @Column({
    name: 'custom_category_id',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: null,
  })
  customCategoryId: string | null;

  @Column({
    name: 'industry_type',
    type: 'enum',
    enum: ProductIndustryTypeEnum,
    default: ProductIndustryTypeEnum.GENERAL_MULTI_CATEGORY,
  })
  industryType: ProductIndustryTypeEnum;

  @Column({ name: 'category_name', type: 'varchar', length: 120, default: 'Đa ngành hàng' })
  categoryName: string;

  @Column({ name: 'brand_name', type: 'varchar', length: 120, nullable: true, default: null })
  brandName: string | null;

  @Column({ name: 'unit_name', type: 'varchar', length: 32, default: 'Sản phẩm' })
  unitName: string;

  @Column({
    name: 'attribute_axis_1_name',
    type: 'varchar',
    length: 64,
    default: 'Phân loại 1',
  })
  attributeAxis1Name: string;

  @Column({
    name: 'attribute_axis_2_name',
    type: 'varchar',
    length: 64,
    default: 'Phân loại 2',
  })
  attributeAxis2Name: string;

  @Column({ name: 'thumbnail_url', type: 'text', nullable: true, default: null })
  thumbnailUrl: string | null;

  @Column({ name: 'description', type: 'text', nullable: true, default: null })
  description: string | null;

  @Column({ name: 'requires_batch_expiry', type: 'boolean', default: false })
  requiresBatchExpiry: boolean;

  @Column({ name: 'shelf_life_months', type: 'int', default: 0 })
  shelfLifeMonths: number;

  @Column({ name: 'storage_condition', type: 'varchar', length: 64, nullable: true, default: null })
  storageCondition: string | null;

  @Column({ name: 'technical_specs_json', type: 'json', nullable: true, default: null })
  technicalSpecsJson: Record<string, string> | null;

  @Column({ name: 'uom_conversions_json', type: 'json', nullable: true, default: null })
  uomConversionsJson: ProductUomConversionItem[] | null;

  @Column({ name: 'size_chart_metadata_json', type: 'json', nullable: true, default: null })
  sizeChartMetadataJson: ProductSizeChartRowItem[] | null;

  @Column({ name: 'free_gift_rules_json', type: 'json', nullable: true, default: null })
  freeGiftRulesJson: ProductFreeGiftRuleItem[] | null;

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
