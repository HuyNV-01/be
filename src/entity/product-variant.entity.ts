import { ProductIndustryTypeEnum } from 'src/common/enum';
import { Column, Entity, Index } from 'typeorm';

import { BaseModel } from './base-model';
import { ProductSizeChartRowItem, ProductUomConversionItem } from './product.entity';

export interface BundleBomComponentItem {
  componentVariantId: string;
  componentSkuCode: string;
  componentName: string;
  requiredQty: number;
  retailPriceSnapshot: number;
}

@Entity('product_variants')
@Index('uq_variant_shop_sku', ['shopId', 'skuCode'], { unique: true })
@Index('idx_variant_shop_barcode', ['shopId', 'barcode'])
@Index('idx_variant_shop_product', ['shopId', 'productId'])
export class ProductVariantEntity extends BaseModel {
  @Column({ name: 'shop_id', type: 'varchar', length: 36 })
  shopId: string;

  @Column({ name: 'product_id', type: 'varchar', length: 36 })
  productId: string;

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

  @Column({ name: 'sku_code', type: 'varchar', length: 80 })
  skuCode: string;

  @Column({ name: 'barcode', type: 'varchar', length: 64 })
  barcode: string;

  @Column({ name: 'variant_name', type: 'varchar', length: 255 })
  variantName: string;

  @Column({ name: 'color_name', type: 'varchar', length: 64, nullable: true, default: null })
  colorName: string | null;

  @Column({ name: 'size_code', type: 'varchar', length: 32, nullable: true, default: null })
  sizeCode: string | null;

  @Column({
    name: 'attribute_axis_1_name',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: 'Phân loại 1',
  })
  attributeAxis1Name: string | null;

  @Column({
    name: 'attribute_axis_1_value',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  attributeAxis1Value: string | null;

  @Column({
    name: 'attribute_axis_2_name',
    type: 'varchar',
    length: 64,
    nullable: true,
    default: 'Phân loại 2',
  })
  attributeAxis2Name: string | null;

  @Column({
    name: 'attribute_axis_2_value',
    type: 'varchar',
    length: 120,
    nullable: true,
    default: null,
  })
  attributeAxis2Value: string | null;

  @Column({ name: 'attributes_json', type: 'json', nullable: true, default: null })
  attributesJson: Record<string, string> | null;

  @Column({ name: 'image_url', type: 'text', nullable: true, default: null })
  imageUrl: string | null;

  @Column({ name: 'retail_price', type: 'decimal', precision: 15, scale: 2, default: 0 })
  retailPrice: number;

  @Column({ name: 'wholesale_price', type: 'decimal', precision: 15, scale: 2, default: 0 })
  wholesalePrice: number;

  /**
   * Giá vốn bình quân gia quyền (`costPrice`) được bảo vệ bởi `FieldLevelSecurityInterceptor`:
   * Tự động bị cắt khỏi JSON Response nếu người dùng không có quyền `CATALOG_COST_PRICE_VIEW` hoặc `FINANCE_PNL_STATEMENT_VIEW`.
   */
  @Column({ name: 'cost_price', type: 'decimal', precision: 15, scale: 2, default: 0 })
  costPrice: number;

  @Column({ name: 'max_discount_percent', type: 'int', default: 15 })
  maxDiscountPercent: number;

  @Column({ name: 'weight_grams', type: 'int', default: 300 })
  weightGrams: number;

  @Column({ name: 'length_cm', type: 'int', default: 20 })
  lengthCm: number;

  @Column({ name: 'width_cm', type: 'int', default: 15 })
  widthCm: number;

  @Column({ name: 'height_cm', type: 'int', default: 5 })
  heightCm: number;

  @Column({ name: 'is_bundle_bom', type: 'boolean', default: false })
  isBundleBom: boolean;

  @Column({ name: 'bundle_components_json', type: 'json', nullable: true, default: null })
  bundleComponentsJson: BundleBomComponentItem[] | null;

  @Column({ name: 'is_free_gift_item', type: 'boolean', default: false })
  isFreeGiftItem: boolean;

  @Column({ name: 'requires_serial_imei', type: 'boolean', default: false })
  requiresSerialImei: boolean;

  @Column({ name: 'warranty_months', type: 'int', default: 0 })
  warrantyMonths: number;

  @Column({ name: 'requires_batch_expiry', type: 'boolean', default: false })
  requiresBatchExpiry: boolean;

  @Column({ name: 'batch_code', type: 'varchar', length: 64, nullable: true, default: null })
  batchCode: string | null;

  @Column({
    name: 'manufacturing_date',
    type: 'varchar',
    length: 32,
    nullable: true,
    default: null,
  })
  manufacturingDate: string | null;

  @Column({ name: 'expiry_date', type: 'varchar', length: 32, nullable: true, default: null })
  expiryDate: string | null;

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

  @Column({ name: 'is_active', type: 'boolean', default: true })
  isActive: boolean;
}
