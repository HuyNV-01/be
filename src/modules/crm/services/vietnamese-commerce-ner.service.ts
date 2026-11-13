import { Injectable } from '@nestjs/common';

import { ExtractedCommerceEntitiesPayload } from 'src/entity/message.entity';

import {
  VN_ADMINISTRATIVE_UNITS_DICTIONARY,
  VnDistrictUnitItem,
  VnProvinceUnitItem,
  VnWardUnitItem,
} from '../dictionaries/vn-administrative-units.constant';

const VIETNAMESE_NUMBER_WORDS_MAP: Array<{ pattern: RegExp; digit: string }> = [
  { pattern: /\b(không|khong)\b/gi, digit: '0' },
  { pattern: /\b(một|mốt|mot)\b/gi, digit: '1' },
  { pattern: /\b(hai)\b/gi, digit: '2' },
  { pattern: /\b(ba)\b/gi, digit: '3' },
  { pattern: /\b(bốn|tư|bon|tu)\b/gi, digit: '4' },
  { pattern: /\b(năm|lăm|nam|lam)\b/gi, digit: '5' },
  { pattern: /\b(sáu|sau)\b/gi, digit: '6' },
  { pattern: /\b(bảy|bẩy|bay)\b/gi, digit: '7' },
  { pattern: /\b(tám|tam)\b/gi, digit: '8' },
  { pattern: /\b(chín|chin)\b/gi, digit: '9' },
];

const VIETNAMESE_COLOR_KEYWORDS = [
  'đen',
  'trắng',
  'kem',
  'be',
  'nâu',
  'đỏ',
  'hồng',
  'xanh đen',
  'xanh dương',
  'xanh lá',
  'xanh rêu',
  'xanh пастел',
  'vàng',
  'tím',
  'xám',
  'ghi',
];

@Injectable()
export class VietnameseCommerceNerService {
  private stripDiacritics(input: string): string {
    return input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase();
  }

  /**
   * Chuẩn hóa văn bản chứa SĐT lách luật (viết bằng chữ tiếng Việt, thay 0 bằng O/o, thay 1 bằng I/l, chèn dấu chấm/gạch)
   */
  public extractEvasionResistantPhones(rawText: string): Array<{
    rawMatch: string;
    localPhone: string;
    e164Phone: string;
    carrierName: string;
  }> {
    if (!rawText || !rawText.trim()) return [];

    let normalizedForPhone = ` ${rawText} `;
    for (const item of VIETNAMESE_NUMBER_WORDS_MAP) {
      normalizedForPhone = normalizedForPhone.replace(item.pattern, item.digit);
    }

    // Thay thế ký tự đồng hình (homoglyphs) O/o -> 0 và I/l -> 1 khi đứng cạnh chữ số
    normalizedForPhone = normalizedForPhone
      .replace(/(?<=\d|\s|^)[Oo](?=\d)/g, '0')
      .replace(/(?<=\d)[Oo](?=\d|\s|$)/g, '0')
      .replace(/(?<=\d)[Il](?=\d)/g, '1');

    const candidateRegex = /(?:\+?84|0)[\s._\-()]*[35789](?:[\s._\-()]*\d){8}\b/g;

    const matches = normalizedForPhone.match(candidateRegex) || [];
    const resultsMap = new Map<
      string,
      {
        rawMatch: string;
        localPhone: string;
        e164Phone: string;
        carrierName: string;
      }
    >();

    for (const rawCandidate of matches) {
      const digitsOnly = rawCandidate.replace(/\D/g, '');
      let localPhone = digitsOnly;
      if (localPhone.startsWith('84') && localPhone.length === 11) {
        localPhone = `0${localPhone.slice(2)}`;
      }
      if (!/^0[35789]\d{8}$/.test(localPhone)) {
        continue;
      }

      const e164Phone = `+84${localPhone.slice(1)}`;
      const prefix3 = localPhone.slice(0, 3);
      const carrierName = this.resolveVnMobileCarrier(prefix3);

      resultsMap.set(localPhone, {
        rawMatch: rawCandidate.trim(),
        localPhone,
        e164Phone,
        carrierName,
      });
    }

    return Array.from(resultsMap.values());
  }

  private resolveVnMobileCarrier(prefix3: string): string {
    const viettel = new Set([
      '086',
      '096',
      '097',
      '098',
      '032',
      '033',
      '034',
      '035',
      '036',
      '037',
      '038',
      '039',
    ]);
    const vinaphone = new Set(['088', '091', '094', '081', '082', '083', '084', '085']);
    const mobifone = new Set(['089', '090', '093', '070', '079', '077', '076', '078']);
    const vietnamobile = new Set(['092', '056', '058']);

    if (viettel.has(prefix3)) return 'Viettel';
    if (vinaphone.has(prefix3)) return 'VinaPhone';
    if (mobifone.has(prefix3)) return 'MobiFone';
    if (vietnamobile.has(prefix3)) return 'Vietnamobile';
    return 'VN Telecom';
  }

