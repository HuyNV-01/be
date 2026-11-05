import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';

import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';

import { EffectiveMemberContext } from '../iam.service';

const COST_AND_PROFIT_SENSITIVE_KEYS = new Set([
  'costPrice',
  'cogsSnapshotAmount',
  'estimatedNetProfitAmount',
  'landedUnitCost',
  'supplierUnitPrice',
  'realizedNetProfit',
]);

const RAW_PII_NEVER_SERIALIZE_KEYS = new Set([
  'phoneEncrypted',
  'phoneSearchHash',
  'accessTokenEncrypted',
  'refreshTokenEncrypted',
  'capiAccessTokenEncrypted',
  'webhookVerifySecretEncrypted',
  'tokenHash',
]);

@Injectable()
export class FieldLevelSecurityInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const memberCtx: EffectiveMemberContext | undefined = request.shopMemberContext;

    const canViewCost = Boolean(
      memberCtx?.permissions.includes(PermissionCodeEnum.CATALOG_COST_PRICE_VIEW) ||
        memberCtx?.permissions.includes(PermissionCodeEnum.FINANCE_PNL_STATEMENT_VIEW),
    );

    return next.handle().pipe(map((payload) => this.sanitizePayload(payload, canViewCost)));
  }

  private sanitizePayload(data: unknown, canViewCost: boolean): unknown {
    if (data === null || data === undefined) return data;
    if (data instanceof Date) return data;

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizePayload(item, canViewCost));
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (RAW_PII_NEVER_SERIALIZE_KEYS.has(key)) {
          continue;
        }
        if (!canViewCost && COST_AND_PROFIT_SENSITIVE_KEYS.has(key)) {
          continue;
        }
        sanitized[key] = this.sanitizePayload(value, canViewCost);
      }
      return sanitized;
    }

    return data;
  }
}
