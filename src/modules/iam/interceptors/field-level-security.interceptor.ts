import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';

import { Observable, from } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { PermissionCodeEnum } from 'src/common/enum/permission.enum';

import { EffectiveMemberContext, GranularIamService } from '../iam.service';

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
  'customLookupApiKeyEncrypted',
  'tokenHash',
  'localPhone',
  'e164Phone',
]);

@Injectable()
export class FieldLevelSecurityInterceptor implements NestInterceptor {
  constructor(private readonly granularIamService: GranularIamService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest();

    return from(this.resolveMemberContextIfAvailable(request)).pipe(
      switchMap((memberCtx) => {
        const canViewCost = Boolean(
          memberCtx?.permissions.includes(PermissionCodeEnum.CATALOG_COST_PRICE_VIEW) ||
            memberCtx?.permissions.includes(PermissionCodeEnum.FINANCE_PNL_STATEMENT_VIEW),
        );

        return next
          .handle()
          .pipe(map((payload) => this.sanitizePayload(payload, canViewCost, new WeakSet())));
      }),
    );
  }

  private async resolveMemberContextIfAvailable(
    request: Record<string, any>,
  ): Promise<EffectiveMemberContext | undefined> {
    if (request?.shopMemberContext) {
      return request.shopMemberContext as EffectiveMemberContext;
    }

    const userId: string | undefined = request?.user?.id;
    const shopId: string | undefined =
      request?.params?.shopId ||
      request?.headers?.['x-shop-id'] ||
      request?.query?.shopId ||
      request?.body?.shopId ||
      request?.user?.lastActiveShopId;

    if (!userId || !shopId) {
      return undefined;
    }

    try {
      const ctx = await this.granularIamService.getEffectiveMemberContext(String(shopId), userId);
      request.shopMemberContext = ctx;
      return ctx;
    } catch {
      return undefined;
    }
  }

  private maskRawPhoneString(val: string): string {
    const digits = val.replace(/\D/g, '');
    if (digits.length >= 9 && !val.includes('*')) {
      const local =
        digits.startsWith('84') && digits.length === 11 ? `0${digits.slice(2)}` : digits;
      return `${local.slice(0, 3)}***${local.slice(-3)}`;
    }
    return val;
  }

  private sanitizePayload(data: unknown, canViewCost: boolean, visited: WeakSet<object>): unknown {
    if (data === null || data === undefined) return data;
    if (data instanceof Date || Buffer.isBuffer(data)) return data;

    if (Array.isArray(data)) {
      return data.map((item) => this.sanitizePayload(item, canViewCost, visited));
    }

    if (typeof data === 'object') {
      if (visited.has(data)) {
        return data;
      }
      visited.add(data);

      const sanitized: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
        if (RAW_PII_NEVER_SERIALIZE_KEYS.has(key)) {
          continue;
        }
        if (!canViewCost && COST_AND_PROFIT_SENSITIVE_KEYS.has(key)) {
          continue;
        }
        if (key === 'phones' && Array.isArray(value)) {
          sanitized[key] = value.map((v) =>
            typeof v === 'string' ? this.maskRawPhoneString(v) : v,
          );
          continue;
        }
        sanitized[key] = this.sanitizePayload(value, canViewCost, visited);
      }
      return sanitized;
    }

    return data;
  }
}
