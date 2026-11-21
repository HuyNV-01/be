import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  CreateQuickReplyCustomVariableDto,
  CreateQuickReplyTemplateDto,
  UpdateQuickReplyCustomVariableDto,
  UpdateQuickReplyTemplateDto,
} from 'src/dto/chat/omnichannel-inbox.dto';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { PosOrderEntity } from 'src/entity/pos-order.entity';
import {
  QuickReplyCustomVariableEntity,
  QuickReplyVariableSourceType,
} from 'src/entity/quick-reply-custom-variable.entity';
import {
  QuickReplyAttachmentItem,
  QuickReplyInteractionType,
  QuickReplyMediaType,
  QuickReplySequenceStep,
  QuickReplyTemplateEntity,
  QuickReplyToneStyle,
} from 'src/entity/quick-reply-template.entity';
import { ShopWorkspaceEntity } from 'src/entity/shop-workspace.entity';
import { Repository } from 'typeorm';

export interface InterpolatedQuickReplyStep {
  order: number;
  content: string;
  delayMs: number;
  attachments: QuickReplyAttachmentItem[];
}

export interface QuickReplyVariableCatalogItem {
  id: string | null;
  key: string;
  label: string;
  description: string | null;
  sample: string;
  defaultValue: string | null;
  sourceType: 'SYSTEM' | QuickReplyVariableSourceType;
  dynamicPath: string | null;
  isSystem: boolean;
}

