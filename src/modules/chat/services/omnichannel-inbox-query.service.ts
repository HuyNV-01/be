import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import { ConversationSupportStatusEnum } from 'src/common/enum/permission.enum';
import { OmnichannelInboxFilterDto } from 'src/dto/chat/omnichannel-inbox.dto';
import { ChannelIntegrationEntity } from 'src/entity/channel-integration.entity';
import { ConversationEntity } from 'src/entity/conversation.entity';
import { DataScopeQueryHelper } from 'src/modules/iam/helpers/data-scope-query.helper';
import { EffectiveMemberContext } from 'src/modules/iam/iam.service';
import { In, Repository } from 'typeorm';

import { MessageCryptoService } from './message-crypto.service';

export interface OmnichannelInboxFilterSummaryCounts {
  totalAll: number;
  unrepliedCount: number;
  ghostedCount: number;
  slaBreachedCount: number;
  window24hExpiringCount: number;
  snoozedCount: number;
  hasPhoneCount: number;
  unconfirmedOrderCount: number;
}

export type OmnichannelMergedConversationItem = ConversationEntity & {
  pageShortCode?: string;
  pageName?: string;
  channelAvatarUrl?: string | null;
  unreadCount?: number;
};

@Injectable()
export class OmnichannelInboxQueryService {
  constructor(
    @InjectRepository(ConversationEntity)
    private readonly conversationRepo: Repository<ConversationEntity>,
    @InjectRepository(ChannelIntegrationEntity)
    private readonly channelRepo: Repository<ChannelIntegrationEntity>,
    private readonly messageCryptoService: MessageCryptoService,
  ) {}

  /**
   * F03.1 & F03.2: Truy vấn hộp thư bán hàng hợp nhất 18 tiêu chí kết hợp toán tử Tag AND / OR / NOT
   */
  async queryMergedConversations(
    filter: OmnichannelInboxFilterDto,
    memberCtx: EffectiveMemberContext,
  ): Promise<{
    items: OmnichannelMergedConversationItem[];
    nextCursor: string | null;
    summaryCounts: OmnichannelInboxFilterSummaryCounts;
  }> {
    const qb = this.conversationRepo.createQueryBuilder('conv');

    // Áp dụng Data Scope 4 chiều (4D IAM: ALL_SHOP, TEAM_SHIFT, ASSIGNED_PLUS_POOL, ASSIGNED_ONLY)
    DataScopeQueryHelper.applyAgentDataScope(qb, 'conv', memberCtx);

    const allowedChannels =
      memberCtx.allowedChannelIds.length > 0 ? memberCtx.allowedChannelIds : undefined;
    const requestedChannels =
      filter.channelIds && filter.channelIds.length > 0
        ? filter.channelIds.filter((id) => !allowedChannels || allowedChannels.includes(id))
        : allowedChannels;

    if (filter.channelIds && filter.channelIds.length > 0) {
      if (requestedChannels && requestedChannels.length > 0) {
        qb.andWhere('conv.channel_integration_id IN (:...channelIds)', {
          channelIds: requestedChannels,
        });
      } else {
        qb.andWhere('1 = 0');
      }
    }

    // 18 Tiêu chí lọc chuyên sâu
    if (filter.unreadOnly) {
      qb.andWhere('conv.first_seen_at IS NULL');
    }
    if (filter.unrepliedOnly) {
      qb.andWhere('conv.support_status = :waitingStatus', {
        waitingStatus: ConversationSupportStatusEnum.WAITING_AGENT_REPLY,
      });
    }
    if (filter.ghostedByAgentOnly) {
      qb.andWhere('conv.is_ghosted_by_agent = true');
    }
    if (filter.slaBreachedOnly) {
      qb.andWhere('conv.is_sla_breached = true');
    }
    if (filter.window24hExpiringOnly) {
      qb.andWhere(
        'conv.last_customer_message_at BETWEEN DATE_SUB(NOW(), INTERVAL 24 HOUR) AND DATE_SUB(NOW(), INTERVAL 22 HOUR)',
      );
    }
    if (filter.snoozedOnly) {
      qb.andWhere('conv.support_status = :snoozedStatus', {
        snoozedStatus: ConversationSupportStatusEnum.SNOOZED,
      });
    }
    if (filter.hasPhone) {
      qb.andWhere('conv.has_phone_collected = true');
    }
    if (filter.noPhone) {
      qb.andWhere('conv.has_phone_collected = false');
    }
    if (filter.hasOrder) {
      qb.andWhere('conv.has_order_created = true');
    }
    if (filter.noOrder) {
      qb.andWhere('conv.has_order_created = false');
    }
    if (filter.interactionType) {
      qb.andWhere('conv.interaction_type = :interactionType', {
        interactionType: filter.interactionType,
      });
    }
    if (filter.sourcePostId) {
      qb.andWhere('conv.source_post_id = :sourcePostId', {
        sourcePostId: filter.sourcePostId,
      });
    }
    if (filter.sourceAdId) {
      qb.andWhere('conv.source_ad_id = :sourceAdId', {
        sourceAdId: filter.sourceAdId,
      });
    }
    if (filter.assignedAgentId) {
      qb.andWhere('conv.assigned_agent_id = :assignedAgentId', {
        assignedAgentId: filter.assignedAgentId,
      });
    }

    // Toán tử tập hợp Tag AND / OR / NOT
    if (filter.includeTagIds && filter.includeTagIds.length > 0) {
      if (filter.includeTagOperator === 'AND') {
        qb.andWhere(
          'JSON_CONTAINS(COALESCE(conv.active_tag_ids_json, JSON_ARRAY()), :includeTagsJson)',
          { includeTagsJson: JSON.stringify(filter.includeTagIds) },
        );
      } else {
        qb.andWhere(
          'JSON_OVERLAPS(COALESCE(conv.active_tag_ids_json, JSON_ARRAY()), :includeTagsJson)',
          { includeTagsJson: JSON.stringify(filter.includeTagIds) },
        );
      }
    }

    if (filter.excludeTagIds && filter.excludeTagIds.length > 0) {
      qb.andWhere(
        'NOT JSON_OVERLAPS(COALESCE(conv.active_tag_ids_json, JSON_ARRAY()), :excludeTagsJson)',
        { excludeTagsJson: JSON.stringify(filter.excludeTagIds) },
      );
    }

    if (filter.searchKeyword?.trim()) {
      const kw = `%${filter.searchKeyword.trim()}%`;
      qb.andWhere(
        '(conv.name LIKE :kw OR conv.external_thread_id LIKE :kw OR conv.source_ad_id LIKE :kw OR conv.source_post_id LIKE :kw)',
        { kw },
      );
    }

    if (filter.cursorLastMessageAt) {
      qb.andWhere('conv.lastMessageAt < :cursorDate', {
        cursorDate: new Date(filter.cursorLastMessageAt),
      });
    }

    const takeLimit = Math.min(Math.max(filter.limit || 30, 5), 100);
    const [rawItems, summaryCounts] = await Promise.all([
      qb.orderBy('conv.lastMessageAt', 'DESC').take(takeLimit).getMany(),
      this.computeSummaryCounts(memberCtx, requestedChannels),
    ]);

    const channelIds = Array.from(
      new Set(
        rawItems.map((item) => item.channelIntegrationId).filter((id): id is string => Boolean(id)),
      ),
    );

    const channels =
      channelIds.length > 0 ? await this.channelRepo.find({ where: { id: In(channelIds) } }) : [];
    const channelMap = new Map(channels.map((ch) => [ch.id, ch]));

    const items: OmnichannelMergedConversationItem[] = rawItems.map((conv) => {
      const ch = conv.channelIntegrationId ? channelMap.get(conv.channelIntegrationId) : undefined;
      return Object.assign(conv, {
        lastMessage: conv.lastMessage
          ? this.messageCryptoService.decryptForConversation(conv.lastMessage, conv.id)
          : '',
        pageShortCode: ch?.pageShortCode || conv.channelType,
        pageName: ch?.pageName || conv.channelType,
        channelAvatarUrl: ch?.avatarUrl || null,
        unreadCount:
          conv.supportStatus === ConversationSupportStatusEnum.WAITING_AGENT_REPLY &&
          !conv.firstSeenAt
            ? 1
            : 0,
      });
    });

    const nextCursor =
      items.length === takeLimit && items[items.length - 1].lastMessageAt
        ? items[items.length - 1].lastMessageAt.toISOString()
        : null;

    return { items, nextCursor, summaryCounts };
  }

