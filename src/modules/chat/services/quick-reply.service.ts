import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CreateQuickReplyTemplateDto,
  UpdateQuickReplyTemplateDto,
} from 'src/dto/chat/omnichannel-inbox.dto';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import {
  QuickReplyAttachmentItem,
  QuickReplyScopeType,
  QuickReplySequenceStep,
  QuickReplyTemplateEntity,
} from 'src/entity/quick-reply-template.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

export interface InterpolatedQuickReplyStep {
  order: number;
  content: string;
  delayMs: number;
  attachments: QuickReplyAttachmentItem[];
}

@Injectable()
export class QuickReplyService {
  constructor(
    @InjectRepository(QuickReplyTemplateEntity)
    private readonly quickReplyRepo: Repository<QuickReplyTemplateEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
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

  public getAvailableVariablesCatalog() {
    return [
      { key: 'customer_name', label: 'Tên khách hàng', sample: 'Nguyễn Lan Anh' },
      { key: 'salutation', label: 'Danh xưng (anh/chị)', sample: 'chị' },
      { key: 'agent_name', label: 'Tên tư vấn viên', sample: 'Minh Thư' },
      { key: 'shop_name', label: 'Tên cửa hàng', sample: 'Shop Thời Trang' },
      { key: 'page_name', label: 'Tên Fanpage / Kênh', sample: 'Fanpage Chính' },
      { key: 'order_code', label: 'Mã đơn hàng gần nhất', sample: 'ORD-20261120-001' },
      { key: 'cod_amount', label: 'Tiền thu hộ COD', sample: '350.000đ' },
      { key: 'tracking_number', label: 'Mã vận đơn 3PL', sample: 'GHN88991122' },
      {
        key: 'tracking_link',
        label: 'Link tra cứu vận đơn',
        sample: 'https://donhang.ghn.vn/?order_code=...',
      },
      { key: 'carrier_name', label: 'Hãng vận chuyển', sample: 'GHN' },
      { key: 'bank_name', label: 'Ngân hàng VietQR', sample: 'MB Bank' },
      { key: 'bank_account_no', label: 'Số tài khoản VietQR', sample: '0988123456' },
      { key: 'bank_account_holder', label: 'Chủ tài khoản VietQR', sample: 'NGUYEN VAN A' },
      { key: 'current_date', label: 'Ngày hiện tại (dd/MM/yyyy)', sample: '20/11/2026' },
    ];
  }

  async ensureDefaultTemplates(shopId: string): Promise<QuickReplyTemplateEntity[]> {
    const count = await this.quickReplyRepo.count({
      where: { shopId },
      withDeleted: true,
    });
    if (count > 0) {
      return this.quickReplyRepo.find({
        where: { shopId, isActive: true },
        order: { isPinned: 'DESC', sortOrder: 'ASC', usageCount: 'DESC' },
      });
    }

    const defaults: Array<Partial<QuickReplyTemplateEntity>> = [
      {
        shopId,
        shortcut: 'xin-chao',
        title: 'Chào khách hàng mới & hỏi nhu cầu',
        category: 'GREETING',
        scope: 'SHOP',
        isPinned: true,
        contentTemplate:
          'Dạ {{shop_name}} xin chào {{salutation}} {{customer_name}} ạ! Em là {{agent_name}}, hiện mẫu {{salutation}} đang quan tâm bên em đang sẵn đủ màu và size. Mình cho em xin chiều cao và cân nặng để em tư vấn chuẩn size nhất nhé ạ!',
        sortOrder: 1,
      },
      {
        shopId,
        shortcut: 'xin-sdt',
        title: 'Xin SĐT & Địa chỉ để giữ hàng khuyến mãi',
        category: 'CLOSING',
        scope: 'SHOP',
        isPinned: true,
        contentTemplate:
          'Dạ mẫu này hiện kho {{shop_name}} chỉ còn vài chiếc cuối trong chương trình ưu đãi. {{salutation}} {{customer_name}} cho em xin Số điện thoại + Địa chỉ nhận hàng để em giữ đơn ưu đãi ngay cho mình nhé ạ!',
        sortOrder: 2,
      },
      {
        shopId,
        shortcut: 'stk',
        title: 'Gửi thông tin chuyển khoản / VietQR tự động',
        category: 'PAYMENT',
        scope: 'SHOP',
        contentTemplate:
          'Dạ {{salutation}} {{customer_name}} chuyển khoản đơn {{order_code}} giúp em về tài khoản:\n• Ngân hàng: {{bank_name}}\n• Số TK: {{bank_account_no}}\n• Chủ TK: {{bank_account_holder}}\n• Số tiền: {{cod_amount}}\nHệ thống sẽ tự động gạch nợ trong 3 giây và ưu tiên đóng gói xuất kho liền ạ!',
        sortOrder: 3,
      },
      {
        shopId,
        shortcut: 'kiem-tra-don',
        title: 'Báo mã vận đơn & link hành trình cho khách',
        category: 'ORDER_TRACKING',
        scope: 'SHOP',
        contentTemplate:
          'Dạ đơn hàng {{order_code}} của {{salutation}} {{customer_name}} đã được bàn giao cho {{carrier_name}} (Mã vận đơn: {{tracking_number}}). Mình có thể theo dõi hành trình trực tiếp tại đây ạ: {{tracking_link}}',
        sortOrder: 4,
      },
      {
        shopId,
        shortcut: 'cuu-don',
        title: 'Hỗ trợ khách khi bưu tá giao chưa gặp',
        category: 'DELIVERY_RESCUE',
        scope: 'SHOP',
        contentTemplate:
          'Dạ {{salutation}} {{customer_name}} ơi, bưu tá {{carrier_name}} vừa liên hệ giao kiện hàng {{order_code}} của {{shop_name}} nhưng chưa gặp được mình ạ ({{tracking_link}}). Mình nhắn lại giúp em khung giờ thuận tiện để em báo bưu tá phát lại miễn phí cho mình nhé!',
        sortOrder: 5,
      },
    ];

    const created = this.quickReplyRepo.create(defaults);
    return this.quickReplyRepo.save(created);
  }

  async listTemplates(
    shopId: string,
    search?: string,
    options?: { category?: string; channelId?: string; actorUserId?: string },
  ): Promise<QuickReplyTemplateEntity[]> {
    await this.ensureDefaultTemplates(shopId);

    const qb = this.quickReplyRepo
      .createQueryBuilder('qr')
      .where('qr.shop_id = :shopId', { shopId })
      .andWhere('qr.is_active = true');

    if (options?.category && options.category !== 'ALL') {
      qb.andWhere('qr.category = :category', { category: options.category });
    }

    if (search?.trim()) {
      const kw = `%${search.trim().replace(/^\/+/, '')}%`;
      qb.andWhere('(qr.shortcut LIKE :kw OR qr.title LIKE :kw OR qr.content_template LIKE :kw)', {
        kw,
      });
    }

    const rows = await qb
      .orderBy('qr.is_pinned', 'DESC')
      .addOrderBy('qr.sort_order', 'ASC')
      .addOrderBy('qr.usage_count', 'DESC')
      .getMany();

    // Lọc theo phạm vi cá nhân / kênh kết nối mà không làm hỏng dữ liệu cũ (`scope = 'SHOP'`)
    return rows.filter((tpl) => {
      if (tpl.scope === 'PERSONAL' && options?.actorUserId && tpl.ownerUserId) {
        return tpl.ownerUserId === options.actorUserId;
      }
      if (
        tpl.scope === 'CHANNEL' &&
        options?.channelId &&
        Array.isArray(tpl.allowedChannelIdsJson) &&
        tpl.allowedChannelIdsJson.length > 0
      ) {
        return tpl.allowedChannelIdsJson.includes(options.channelId);
      }
      return true;
    });
  }

  async createTemplate(
    shopId: string,
    dto: CreateQuickReplyTemplateDto & {
      scope?: QuickReplyScopeType;
      ownerUserId?: string;
      allowedChannelIdsJson?: string[];
      messageSequenceJson?: QuickReplySequenceStep[];
      autoAssignTagIdsJson?: string[];
      isPinned?: boolean;
    },
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

    if (existing) {
      if (existing.deletedAt) {
        await this.quickReplyRepo.restore(existing.id);
      }
      existing.deletedAt = null;
      existing.deletedBy = null;
      existing.isActive = true;
      existing.title = dto.title.trim();
      existing.category = dto.category || existing.category || 'GENERAL';
      existing.scope = dto.scope || 'SHOP';
      existing.ownerUserId = dto.scope === 'PERSONAL' ? dto.ownerUserId || null : null;
      existing.allowedChannelIdsJson = dto.allowedChannelIdsJson || null;
      existing.contentTemplate = dto.contentTemplate.trim();
      existing.messageSequenceJson = dto.messageSequenceJson || null;
      existing.attachmentsJson = dto.attachmentsJson || [];
      existing.productCardsJson = dto.productCardsJson || [];
      existing.autoAssignTagIdsJson = dto.autoAssignTagIdsJson || null;
      existing.isPinned = Boolean(dto.isPinned);
      return this.quickReplyRepo.save(existing);
    }

    const template = this.quickReplyRepo.create({
      shopId,
      shortcut,
      title: dto.title.trim(),
      category: dto.category || 'GENERAL',
      scope: dto.scope || 'SHOP',
      ownerUserId: dto.scope === 'PERSONAL' ? dto.ownerUserId || null : null,
      allowedChannelIdsJson: dto.allowedChannelIdsJson || null,
      contentTemplate: dto.contentTemplate.trim(),
      messageSequenceJson: dto.messageSequenceJson || null,
      attachmentsJson: dto.attachmentsJson || [],
      productCardsJson: dto.productCardsJson || [],
      autoAssignTagIdsJson: dto.autoAssignTagIdsJson || null,
      isPinned: Boolean(dto.isPinned),
      isActive: true,
    });

    return this.quickReplyRepo.save(template);
  }

  async updateTemplate(
    shopId: string,
    templateId: string,
    dto: UpdateQuickReplyTemplateDto & {
      scope?: QuickReplyScopeType;
      allowedChannelIdsJson?: string[] | null;
      messageSequenceJson?: QuickReplySequenceStep[] | null;
      autoAssignTagIdsJson?: string[] | null;
      isPinned?: boolean;
      sortOrder?: number;
    },
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
    if (dto.scope !== undefined) template.scope = dto.scope;
    if (dto.allowedChannelIdsJson !== undefined) {
      template.allowedChannelIdsJson = dto.allowedChannelIdsJson;
    }
    if (dto.contentTemplate !== undefined) {
      template.contentTemplate = dto.contentTemplate.trim();
    }
    if (dto.messageSequenceJson !== undefined) {
      template.messageSequenceJson = dto.messageSequenceJson;
    }
    if (dto.attachmentsJson !== undefined) template.attachmentsJson = dto.attachmentsJson;
    if (dto.productCardsJson !== undefined) template.productCardsJson = dto.productCardsJson;
    if (dto.autoAssignTagIdsJson !== undefined) {
      template.autoAssignTagIdsJson = dto.autoAssignTagIdsJson;
    }
    if (dto.isPinned !== undefined) template.isPinned = dto.isPinned;
    if (dto.sortOrder !== undefined) template.sortOrder = dto.sortOrder;
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

  private replaceTemplateVariables(raw: string, vars: Record<string, string>): string {
    return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g, (_match, k1, k2) => {
      const key = String(k1 || k2).toLowerCase();
      return vars[key] ?? _match;
    });
  }

  async interpolateTemplate(params: {
    shopId: string;
    templateId: string;
    conversationId?: string;
    customerName?: string;
    salutation?: string;
    agentName?: string;
    pageName?: string;
    trackingLink?: string;
  }): Promise<{
    interpolatedContent: string;
    interpolatedSequence: InterpolatedQuickReplyStep[];
    autoAssignTagIds: string[];
    template: QuickReplyTemplateEntity;
  }> {
    const [template, shop, latestOrder] = await Promise.all([
      this.quickReplyRepo.findOne({ where: { id: params.templateId, shopId: params.shopId } }),
      this.shopRepo.findOne({ where: { id: params.shopId } }),
      params.conversationId
        ? this.orderRepo.findOne({
            where: { shopId: params.shopId, conversationId: params.conversationId },
            order: { createdAt: 'DESC' },
          })
        : Promise.resolve(null),
    ]);

    if (!template) {
      throw new NotFoundException('QUICK_REPLY_TEMPLATE_NOT_FOUND');
    }

    await this.quickReplyRepo.update(
      { id: template.id },
      {
        usageCount: Number(template.usageCount || 0) + 1,
        lastUsedAt: new Date(),
      },
    );

    const vietQrBank = (shop as any)?.catalogAndPosConfigJson?.vietQrBankConfig || null;
    const now = new Date();
    const currentDateStr = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;

    const resolvedTracking = latestOrder?.trackingNumber || '';
    const defaultTrackingUrl =
      params.trackingLink ||
      (resolvedTracking
        ? `https://donhang.ghn.vn/?order_code=${encodeURIComponent(resolvedTracking)}`
        : '');

    const vars: Record<string, string> = {
      customer_name: params.customerName || 'anh/chị',
      salutation: params.salutation || 'anh/chị',
      agent_name: params.agentName || 'Tư vấn viên',
      shop_name: shop?.name || 'Cửa hàng',
      page_name: params.pageName || shop?.name || 'Fanpage',
      order_code: latestOrder?.orderCode || '',
      cod_amount: latestOrder
        ? `${Number(latestOrder.codCollectAmount || 0).toLocaleString('vi-VN')}đ`
        : '',
      tracking_number: resolvedTracking,
      tracking_link: defaultTrackingUrl,
      carrier_name: latestOrder?.carrierCode || 'ĐVVC',
      bank_name: vietQrBank?.bankShortName || vietQrBank?.bankCode || '',
      bank_account_no: vietQrBank?.accountNumber || '',
      bank_account_holder: vietQrBank?.accountName || '',
      current_date: currentDateStr,
    };

    const interpolatedContent = this.replaceTemplateVariables(template.contentTemplate, vars);

    const rawSteps: QuickReplySequenceStep[] =
      Array.isArray(template.messageSequenceJson) && template.messageSequenceJson.length > 0
        ? template.messageSequenceJson
        : [
            {
              order: 1,
              contentTemplate: template.contentTemplate,
              delayMs: 0,
              attachments: template.attachmentsJson || [],
            },
          ];

    const interpolatedSequence: InterpolatedQuickReplyStep[] = rawSteps
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((step, idx) => ({
        order: idx + 1,
        content: this.replaceTemplateVariables(step.contentTemplate || '', vars),
        delayMs: Math.max(0, Math.min(10000, Number(step.delayMs || 0))),
        attachments: Array.isArray(step.attachments) ? step.attachments : [],
      }));

    return {
      interpolatedContent,
      interpolatedSequence,
      autoAssignTagIds: Array.isArray(template.autoAssignTagIdsJson)
        ? template.autoAssignTagIdsJson
        : [],
      template,
    };
  }
}