const SYSTEM_QUICK_REPLY_VARIABLES: QuickReplyVariableCatalogItem[] = [
  {
    id: null,
    key: 'customer_name',
    label: 'Tên khách hàng',
    description: 'Tự động lấy tên hiển thị từ cuộc hội thoại hoặc hồ sơ CRM',
    sample: 'Nguyễn Lan Anh',
    defaultValue: 'anh/chị',
    sourceType: 'SYSTEM',
    dynamicPath: 'customer.fullName',
    isSystem: true,
  },
  {
    id: null,
    key: 'salutation',
    label: 'Danh xưng (anh/chị)',
    description: 'Danh xưng lịch sự theo ngữ cảnh hội thoại',
    sample: 'chị',
    defaultValue: 'anh/chị',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'agent_name',
    label: 'Tên tư vấn viên',
    description: 'Tên nhân sự đang thao tác gửi tin nhắn',
    sample: 'Minh Thư',
    defaultValue: 'Tư vấn viên',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'shop_name',
    label: 'Tên cửa hàng',
    description: 'Tên Shop Workspace hiện tại',
    sample: 'Shop Thời Trang',
    defaultValue: 'Cửa hàng',
    sourceType: 'SYSTEM',
    dynamicPath: 'shop.name',
    isSystem: true,
  },
  {
    id: null,
    key: 'page_name',
    label: 'Tên Fanpage / Kênh',
    description: 'Tên Fanpage, Zalo OA hoặc gian hàng khách đang nhắn',
    sample: 'Fanpage Chính',
    defaultValue: 'Fanpage',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'order_code',
    label: 'Mã đơn hàng gần nhất',
    description: 'Mã đơn POS mới nhất của hội thoại hiện tại',
    sample: 'ORD-20261120-001',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: 'order.orderCode',
    isSystem: true,
  },
  {
    id: null,
    key: 'cod_amount',
    label: 'Tiền thu hộ COD',
    description: 'Số tiền COD cần thu của đơn hàng gần nhất',
    sample: '350.000đ',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: 'order.codCollectAmount',
    isSystem: true,
  },
  {
    id: null,
    key: 'tracking_number',
    label: 'Mã vận đơn 3PL',
    description: 'Mã vận đơn của đơn vị vận chuyển',
    sample: 'GHN88991122',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: 'order.trackingNumber',
    isSystem: true,
  },
  {
    id: null,
    key: 'tracking_link',
    label: 'Link tra cứu vận đơn',
    description: 'Đường dẫn theo dõi hành trình giao hàng trực tiếp',
    sample: 'https://donhang.ghn.vn/?order_code=GHN88991122',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'carrier_name',
    label: 'Hãng vận chuyển',
    description: 'Tên/mã hãng vận chuyển (GHN, GHTK, VTP, J&T...)',
    sample: 'GHN',
    defaultValue: 'ĐVVC',
    sourceType: 'SYSTEM',
    dynamicPath: 'order.carrierCode',
    isSystem: true,
  },
  {
    id: null,
    key: 'bank_name',
    label: 'Ngân hàng VietQR',
    description: 'Tên ngân hàng nhận chuyển khoản cấu hình trong Shop',
    sample: 'MB Bank',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'bank_account_no',
    label: 'Số tài khoản VietQR',
    description: 'Số tài khoản thụ hưởng VietQR của Shop',
    sample: '0988123456',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'bank_account_holder',
    label: 'Chủ tài khoản VietQR',
    description: 'Tên chủ tài khoản thụ hưởng VietQR',
    sample: 'NGUYEN VAN A',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
  {
    id: null,
    key: 'current_date',
    label: 'Ngày hiện tại (dd/MM/yyyy)',
    description: 'Ngày tháng năm hiện tại theo hệ thống',
    sample: '20/11/2026',
    defaultValue: '',
    sourceType: 'SYSTEM',
    dynamicPath: null,
    isSystem: true,
  },
];

const SYSTEM_VARIABLE_KEYS = new Set(SYSTEM_QUICK_REPLY_VARIABLES.map((v) => v.key));

/**
 * Whitelist các đường dẫn động an toàn cho phép người bán trỏ tới khi tạo biến `DYNAMIC_EXPRESSION`
 * nhằm chống truy cập trái phép vào các trường nhạy cảm (`phoneEncrypted`, `costPrice`, token...).
 */
export const ALLOWED_DYNAMIC_VARIABLE_PATHS: Array<{
  path: string;
  label: string;
  sample: string;
}> = [
  { path: 'customer.tier', label: 'Hạng thành viên khách hàng (VIP/GOLD...)', sample: 'VIP' },
  {
    path: 'customer.loyaltyPointsBalance',
    label: 'Số điểm thưởng hiện có của khách',
    sample: '250 điểm',
  },
  {
    path: 'customer.walletCreditBalance',
    label: 'Số dư ví tiền thừa của khách',
    sample: '50.000đ',
  },
  { path: 'customer.preferredSize', label: 'Size thường mặc của khách', sample: 'Size M' },
  { path: 'customer.totalOrdersCount', label: 'Tổng số đơn khách đã mua', sample: '5' },
  {
    path: 'order.totalPayableAmount',
    label: 'Tổng tiền thanh toán đơn gần nhất',
    sample: '450.000đ',
  },
  {
    path: 'order.paidTransferAmount',
    label: 'Số tiền khách đã chuyển khoản cọc',
    sample: '100.000đ',
  },
  { path: 'order.status', label: 'Trạng thái đơn hàng gần nhất', sample: 'CONFIRMED' },
  {
    path: 'conversation.interactionType',
    label: 'Loại hội thoại (INBOX/COMMENT/LIVE)',
    sample: 'INBOX',
  },
  {
    path: 'conversation.sourcePostId',
    label: 'Mã bài viết nguồn khách bình luận',
    sample: 'POST_9981',
  },
  { path: 'shop.code', label: 'Mã định danh cửa hàng', sample: 'SHOP-HN01' },
];

@Injectable()
export class QuickReplyService {
  constructor(
    @InjectRepository(QuickReplyTemplateEntity)
    private readonly quickReplyRepo: Repository<QuickReplyTemplateEntity>,
    @InjectRepository(QuickReplyCustomVariableEntity)
    private readonly customVariableRepo: Repository<QuickReplyCustomVariableEntity>,
    @InjectRepository(ShopWorkspaceEntity)
    private readonly shopRepo: Repository<ShopWorkspaceEntity>,
    @InjectRepository(PosOrderEntity)
    private readonly orderRepo: Repository<PosOrderEntity>,
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
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

  private normalizeVariableKey(raw: string): string {
    return raw
      .trim()
      .toLowerCase()
      .replace(/^\{\{|\}\}$/g, '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60);
  }

  private normalizeAttachments(
    items?: QuickReplyAttachmentItem[] | null,
  ): QuickReplyAttachmentItem[] {
    if (!Array.isArray(items)) return [];
    return items
      .filter((item) => item && typeof item.url === 'string' && item.url.trim().length > 0)
      .map((item) => {
        const mime = (item.mimeType || '').toLowerCase();
        const urlLower = item.url.toLowerCase();
        let inferredType: QuickReplyMediaType = item.mediaType || 'FILE';
        if (!item.mediaType) {
          if (mime.startsWith('video/') || /\.(mp4|mov|webm|m4v|avi|mkv)(\?|$)/i.test(urlLower)) {
            inferredType = 'VIDEO';
          } else if (
            mime.startsWith('image/') ||
            /\.(png|jpe?g|gif|webp|avif|svg)(\?|$)/i.test(urlLower)
          ) {
            inferredType = 'IMAGE';
          }
        }
        return {
          fileId: item.fileId,
          url: item.url.trim(),
          fileName: item.fileName?.trim() || 'media-attachment',
          mimeType: item.mimeType || (inferredType === 'VIDEO' ? 'video/mp4' : 'image/webp'),
          mediaType: inferredType,
          thumbnailUrl: item.thumbnailUrl ?? null,
          durationSeconds: item.durationSeconds ?? null,
          sizeBytes: item.sizeBytes ?? null,
          caption: item.caption ?? null,
        };
      });
  }

  public getAvailableVariablesCatalog() {
    return SYSTEM_QUICK_REPLY_VARIABLES;
  }

  public async listVariablesCatalog(shopId: string): Promise<{
    systemVariables: QuickReplyVariableCatalogItem[];
    customVariables: QuickReplyVariableCatalogItem[];
    allVariables: QuickReplyVariableCatalogItem[];
    allowedDynamicPaths: typeof ALLOWED_DYNAMIC_VARIABLE_PATHS;
  }> {
    const customRows = await this.customVariableRepo.find({
      where: { shopId, isActive: true },
      order: { sortOrder: 'ASC', createdAt: 'ASC' },
    });

    const customVariables: QuickReplyVariableCatalogItem[] = customRows.map((row) => ({
      id: row.id,
      key: row.variableKey,
      label: row.label,
      description: row.description,
      sample: row.sampleValue || row.defaultValue || `{{${row.variableKey}}}`,
      defaultValue: row.defaultValue,
      sourceType: row.sourceType,
      dynamicPath: row.dynamicPath,
      isSystem: false,
    }));

    return {
      systemVariables: SYSTEM_QUICK_REPLY_VARIABLES,
      customVariables,
      allVariables: [...SYSTEM_QUICK_REPLY_VARIABLES, ...customVariables],
      allowedDynamicPaths: ALLOWED_DYNAMIC_VARIABLE_PATHS,
    };
  }

  public async createCustomVariable(
    shopId: string,
    dto: CreateQuickReplyCustomVariableDto,
  ): Promise<QuickReplyCustomVariableEntity> {
    const variableKey = this.normalizeVariableKey(dto.variableKey);
    if (!variableKey) {
      throw new BadRequestException('INVALID_QUICK_REPLY_VARIABLE_KEY');
    }
    if (SYSTEM_VARIABLE_KEYS.has(variableKey)) {
      throw new BadRequestException('CANNOT_OVERRIDE_SYSTEM_QUICK_REPLY_VARIABLE');
    }

    if (
      dto.sourceType === 'DYNAMIC_EXPRESSION' &&
      dto.dynamicPath &&
      !ALLOWED_DYNAMIC_VARIABLE_PATHS.some((p) => p.path === dto.dynamicPath)
    ) {
      throw new BadRequestException('UNSUPPORTED_DYNAMIC_VARIABLE_PATH');
    }

    const existing = await this.customVariableRepo.findOne({
      where: { shopId, variableKey },
      withDeleted: true,
    });

    if (existing && existing.isActive && !existing.deletedAt) {
      throw new BadRequestException('QUICK_REPLY_VARIABLE_ALREADY_EXISTS');
    }

    if (existing) {
      if (existing.deletedAt) {
        await this.customVariableRepo.restore(existing.id);
      }
      existing.deletedAt = null;
      existing.deletedBy = null;
      existing.isActive = true;
      existing.label = dto.label.trim();
      existing.description = dto.description?.trim() || null;
      existing.sourceType = dto.sourceType || 'STATIC_TEXT';
      existing.defaultValue = dto.defaultValue ?? null;
      existing.sampleValue = dto.sampleValue?.trim() || dto.defaultValue || null;
      existing.dynamicPath =
        existing.sourceType === 'DYNAMIC_EXPRESSION' ? dto.dynamicPath || null : null;
      existing.sortOrder = dto.sortOrder ?? existing.sortOrder ?? 100;
      return this.customVariableRepo.save(existing);
    }

    const entity = this.customVariableRepo.create({
      shopId,
      variableKey,
      label: dto.label.trim(),
      description: dto.description?.trim() || null,
      sourceType: dto.sourceType || 'STATIC_TEXT',
      defaultValue: dto.defaultValue ?? null,
      sampleValue: dto.sampleValue?.trim() || dto.defaultValue || null,
      dynamicPath:
        (dto.sourceType || 'STATIC_TEXT') === 'DYNAMIC_EXPRESSION' ? dto.dynamicPath || null : null,
      sortOrder: dto.sortOrder ?? 100,
      isActive: true,
    });

    return this.customVariableRepo.save(entity);
  }

  public async updateCustomVariable(
    shopId: string,
    variableId: string,
    dto: UpdateQuickReplyCustomVariableDto,
  ): Promise<QuickReplyCustomVariableEntity> {
    const variable = await this.customVariableRepo.findOne({
      where: { id: variableId, shopId },
    });
    if (!variable) {
      throw new NotFoundException('QUICK_REPLY_VARIABLE_NOT_FOUND');
    }

    if (dto.variableKey !== undefined) {
      const nextKey = this.normalizeVariableKey(dto.variableKey);
      if (!nextKey) {
        throw new BadRequestException('INVALID_QUICK_REPLY_VARIABLE_KEY');
      }
      if (SYSTEM_VARIABLE_KEYS.has(nextKey)) {
        throw new BadRequestException('CANNOT_OVERRIDE_SYSTEM_QUICK_REPLY_VARIABLE');
      }
      if (nextKey !== variable.variableKey) {
        const collision = await this.customVariableRepo.findOne({
          where: { shopId, variableKey: nextKey },
          withDeleted: true,
        });
        if (collision && collision.id !== variable.id) {
          if (collision.isActive && !collision.deletedAt) {
            throw new BadRequestException('QUICK_REPLY_VARIABLE_ALREADY_EXISTS');
          }
          await this.customVariableRepo.delete(collision.id);
        }
        variable.variableKey = nextKey;
      }
    }

    const nextSourceType = dto.sourceType ?? variable.sourceType;
    if (
      nextSourceType === 'DYNAMIC_EXPRESSION' &&
      dto.dynamicPath &&
      !ALLOWED_DYNAMIC_VARIABLE_PATHS.some((p) => p.path === dto.dynamicPath)
    ) {
      throw new BadRequestException('UNSUPPORTED_DYNAMIC_VARIABLE_PATH');
    }

    if (dto.label !== undefined) variable.label = dto.label.trim();
    if (dto.description !== undefined) variable.description = dto.description?.trim() || null;
    if (dto.sourceType !== undefined) variable.sourceType = dto.sourceType;
    if (dto.defaultValue !== undefined) variable.defaultValue = dto.defaultValue;
    if (dto.sampleValue !== undefined) variable.sampleValue = dto.sampleValue?.trim() || null;
    if (dto.dynamicPath !== undefined) {
      variable.dynamicPath = nextSourceType === 'DYNAMIC_EXPRESSION' ? dto.dynamicPath : null;
    }
    if (dto.sortOrder !== undefined) variable.sortOrder = dto.sortOrder;
    if (dto.isActive !== undefined) variable.isActive = dto.isActive;

    return this.customVariableRepo.save(variable);
  }

  public async deleteCustomVariable(
    shopId: string,
    variableId: string,
  ): Promise<{ id: string; deleted: boolean }> {
    const variable = await this.customVariableRepo.findOne({
      where: { id: variableId, shopId },
    });
    if (!variable) {
      throw new NotFoundException('QUICK_REPLY_VARIABLE_NOT_FOUND');
    }

    variable.isActive = false;
    await this.customVariableRepo.save(variable);
    return { id: variableId, deleted: true };
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
        usageContextJson: {
          interactionTypes: ['INBOX', 'COMMENT'],
          toneStyle: 'FRIENDLY',
          contextTags: ['chao-khach', 'tu-van-size'],
        },
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
        usageContextJson: {
          interactionTypes: ['INBOX', 'LIVESTREAM'],
          toneStyle: 'URGENT',
          contextTags: ['chot-don', 'giu-hang'],
        },
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
        usageContextJson: {
          interactionTypes: ['INBOX'],
          toneStyle: 'PROFESSIONAL',
          contextTags: ['thanh-toan', 'vietqr'],
        },
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
        usageContextJson: {
          interactionTypes: ['INBOX', 'MARKETPLACE'],
          toneStyle: 'PROFESSIONAL',
          contextTags: ['van-don', 'tra-cuu'],
        },
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
        usageContextJson: {
          interactionTypes: ['INBOX'],
          toneStyle: 'VIP_CARE',
          contextTags: ['cuu-don', 'giao-lai'],
        },
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
    options?: {
      category?: string;
      channelId?: string;
      channelType?: string;
      interactionType?: QuickReplyInteractionType;
      toneStyle?: QuickReplyToneStyle;
      activeTagIds?: string[];
      actorUserId?: string;
    },
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

    const filtered = rows.filter((tpl) => {
      if (tpl.scope === 'PERSONAL' && options?.actorUserId && tpl.ownerUserId) {
        if (tpl.ownerUserId !== options.actorUserId) return false;
      }

      if (
        tpl.scope === 'CHANNEL' &&
        options?.channelId &&
        Array.isArray(tpl.allowedChannelIdsJson) &&
        tpl.allowedChannelIdsJson.length > 0
      ) {
        if (!tpl.allowedChannelIdsJson.includes(options.channelId)) return false;
      }

      const ctx = tpl.usageContextJson;
      if (ctx) {
        if (
          options?.interactionType &&
          Array.isArray(ctx.interactionTypes) &&
          ctx.interactionTypes.length > 0 &&
          !ctx.interactionTypes.includes(options.interactionType)
        ) {
          return false;
        }
        if (
          options?.channelType &&
          Array.isArray(ctx.channelTypes) &&
          ctx.channelTypes.length > 0 &&
          !ctx.channelTypes.includes(options.channelType)
        ) {
          return false;
        }
        if (options?.toneStyle && ctx.toneStyle && ctx.toneStyle !== options.toneStyle) {
          return false;
        }
      }

      return true;
    });

    // Ưu tiên đẩy lên đầu các mẫu câu khớp Tag ngữ cảnh của hội thoại hiện tại
    if (options?.activeTagIds && options.activeTagIds.length > 0) {
      const activeSet = new Set(options.activeTagIds);
      return filtered.sort((a, b) => {
        const scoreA = (a.usageContextJson?.applicableTagIds || []).filter((id) =>
          activeSet.has(id),
        ).length;
        const scoreB = (b.usageContextJson?.applicableTagIds || []).filter((id) =>
          activeSet.has(id),
        ).length;
        if (scoreB !== scoreA) return scoreB - scoreA;
        return Number(Boolean(b.isPinned)) - Number(Boolean(a.isPinned));
      });
    }

    return filtered;
  }

  async createTemplate(
    shopId: string,
    dto: CreateQuickReplyTemplateDto & { ownerUserId?: string },
  ): Promise<QuickReplyTemplateEntity> {
    const shortcut = this.normalizeShortcut(dto.shortcut);
    if (!shortcut) {
      throw new BadRequestException('INVALID_QUICK_REPLY_SHORTCUT');
    }

    const normalizedAttachments = this.normalizeAttachments(dto.attachmentsJson);
    const normalizedSequence = Array.isArray(dto.messageSequenceJson)
      ? dto.messageSequenceJson.map((step, idx) => ({
          order: idx + 1,
          contentTemplate: (step.contentTemplate || '').trim(),
          delayMs: Math.max(0, Math.min(10000, Number(step.delayMs || 0))),
          attachments: this.normalizeAttachments(step.attachments),
        }))
      : null;

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
      existing.usageContextJson = dto.usageContextJson || null;
      existing.contentTemplate = dto.contentTemplate.trim();
      existing.messageSequenceJson = normalizedSequence;
      existing.attachmentsJson = normalizedAttachments;
      existing.productCardsJson = dto.productCardsJson || [];
      existing.autoAssignTagIdsJson = dto.autoAssignTagIdsJson || null;
      existing.customVariableDefaultsJson = dto.customVariableDefaultsJson || null;
      existing.isPinned = Boolean(dto.isPinned);
      existing.sortOrder = dto.sortOrder ?? existing.sortOrder ?? 0;
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
      usageContextJson: dto.usageContextJson || null,
      contentTemplate: dto.contentTemplate.trim(),
      messageSequenceJson: normalizedSequence,
      attachmentsJson: normalizedAttachments,
      productCardsJson: dto.productCardsJson || [],
      autoAssignTagIdsJson: dto.autoAssignTagIdsJson || null,
      customVariableDefaultsJson: dto.customVariableDefaultsJson || null,
      isPinned: Boolean(dto.isPinned),
      sortOrder: dto.sortOrder ?? 0,
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
    if (dto.scope !== undefined) template.scope = dto.scope;
    if (dto.allowedChannelIdsJson !== undefined) {
      template.allowedChannelIdsJson = dto.allowedChannelIdsJson;
    }
    if (dto.usageContextJson !== undefined) {
      template.usageContextJson = dto.usageContextJson;
    }
    if (dto.contentTemplate !== undefined) {
      template.contentTemplate = dto.contentTemplate.trim();
    }
    if (dto.messageSequenceJson !== undefined) {
      template.messageSequenceJson = Array.isArray(dto.messageSequenceJson)
        ? dto.messageSequenceJson.map((step, idx) => ({
            order: idx + 1,
            contentTemplate: (step.contentTemplate || '').trim(),
            delayMs: Math.max(0, Math.min(10000, Number(step.delayMs || 0))),
            attachments: this.normalizeAttachments(step.attachments),
          }))
        : null;
    }
    if (dto.attachmentsJson !== undefined) {
      template.attachmentsJson = this.normalizeAttachments(dto.attachmentsJson);
    }
    if (dto.productCardsJson !== undefined) template.productCardsJson = dto.productCardsJson;
    if (dto.autoAssignTagIdsJson !== undefined) {
      template.autoAssignTagIdsJson = dto.autoAssignTagIdsJson;
    }
    if (dto.customVariableDefaultsJson !== undefined) {
      template.customVariableDefaultsJson = dto.customVariableDefaultsJson;
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

  private resolveSafeDynamicPath(
    path: string | null | undefined,
    context: {
      customer: CustomerProfileEntity | null;
      order: PosOrderEntity | null;
      conversation: ConversationEntity | null;
      shop: ShopWorkspaceEntity | null;
    },
  ): string | null {
    if (!path) return null;
    switch (path) {
      case 'customer.tier':
        return context.customer?.tier || null;
      case 'customer.loyaltyPointsBalance':
        return context.customer
          ? `${Number(context.customer.loyaltyPointsBalance || 0).toLocaleString('vi-VN')} điểm`
          : null;
      case 'customer.walletCreditBalance':
        return context.customer
          ? `${Number(context.customer.walletCreditBalance || 0).toLocaleString('vi-VN')}đ`
          : null;
      case 'customer.preferredSize':
        return context.customer?.preferredSize || null;
      case 'customer.totalOrdersCount':
        return context.customer ? String(context.customer.totalOrdersCount || 0) : null;
      case 'order.totalPayableAmount':
        return context.order
          ? `${Number(context.order.totalPayableAmount || 0).toLocaleString('vi-VN')}đ`
          : null;
      case 'order.paidTransferAmount':
        return context.order
          ? `${Number(context.order.paidTransferAmount || 0).toLocaleString('vi-VN')}đ`
          : null;
      case 'order.status':
        return context.order?.status || null;
      case 'conversation.interactionType':
        return context.conversation?.interactionType || null;
      case 'conversation.sourcePostId':
        return context.conversation?.sourcePostId || null;
      case 'shop.code':
        return context.shop?.code || null;
      default:
        return null;
    }
  }

  private replaceTemplateVariables(raw: string, vars: Record<string, string>): string {
    return raw.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}|\{([a-zA-Z0-9_]+)\}/g, (_match, k1, k2) => {
      const key = String(k1 || k2).toLowerCase();
      return vars[key] !== undefined ? vars[key] : _match;
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
    customOverrides?: Record<string, string>;
  }): Promise<{
    interpolatedContent: string;
    interpolatedSequence: InterpolatedQuickReplyStep[];
    attachments: QuickReplyAttachmentItem[];
    autoAssignTagIds: string[];
    resolvedVariables: Record<string, string>;
    template: QuickReplyTemplateEntity;
  }> {
    const [template, shop, customVariables, conversation, latestOrder] = await Promise.all([
      this.quickReplyRepo.findOne({ where: { id: params.templateId, shopId: params.shopId } }),
      this.shopRepo.findOne({ where: { id: params.shopId } }),
      this.customVariableRepo.find({
        where: { shopId: params.shopId, isActive: true },
      }),
      params.conversationId
        ? this.conversationRepo.findOne({
            where: { id: params.conversationId, shopId: params.shopId },
          })
        : Promise.resolve(null),
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

    const customer = conversation?.customerId
      ? await this.customerRepo.findOne({
          where: { id: conversation.customerId, shopId: params.shopId },
        })
      : null;

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
      customer_name: params.customerName || customer?.fullName || conversation?.name || 'anh/chị',
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

    // Nạp các biến tùy chỉnh cấp Shop theo thứ tự ưu tiên: Dynamic -> Shop Default -> Template Default -> Runtime Override
    for (const customVar of customVariables) {
      let resolvedValue = customVar.defaultValue ?? '';
      if (customVar.sourceType === 'DYNAMIC_EXPRESSION') {
        const dynamicVal = this.resolveSafeDynamicPath(customVar.dynamicPath, {
          customer,
          order: latestOrder,
          conversation,
          shop,
        });
        if (dynamicVal !== null && dynamicVal !== '') {
          resolvedValue = dynamicVal;
        }
      }
      vars[customVar.variableKey] = resolvedValue;
    }

    if (
      template.customVariableDefaultsJson &&
      typeof template.customVariableDefaultsJson === 'object'
    ) {
      for (const [k, v] of Object.entries(template.customVariableDefaultsJson)) {
        const normalizedKey = this.normalizeVariableKey(k);
        if (normalizedKey && typeof v === 'string') {
          vars[normalizedKey] = v;
        }
      }
    }

    if (params.customOverrides && typeof params.customOverrides === 'object') {
      for (const [k, v] of Object.entries(params.customOverrides)) {
        const normalizedKey = this.normalizeVariableKey(k);
        if (normalizedKey && typeof v === 'string') {
          vars[normalizedKey] = v;
        }
      }
    }

    const interpolatedContent = this.replaceTemplateVariables(template.contentTemplate, vars);
    const normalizedAttachments = this.normalizeAttachments(template.attachmentsJson);

    const rawSteps: QuickReplySequenceStep[] =
      Array.isArray(template.messageSequenceJson) && template.messageSequenceJson.length > 0
        ? template.messageSequenceJson
        : [
            {
              order: 1,
              contentTemplate: template.contentTemplate,
              delayMs: 0,
              attachments: normalizedAttachments,
            },
          ];

    const interpolatedSequence: InterpolatedQuickReplyStep[] = rawSteps
      .slice()
      .sort((a, b) => Number(a.order || 0) - Number(b.order || 0))
      .map((step, idx) => ({
        order: idx + 1,
        content: this.replaceTemplateVariables(step.contentTemplate || '', vars),
        delayMs: Math.max(0, Math.min(10000, Number(step.delayMs || 0))),
        attachments: this.normalizeAttachments(step.attachments),
      }));

    return {
      interpolatedContent,
      interpolatedSequence,
      attachments: normalizedAttachments,
      autoAssignTagIds: Array.isArray(template.autoAssignTagIdsJson)
        ? template.autoAssignTagIdsJson
        : [],
      resolvedVariables: vars,
      template,
    };
  }
}