  /**
   * Chuẩn hóa địa chỉ hành chính 3 cấp tốc độ < 3ms và ánh xạ mã vùng 4 hãng vận chuyển (GHN, GHTK, VTP, J&T)
   */
  public resolveThreeTierVietnameseAddress(rawText: string): {
    province: VnProvinceUnitItem | null;
    district: VnDistrictUnitItem | null;
    ward: VnWardUnitItem | null;
    addressLine: string | null;
    fullFormattedAddress: string | null;
  } {
    if (!rawText || !rawText.trim()) {
      return {
        province: null,
        district: null,
        ward: null,
        addressLine: null,
        fullFormattedAddress: null,
      };
    }

    const asciiText = ` ${this.stripDiacritics(rawText).replace(/[,.;\-/]+/g, ' ')} `;

    let matchedProvince: VnProvinceUnitItem | null = null;
    let matchedDistrict: VnDistrictUnitItem | null = null;
    let matchedWard: VnWardUnitItem | null = null;

    // 1. Khớp Tỉnh/Thành phố hoặc suy luận từ Quận/Huyện đặc trưng (VD: "Cầu Giấy" -> Hà Nội, "Bình Thạnh" -> TP.HCM)
    for (const prov of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
      const hasProvAlias = prov.aliases.some((alias) =>
        new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i').test(asciiText),
      );
      if (hasProvAlias) {
        matchedProvince = prov;
        break;
      }
    }

    const candidateProvinces = matchedProvince
      ? [matchedProvince]
      : VN_ADMINISTRATIVE_UNITS_DICTIONARY;

    for (const prov of candidateProvinces) {
      for (const dist of prov.districts) {
        const hasDistAlias = dist.aliases.some((alias) =>
          new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i').test(asciiText),
        );
        if (hasDistAlias) {
          matchedProvince = prov;
          matchedDistrict = dist;
          break;
        }
      }
      if (matchedDistrict) break;
    }

    // 2. Tìm Phường/Xã trong Quận/Huyện đã khớp (hoặc suy luận ngược từ tên đường/phường đặc trưng)
    if (matchedDistrict) {
      for (const ward of matchedDistrict.wards) {
        const hasWardAlias = ward.aliases.some((alias) =>
          new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i').test(asciiText),
        );
        if (hasWardAlias) {
          matchedWard = ward;
          break;
        }
      }
      if (!matchedWard && matchedDistrict.wards.length > 0) {
        matchedWard = matchedDistrict.wards[0];
      }
    } else if (matchedProvince) {
      for (const dist of matchedProvince.districts) {
        for (const ward of dist.wards) {
          const hasWardAlias = ward.aliases.some((alias) =>
            new RegExp(`(^|\\s)${alias}(\\s|$)`, 'i').test(asciiText),
          );
          if (hasWardAlias) {
            matchedDistrict = dist;
            matchedWard = ward;
            break;
          }
        }
        if (matchedWard) break;
      }
    }

    if (!matchedProvince && !matchedDistrict) {
      return {
        province: null,
        district: null,
        ward: null,
        addressLine: null,
        fullFormattedAddress: null,
      };
    }

    // 3. Tách phần địa chỉ chi tiết (số nhà, ngõ/ngách, tên đường)
    const addressLineMatch = rawText.match(
      /(?:về|địa chỉ|đ\/c|dc|nhận tại|giao về|số|sn|ngõ|hẻm|đường|phố|tòa|chung cư)\s+([^,.!\n]{4,90})/i,
    );
    const fallbackStreetMatch = rawText.match(
      /\b(\d+[A-Za-z0-9/]*\s+(?:ngõ|hẻm|đường|phố|Nguyễn|Trần|Lê|Phạm|Hoàng|Cầu Giấy|Xuân Thủy|Láng Hạ|Xã Đàn|Quang Trung|Điện Biên Phủ)[^,.!\n]{2,60})/i,
    );

    const rawAddressLine = (
      addressLineMatch?.[1] ||
      fallbackStreetMatch?.[1] ||
      rawText.slice(0, 80)
    )
      .replace(/(?:sđt|sdt|đt|gọi|nhé|ạ).*$/i, '')
      .trim();

    const fullParts = [
      rawAddressLine,
      matchedWard?.name,
      matchedDistrict?.name,
      matchedProvince?.name,
    ].filter(Boolean);

    return {
      province: matchedProvince,
      district: matchedDistrict,
      ward: matchedWard,
      addressLine: rawAddressLine || null,
      fullFormattedAddress: fullParts.join(', '),
    };
  }

