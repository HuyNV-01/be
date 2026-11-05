import { DataScopeEnum } from 'src/common/enum/permission.enum';
import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import { EffectiveMemberContext } from '../iam.service';

export class DataScopeQueryHelper {
  /**
   * Tự động tiêm điều kiện WHERE theo DataScopeEnum của nhân viên vào mọi truy vấn TypeORM
   * (Áp dụng cho bảng conversations, sales_orders, customer_profiles).
   */
  static applyAgentDataScope<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    memberCtx: EffectiveMemberContext,
    options: {
      shopIdColumn?: string;
      assignedAgentColumn?: string;
      channelColumn?: string;
    } = {},
  ): SelectQueryBuilder<T> {
    const shopCol = options.shopIdColumn || 'shop_id';
    const agentCol = options.assignedAgentColumn || 'assigned_agent_id';
    const channelCol = options.channelColumn || 'channel_integration_id';

    qb.andWhere(`${alias}.${shopCol} = :scopeShopId`, {
      scopeShopId: memberCtx.shopId,
    });

    if (memberCtx.allowedChannelIds && memberCtx.allowedChannelIds.length > 0) {
      qb.andWhere(
        `(${alias}.${channelCol} IS NULL OR ${alias}.${channelCol} IN (:...scopeChannelIds))`,
        { scopeChannelIds: memberCtx.allowedChannelIds },
      );
    }

    switch (memberCtx.dataScope) {
      case DataScopeEnum.ALL_SHOP:
      case DataScopeEnum.TEAM_SHIFT:
        return qb;

      case DataScopeEnum.ASSIGNED_PLUS_POOL:
        qb.andWhere(`(${alias}.${agentCol} = :scopeUserId OR ${alias}.${agentCol} IS NULL)`, {
          scopeUserId: memberCtx.userId,
        });
        return qb;

      case DataScopeEnum.ASSIGNED_ONLY:
      default:
        qb.andWhere(`${alias}.${agentCol} = :scopeUserId`, {
          scopeUserId: memberCtx.userId,
        });
        return qb;
    }
  }
}