  private async computeSummaryCounts(
    memberCtx: EffectiveMemberContext,
    channelIds?: string[],
  ): Promise<OmnichannelInboxFilterSummaryCounts> {
    const baseQb = this.conversationRepo.createQueryBuilder('c');
    DataScopeQueryHelper.applyAgentDataScope(baseQb, 'c', memberCtx);

    if (channelIds && channelIds.length > 0) {
      baseQb.andWhere('c.channel_integration_id IN (:...channelIds)', { channelIds });
    }

    const rows = await baseQb
      .select([
        'COUNT(c.id) AS totalAll',
        `SUM(CASE WHEN c.support_status = 'WAITING_AGENT_REPLY' THEN 1 ELSE 0 END) AS unrepliedCount`,
        `SUM(CASE WHEN c.is_ghosted_by_agent = true THEN 1 ELSE 0 END) AS ghostedCount`,
        `SUM(CASE WHEN c.is_sla_breached = true THEN 1 ELSE 0 END) AS slaBreachedCount`,
        `SUM(CASE WHEN c.last_customer_message_at BETWEEN DATE_SUB(NOW(), INTERVAL 24 HOUR) AND DATE_SUB(NOW(), INTERVAL 22 HOUR) THEN 1 ELSE 0 END) AS window24hExpiringCount`,
        `SUM(CASE WHEN c.support_status = 'SNOOZED' THEN 1 ELSE 0 END) AS snoozedCount`,
        `SUM(CASE WHEN c.has_phone_collected = true THEN 1 ELSE 0 END) AS hasPhoneCount`,
        `SUM(CASE WHEN c.has_phone_collected = true AND c.has_order_created = false THEN 1 ELSE 0 END) AS unconfirmedOrderCount`,
      ])
      .getRawOne<Record<string, string | number>>();

    return {
      totalAll: Number(rows?.totalAll || 0),
      unrepliedCount: Number(rows?.unrepliedCount || 0),
      ghostedCount: Number(rows?.ghostedCount || 0),
      slaBreachedCount: Number(rows?.slaBreachedCount || 0),
      window24hExpiringCount: Number(rows?.window24hExpiringCount || 0),
      snoozedCount: Number(rows?.snoozedCount || 0),
      hasPhoneCount: Number(rows?.hasPhoneCount || 0),
      unconfirmedOrderCount: Number(rows?.unconfirmedOrderCount || 0),
    };
  }
}