  /**
   * Bóc tách toàn diện Thực thể Thương mại Tiếng Việt (SĐT, Địa chỉ 3 cấp, Mã SKU, Màu sắc, Kích cỡ, Chiều cao, Cân nặng)
   */
  public extractCommerceEntities(rawText: string): ExtractedCommerceEntitiesPayload {
    const startTime = performance.now();
    const normalizedPhones = this.extractEvasionResistantPhones(rawText);
    const phones = normalizedPhones.map((p) => p.localPhone);

    const addressResolved = this.resolveThreeTierVietnameseAddress(rawText);

    // Bóc tách mã sản phẩm SKU (VD: A12, VAY-01, DAM_A12, SP102)
    const skuMatches = Array.from(
      new Set(
        (
          rawText.match(
            /\b(?:mã|sp|sku|đầm|váy|áo|quần|set)?\s*([A-Z]{1,4}[-_]?\d{2,5}[A-Z0-9]*)\b/gi,
          ) || []
        )
          .map((m) => {
            const parts = m.trim().split(/\s+/);
            return parts[parts.length - 1].toUpperCase();
          })
          .filter(
            (token) =>
              !/^(SIZE| قاع|1M\d{2}|\d{2}KG|Q\d+|P\d+|HN|SG)$/i.test(token) &&
              /[A-Z]/i.test(token) &&
              /\d/.test(token),
          ),
      ),
    );

    // Bóc tách Size quần áo (S, M, L, XL, XXL, 2XL, 3XL, Freesize)
    const sizeMatches = Array.from(
      new Set(
        (rawText.match(/\b(?:size|sz|cỡ)\s*(xs|s|m|l|xl|xxl|2xl|3xl|freesize)\b/gi) || []).map(
          (s) => s.replace(/^(?:size|sz|cỡ)\s*/i, '').toUpperCase(),
        ),
      ),
    );

    // Bóc tách Màu sắc
    const lowerText = rawText.toLowerCase();
    const detectedColors = VIETNAMESE_COLOR_KEYWORDS.filter((color) =>
      new RegExp(`(^|\\s|màu\\s+)${color}(\\s|,|\\.|$)`, 'i').test(lowerText),
    );

    // Bóc tách Chiều cao (VD: "1m60", "160cm", "cao 1m62") & Cân nặng (VD: "52kg", "nặng 50 kí")
    let heightCm: number | null = null;
    const heightMeterMatch = rawText.match(/\b1\s*m\s*(\d{1,2})\b/i);
    const heightCmMatch = rawText.match(/\b(1[4-9]\d)\s*cm\b/i);
    if (heightMeterMatch) {
      const sub = heightMeterMatch[1].padEnd(2, '0');
      heightCm = 100 + Number(sub);
    } else if (heightCmMatch) {
      heightCm = Number(heightCmMatch[1]);
    }

    let weightKg: number | null = null;
    const weightMatch = rawText.match(/\b([3-9]\d|1[0-2]\d)\s*(?:kg|kí|ký|cân)\b/i);
    if (weightMatch) {
      weightKg = Number(weightMatch[1]);
    }

    const processingTimeMs = Number((performance.now() - startTime).toFixed(2));

    return {
      phones,
      normalizedPhones,
      provinceCode: addressResolved.province?.code || null,
      provinceName: addressResolved.province?.name || null,
      districtCode: addressResolved.district?.code || null,
      districtName: addressResolved.district?.name || null,
      wardCode: addressResolved.ward?.code || null,
      wardName: addressResolved.ward?.name || null,
      addressLine: addressResolved.addressLine,
      fullFormattedAddress: addressResolved.fullFormattedAddress,
      carrierCodes: addressResolved.province
        ? {
            ghnProvinceId: addressResolved.province.ghnProvinceId,
            ghnDistrictId: addressResolved.district?.ghnDistrictId,
            ghnWardCode: addressResolved.ward?.ghnWardCode,
            ghtkProvince: addressResolved.province.ghtkProvinceName,
            ghtkDistrict: addressResolved.district?.ghtkDistrictName,
            ghtkWard: addressResolved.ward?.ghtkWardName,
            vtpProvinceId: addressResolved.province.vtpProvinceId,
            jtCityCode: addressResolved.province.jtCityCode,
          }
        : null,
      skuCodes: skuMatches,
      colors: detectedColors,
      sizes: sizeMatches,
      heightCm,
      weightKg,
      processingTimeMs,
    };
  }

  public getAdministrativeTree(): VnProvinceUnitItem[] {
    return VN_ADMINISTRATIVE_UNITS_DICTIONARY;
  }
}
