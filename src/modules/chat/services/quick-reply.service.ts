import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CreateQuickReplyTemplateDto,
  UpdateQuickReplyTemplateDto,
} from 'src/dto/chat/omnichannel-inbox.dto';
import { QuickReplyTemplateEntity } from 'src/entity/quick-reply-template.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

@Injectable()
export class QuickReplyService {
  constructor(
    @InjectRepository(QuickReplyTemplateEntity)
    private readonly quickReplyRepo: Repository<QuickReplyTemplateEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
  ) {}

  private normalizeShortcut(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^\/+/, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  async ensureDefaultTemplates(shopId: string): Promise<QuickReplyTemplateEntity[]> {
    const count = await this.quickReplyRepo.count({
      where: { shopId },
      withDeleted: true,
    });
    if (count > 0) {
      return this.quickReplyRepo.find({
        where: { shopId, isActive: true },
        order: { sortOrder: 'ASC', usageCount: 'DESC' },
      });
    }

    const defaults: Array<Partial<QuickReplyTemplateEntity>> = [
      {
        shopId,
        shortcut: 'xin-chao',
        title: 'Chào khách hàng mới & hỏi nhu cầu',
        category: 'GREETING',
        contentTemplate:
          'Dạ {{shop_name}} xin chào {{salutation}} {{customer_name}} ạ! Em là {{agent_name}}, hiện mẫu {{salutation}} đang quan tâm bên em đang sẵn đủ màu và size. Mình cho em xin chiều cao và cân nặng để em tư vấn chuẩn size nhất nhé ạ!',
        sortOrder: 1,
      },
      {
        shopId,
        shortcut: 'bang-size',
        title: 'Gửi bảng thông số chọn Size chuẩn',
        category: 'CONSULTATION',
        contentTemplate:
          'Dạ em gửi {{salutation}} {{customer_name}} bảng thông số size chuẩn của {{shop_name}} ạ:\n• Size S: 42kg - 48kg (Eo < 66cm)\n• Size M: 49kg - 54kg (Eo 67-71cm)\n• Size L: 55kg - 60kg (Eo 72-76cm)\n• Size XL: 61kg - 67kg (Eo 77-82cm)\nMình mặc vừa thoải mái và được kiểm tra hàng trước khi thanh toán ạ!',
        sortOrder: 2,
      },
      {
        shopId,
        shortcut: 'xin-sdt',
        title: 'Xin SĐT & Địa chỉ để giữ hàng khuyến mãi',
        category: 'CLOSING',
        contentTemplate:
          'Dạ mẫu này hiện kho {{shop_name}} chỉ còn vài chiếc cuối trong chương trình ưu đãi. {{salutation}} {{customer_name}} cho em xin **Số điện thoại + Địa chỉ nhận hàng** để em giữ đơn ưu đãi ngay cho mình nhé ạ!',
        sortOrder: 3,
      },
      {
        shopId,
        shortcut: 'stk',
        title: 'Hướng dẫn chuyển khoản cọc / thanh toán VietQR',
        category: 'PAYMENT',
        contentTemplate:
          'Dạ {{salutation}} {{customer_name}} vui lòng quét mã VietQR trên phiếu đơn hoặc chuyển khoản theo nội dung tự động để hệ thống gạch nợ tức thì trong 3 giây ạ. Ngay khi nhận được, em sẽ ưu tiên đóng gói xuất kho liền cho mình!',
        sortOrder: 4,
      },
      {
        shopId,
        shortcut: 'cuu-don',
        title: 'Hỗ trợ khách khi bưu tá giao chưa gặp',
        category: 'DELIVERY_RESCUE',
        contentTemplate:
          'Dạ {{salutation}} {{customer_name}} ơi, bưu tá vừa liên hệ giao kiện hàng của {{shop_name}} nhưng chưa gặp được mình ạ ({tracking_link}). Mình nhắn lại giúp em khung giờ thuận tiện để em báo bưu tá phát lại miễn phí cho mình nhé!',
        sortOrder: 5,
      },
    ];

    const created = this.quickReplyRepo.create(defaults);
    return this.quickReplyRepo.save(created);
  }

  async listTemplates(shopId: string, search?: string): Promise<QuickReplyTemplateEntity[]> {
    await this.ensureDefaultTemplates(shopId);

    const qb = this.quickReplyRepo
      .createQueryBuilder('qr')
      .where('qr.shop_id = :shopId', { shopId })
      .andWhere('qr.is_active = true');

    if (search?.trim()) {
      const kw = `%${search.trim().replace(/^\/+/, '')}%`;
      qb.andWhere('(qr.shortcut LIKE :kw OR qr.title LIKE :kw OR qr.content_template LIKE :kw)', {
        kw,
      });
    }

    return qb.orderBy('qr.sort_order', 'ASC').addOrderBy('qr.usage_count', 'DESC').getMany();
  }

  async createTemplate(
    shopId: string,
    dto: CreateQuickReplyTemplateDto,
  ): Promise<QuickReplyTemplateEntity> {
    const shortcut = this.normalizeShortcut(dto.shortcut);
    if (!shortcut) {
      throw new BadRequestException('INVALID_QUICK_REPLY_SHORTCUT');
    }

    const existing = await this.quickReplyRepo.findOne({
      where: { shopId, shortcut },
      withDeleted: true,
    });

    if (existing && existing.isActive && !existing.deletedAt) {
      throw new BadRequestException('QUICK_REPLY_SHORTCUT_ALREADY_EXISTS');
    }

    // Nếu mẫu câu cùng shortcut từng bị xóa mềm trước đó, khôi phục và cập nhật lại để tránh lỗi duplicate key
    if (existing) {
      if (existing.deletedAt) {
        await this.quickReplyRepo.restore(existing.id);
      }
      existing.deletedAt = null;
      existing.deletedBy = null;
      existing.isActive = true;
      existing.title = dto.title.trim();
      existing.category = dto.category || existing.category || 'GENERAL';
      existing.contentTemplate = dto.contentTemplate.trim();
      existing.attachmentsJson = dto.attachmentsJson || [];
      existing.productCardsJson = dto.productCardsJson || [];
      return this.quickReplyRepo.save(existing);
    }

    const template = this.quickReplyRepo.create({
      shopId,
      shortcut,
      title: dto.title.trim(),
      category: dto.category || 'GENERAL',
      contentTemplate: dto.contentTemplate.trim(),
      attachmentsJson: dto.attachmentsJson || [],
      productCardsJson: dto.productCardsJson || [],
      isActive: true,
    });

    return this.quickReplyRepo.save(template);
  }

  async updateTemplate(
    shopId: string,
    templateId: string,
    dto: UpdateQuickReplyTemplateDto,
  ): Promise<QuickReplyTemplateEntity> {
    const template = await this.quickReplyRepo.findOne({
      where: { id: templateId, shopId },
    });
    if (!template) {
      throw new NotFoundException('QUICK_REPLY_TEMPLATE_NOT_FOUND');
    }

    if (dto.shortcut !== undefined) {
      const nextShortcut = this.normalizeShortcut(dto.shortcut);
      if (nextShortcut && nextShortcut !== template.shortcut) {
        const collision = await this.quickReplyRepo.findOne({
          where: { shopId, shortcut: nextShortcut },
          withDeleted: true,
        });
        if (collision && collision.id !== template.id) {
          if (collision.isActive && !collision.deletedAt) {
            throw new BadRequestException('QUICK_REPLY_SHORTCUT_ALREADY_EXISTS');
          }
          await this.quickReplyRepo.delete(collision.id);
        }
        template.shortcut = nextShortcut;
      }
    }
    if (dto.title !== undefined) template.title = dto.title.trim();
    if (dto.category !== undefined) template.category = dto.category;
    if (dto.contentTemplate !== undefined) {
      template.contentTemplate = dto.contentTemplate.trim();
    }
    if (dto.attachmentsJson !== undefined) {
      template.attachmentsJson = dto.attachmentsJson;
    }
    if (dto.productCardsJson !== undefined) {
      template.productCardsJson = dto.productCardsJson;
    }
    if (dto.isActive !== undefined) template.isActive = dto.isActive;

    return this.quickReplyRepo.save(template);
  }

  async deleteTemplate(
    shopId: string,
    templateId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const template = await this.quickReplyRepo.findOne({
      where: { id: templateId, shopId },
    });
    if (!template) {
      throw new NotFoundException('QUICK_REPLY_TEMPLATE_NOT_FOUND');
    }

    template.isActive = false;
    await this.quickReplyRepo.save(template);
    return { id: templateId, deleted: true };
  }

  /**
   * F03.3 & F03.4: Nội suy biến động {{customer_name}}, {{salutation}}, {{agent_name}}, {{shop_name}}, {{tracking_link}}
   */
  async interpolateTemplate(params: {
    shopId: string;
    templateId: string;
    customerName?: string;
    salutation?: string;
    agentName?: string;
    trackingLink?: string;
  }): Promise<{
    interpolatedContent: string;
    template: QuickReplyTemplateEntity;
  }> {
    const [template, shop] = await Promise.all([
      this.quickReplyRepo.findOne({
        where: { id: params.templateId, shopId: params.shopId },
      }),
      this.shopRepo.findOne({ where: { id: params.shopId } }),
    ]);

    if (!template) {
      throw new NotFoundException('QUICK_REPLY_TEMPLATE_NOT_FOUND');
    }

    await this.quickReplyRepo.increment({ id: template.id }, 'usageCount', 1);

    const vars: Record<string, string> = {
      customer_name: params.customerName || 'anh/chị',
      salutation: params.salutation || 'anh/chị',
      agent_name: params.agentName || 'Tư vấn viên',
      shop_name: shop?.name || 'Cửa hàng',
      tracking_link: params.trackingLink || 'https://tracking.pancake.vn',
    };

    const interpolatedContent = template.contentTemplate.replace(
      /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g,
      (_match, key1, key2) => {
        const key = String(key1 || key2).toLowerCase();
        return vars[key] ?? _match;
      },
    );

    return {
      interpolatedContent,
      template,
    };
  }
}
