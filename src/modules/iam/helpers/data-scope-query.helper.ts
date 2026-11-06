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
        return qb;

      case DataScopeEnum.TEAM_SHIFT:
        if (memberCtx.teamCode) {
          qb.andWhere(
            `(
              ${alias}.${agentCol} IS NULL
              OR ${alias}.${agentCol} = :scopeUserId
              OR ${alias}.${agentCol} IN (
                SELECT sm_team.user_id
                FROM shop_members sm_team
                WHERE sm_team.shop_id = :scopeShopId
                  AND sm_team.team_code = :scopeTeamCode
                  AND sm_team.deleted_at IS NULL
              )
            )`,
            {
              scopeUserId: memberCtx.userId,
              scopeShopId: memberCtx.shopId,
              scopeTeamCode: memberCtx.teamCode,
            },
          );
        }
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

  /**
   * Tự động giới hạn truy vấn theo danh sách kho (allowedWarehouseIds) mà nhân viên được phân quyền.
   */
  static applyWarehouseDataScope<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    memberCtx: EffectiveMemberContext,
    warehouseColumn = 'warehouse_id',
  ): SelectQueryBuilder<T> {
    if (memberCtx.allowedWarehouseIds && memberCtx.allowedWarehouseIds.length > 0) {
      qb.andWhere(
        `(${alias}.${warehouseColumn} IS NULL OR ${alias}.${warehouseColumn} IN (:...scopeWarehouseIds))`,
        { scopeWarehouseIds: memberCtx.allowedWarehouseIds },
      );
    }
    return qb;
  }
}
