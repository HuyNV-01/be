import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { CreateCustomTagDto, QueryCustomTagsDto, UpdateCustomTagDto } from 'src/dto/tags/tags.dto';
import { CustomTagEntity, TagCategoryEnum } from 'src/entity/custom-tag.entity';
import { Repository } from 'typeorm';

@Injectable()
export class CustomTagService {
  constructor(
    @InjectRepository(CustomTagEntity)
    private readonly customTagRepo: Repository<CustomTagEntity>,
  ) {}

  private normalizeSlug(raw: string): string {
    return raw
      .trim()
      .toUpperCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 90);
  }

  async ensureDefaultShopTags(shopId: string): Promise<CustomTagEntity[]> {
    const count = await this.customTagRepo.count({
      where: { shopId },
      withDeleted: true,
    });
    if (count > 0) {
      return this.customTagRepo.find({
        where: { shopId, isActive: true },
        order: { sortOrder: 'ASC', createdAt: 'ASC' },
      });
    }

    const defaults: Array<Partial<CustomTagEntity>> = [
      {
        shopId,
        name: 'Đang tư vấn',
        slug: 'CONSULTING',
        colorHex: '#3B82F6',
        colorOklch: 'oklch(0.62 0.19 259)',
        category: TagCategoryEnum.CONSULTATION_STATUS,
        isMutuallyExclusiveGroup: true,
        applicableScopesJson: ['CONVERSATION'],
        shortcutKey: '1',
        sortOrder: 1,
      },
      {
        shopId,
        name: 'Đã có SĐT',
        slug: 'HAS_PHONE',
        colorHex: '#8B5CF6',
        colorOklch: 'oklch(0.60 0.22 293)',
        category: TagCategoryEnum.CONSULTATION_STATUS,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['CONVERSATION', 'CUSTOMER'],
        shortcutKey: '2',
        sortOrder: 2,
        autoRuleConfigJson: {
          triggerEvent: 'NER_PHONE_EXTRACTED',
        },
      },
      {
        shopId,
        name: 'Đã chốt đơn',
        slug: 'ORDER_CREATED',
        colorHex: '#10B981',
        colorOklch: 'oklch(0.69 0.17 162)',
        category: TagCategoryEnum.CONSULTATION_STATUS,
        isMutuallyExclusiveGroup: true,
        applicableScopesJson: ['CONVERSATION', 'ORDER'],
        shortcutKey: '3',
        sortOrder: 3,
        autoRuleConfigJson: {
          triggerEvent: 'POS_ORDER_CONFIRMED',
        },
      },
      {
        shopId,
        name: 'Cần cứu đơn gấp',
        slug: 'DELIVERY_RESCUE_URGENT',
        colorHex: '#EF4444',
        colorOklch: 'oklch(0.63 0.24 29)',
        category: TagCategoryEnum.DELIVERY_ISSUE,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['CONVERSATION', 'ORDER'],
        shortcutKey: '4',
        sortOrder: 4,
        autoRuleConfigJson: {
          triggerEvent: 'CARRIER_DELIVERY_FAILED',
        },
      },
      {
        shopId,
        name: 'Địa chỉ giao hàng',
        slug: 'SHIPPING_ADDRESS',
        colorHex: '#0EA5E9',
        colorOklch: 'oklch(0.68 0.16 237)',
        category: TagCategoryEnum.MESSAGE_BOOKMARK,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['MESSAGE'],
        shortcutKey: '5',
        sortOrder: 5,
      },
      {
        shopId,
        name: 'Bill chuyển khoản',
        slug: 'BANK_TRANSFER_RECEIPT',
        colorHex: '#F59E0B',
        colorOklch: 'oklch(0.76 0.18 70)',
        category: TagCategoryEnum.MESSAGE_BOOKMARK,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['MESSAGE'],
        shortcutKey: '6',
        sortOrder: 6,
      },
      {
        shopId,
        name: 'Chiều cao & Cân nặng',
        slug: 'BODY_MEASUREMENT',
        colorHex: '#EC4899',
        colorOklch: 'oklch(0.65 0.21 354)',
        category: TagCategoryEnum.MESSAGE_BOOKMARK,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['MESSAGE'],
        shortcutKey: '7',
        sortOrder: 7,
      },
      {
        shopId,
        name: 'Lưu ý đóng gói kho',
        slug: 'PACKING_INSTRUCTION',
        colorHex: '#F97316',
        colorOklch: 'oklch(0.70 0.19 48)',
        category: TagCategoryEnum.MESSAGE_BOOKMARK,
        isMutuallyExclusiveGroup: false,
        applicableScopesJson: ['MESSAGE', 'ORDER'],
        shortcutKey: '8',
        sortOrder: 8,
      },
      {
        shopId,
        name: 'Khách VIP thân thiết',
        slug: 'CUSTOMER_VIP',
        colorHex: '#EAB308',
        colorOklch: 'oklch(0.79 0.18 86)',
        category: TagCategoryEnum.CUSTOMER_TIER,
        isMutuallyExclusiveGroup: true,
        applicableScopesJson: ['CONVERSATION', 'CUSTOMER'],
        shortcutKey: '9',
        sortOrder: 9,
      },
    ];

    const created = this.customTagRepo.create(defaults);
    return this.customTagRepo.save(created);
  }

  async listShopTags(shopId: string, query: QueryCustomTagsDto): Promise<CustomTagEntity[]> {
    await this.ensureDefaultShopTags(shopId);

    const qb = this.customTagRepo
      .createQueryBuilder('tag')
      .where('tag.shop_id = :shopId', { shopId })
      .andWhere('tag.is_active = true');

    if (query.category) {
      qb.andWhere('tag.category = :category', { category: query.category });
    }

    if (query.scope) {
      qb.andWhere('JSON_CONTAINS(tag.applicable_scopes_json, :scopeJson)', {
        scopeJson: JSON.stringify(query.scope),
      });
    }

    return qb.orderBy('tag.sort_order', 'ASC').addOrderBy('tag.created_at', 'ASC').getMany();
  }

  async createTag(shopId: string, dto: CreateCustomTagDto): Promise<CustomTagEntity> {
    const slug = this.normalizeSlug(dto.slug || dto.name);
    if (!slug) {
      throw new BadRequestException('INVALID_TAG_SLUG');
    }

    const existing = await this.customTagRepo.findOne({
      where: { shopId, slug },
      withDeleted: true,
    });

    if (existing && existing.isActive && !existing.deletedAt) {
      throw new BadRequestException('TAG_SLUG_ALREADY_EXISTS');
    }

    if (dto.shortcutKey) {
      await this.customTagRepo.update(
        { shopId, shortcutKey: dto.shortcutKey },
        { shortcutKey: null },
      );
    }

    // Nếu Tag cùng slug đã từng bị xóa mềm (isActive = false hoặc deletedAt != null), khôi phục và cập nhật lại
    if (existing) {
      if (existing.deletedAt) {
        await this.customTagRepo.restore(existing.id);
      }
      existing.deletedAt = null;
      existing.deletedBy = null;
      existing.isActive = true;
      existing.name = dto.name.trim();
      existing.colorHex = dto.colorHex || existing.colorHex || '#3B82F6';
      existing.colorOklch = dto.colorOklch || existing.colorOklch || 'oklch(0.62 0.19 259)';
      existing.category = dto.category || existing.category || TagCategoryEnum.CONSULTATION_STATUS;
      existing.isMutuallyExclusiveGroup = Boolean(dto.isMutuallyExclusiveGroup);
      existing.applicableScopesJson =
        dto.applicableScopesJson && dto.applicableScopesJson.length > 0
          ? dto.applicableScopesJson
          : ['CONVERSATION'];
      existing.shortcutKey = dto.shortcutKey || null;
      existing.sortOrder = dto.sortOrder ?? existing.sortOrder ?? 10;
      existing.autoRuleConfigJson = dto.autoRuleConfigJson || null;
      return this.customTagRepo.save(existing);
    }

    const entity = this.customTagRepo.create({
      shopId,
      name: dto.name.trim(),
      slug,
      colorHex: dto.colorHex || '#3B82F6',
      colorOklch: dto.colorOklch || 'oklch(0.62 0.19 259)',
      category: dto.category || TagCategoryEnum.CONSULTATION_STATUS,
      isMutuallyExclusiveGroup: Boolean(dto.isMutuallyExclusiveGroup),
      applicableScopesJson:
        dto.applicableScopesJson && dto.applicableScopesJson.length > 0
          ? dto.applicableScopesJson
          : ['CONVERSATION'],
      shortcutKey: dto.shortcutKey || null,
      sortOrder: dto.sortOrder ?? 10,
      autoRuleConfigJson: dto.autoRuleConfigJson || null,
      isActive: true,
    });

    return this.customTagRepo.save(entity);
  }

  async updateTag(
    shopId: string,
    tagId: string,
    dto: UpdateCustomTagDto,
  ): Promise<CustomTagEntity> {
    const tag = await this.customTagRepo.findOne({
      where: { id: tagId, shopId },
    });
    if (!tag) {
      throw new NotFoundException('CUSTOM_TAG_NOT_FOUND');
    }

    if (dto.shortcutKey && dto.shortcutKey !== tag.shortcutKey) {
      await this.customTagRepo.update(
        { shopId, shortcutKey: dto.shortcutKey },
        { shortcutKey: null },
      );
    }

    if (dto.name !== undefined) tag.name = dto.name.trim();
    if (dto.colorHex !== undefined) tag.colorHex = dto.colorHex;
    if (dto.colorOklch !== undefined) tag.colorOklch = dto.colorOklch;
    if (dto.category !== undefined) tag.category = dto.category;
    if (dto.isMutuallyExclusiveGroup !== undefined) {
      tag.isMutuallyExclusiveGroup = dto.isMutuallyExclusiveGroup;
    }
    if (dto.applicableScopesJson !== undefined) {
      tag.applicableScopesJson = dto.applicableScopesJson;
    }
    if (dto.shortcutKey !== undefined) tag.shortcutKey = dto.shortcutKey;
    if (dto.sortOrder !== undefined) tag.sortOrder = dto.sortOrder;
    if (dto.autoRuleConfigJson !== undefined) {
      tag.autoRuleConfigJson = dto.autoRuleConfigJson;
    }
    if (dto.isActive !== undefined) tag.isActive = dto.isActive;

    return this.customTagRepo.save(tag);
  }

  async deleteTag(shopId: string, tagId: string): Promise<{ id: string; deleted: boolean }> {
    const tag = await this.customTagRepo.findOne({
      where: { id: tagId, shopId },
    });
    if (!tag) {
      throw new NotFoundException('CUSTOM_TAG_NOT_FOUND');
    }

    tag.isActive = false;
    tag.shortcutKey = null;
    await this.customTagRepo.save(tag);
    return { id: tagId, deleted: true };
  }
}
