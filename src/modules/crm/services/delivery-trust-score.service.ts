import { Injectable } from '@nestjs/common';

import { DeliveryTrustBandEnum } from 'src/common/enum';

export interface DeliveryTrustEvaluationResult {
  score: number;
  band: DeliveryTrustBandEnum;
  badgeVariant: 'success' | 'info' | 'warning' | 'danger';
  headline: string;
  recommendation: string;
  requireDepositVietQr: boolean;
  successRatePercent: number;
}

@Injectable()
export class DeliveryTrustScoreService {
  /**
   * Tính điểm Uy tín Nhận hàng (0 - 100 điểm) và phân loại 4 mức cảnh báo Bom hàng (F04.3):
   * TrustScore = clamp(0, 100, round((SuccessfulOrders + 1) / (SuccessfulOrders + ReturnedOrders * 2.5 + 1) * 100) - BlacklistPenalty)
   */
  public evaluateCustomerTrustScore(params: {
    successfulDeliveriesCount: number;
    returnedOrdersCount: number;
    isBlacklisted: boolean;
    shopRequireDepositOnHighRisk?: boolean;
  }): DeliveryTrustEvaluationResult {
    const successCount = Math.max(0, Number(params.successfulDeliveriesCount || 0));
    const returnCount = Math.max(0, Number(params.returnedOrdersCount || 0));
    const totalCompletedOrReturned = successCount + returnCount;
    const isBlacklisted = Boolean(params.isBlacklisted);
    const blacklistPenalty = isBlacklisted ? 60 : 0;

    const rawFormulaScore = Math.round(
      ((successCount + 1) / (successCount + returnCount * 2.5 + 1)) * 100,
    );
    const clampedScore = Math.max(0, Math.min(100, rawFormulaScore - blacklistPenalty));

    const successRatePercent =
      totalCompletedOrReturned > 0
        ? Math.round((successCount / totalCompletedOrReturned) * 100)
        : 100;

    if (isBlacklisted || clampedScore < 50 || returnCount >= 2) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.HIGH_RISK_RED,
        badgeVariant: 'danger',
        headline: isBlacklisted
          ? 'Cảnh báo Đỏ: Khách nằm trong Danh sách đen (Bom hàng)'
          : `Rủi ro Hoàn đơn Cao (${clampedScore}/100 điểm • Hoàn ${returnCount} đơn)`,
        recommendation:
          'Bắt buộc thu cọc trước qua VietQR hoặc gọi xác nhận kỹ trước khi đẩy đơn sang hãng vận chuyển.',
        requireDepositVietQr: params.shopRequireDepositOnHighRisk ?? true,
        successRatePercent,
      };
    }

    if (totalCompletedOrReturned === 0) {
      return {
        score: 80,
        band: DeliveryTrustBandEnum.NEW_NEUTRAL,
        badgeVariant: 'info',
        headline: 'Khách hàng mới (Chưa có lịch sử giao nhận)',
        recommendation: 'Khách lần đầu mua hàng — xác nhận rõ địa chỉ 3 cấp và SĐT trước khi gửi.',
        requireDepositVietQr: false,
        successRatePercent: 100,
      };
    }

    if (clampedScore >= 85 && returnCount === 0) {
      return {
        score: clampedScore,
        band: DeliveryTrustBandEnum.TRUSTED_GREEN,
        badgeVariant: 'success',
        headline: `Uy tín Cao (${clampedScore}/100 điểm • Nhận thành công ${successCount} đơn)`,
        recommendation: 'Khách hàng uy tín — ưu tiên duyệt đơn và đóng gói gửi nhanh.',
        requireDepositVietQr: false,
        successRatePercent,
      };
    }

    return {
      score: clampedScore,
      band: DeliveryTrustBandEnum.CAUTION_AMBER,
      badgeVariant: 'warning',
      headline: `Cần Lưu Ý (${clampedScore}/100 điểm • Tỷ lệ nhận ${successRatePercent}%)`,
      recommendation: 'Nên gọi xác nhận kỹ khung giờ nhận hàng và địa chỉ trước khi xuất kho.',
      requireDepositVietQr: false,
      successRatePercent,
    };
  }
}
