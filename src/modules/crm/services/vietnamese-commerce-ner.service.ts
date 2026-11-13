import { Injectable } from '@nestjs/common';

import {
  ExtractedCommerceEntitiesPayload,
  ExtractedPhoneTrustSummary,
} from 'src/entity/message.entity';

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
  'xanh pastel',
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
   * Che SĐT chuẩn bảo mật PII (`098***456`)
   */
  public formatMaskedPhone(localPhone: string): string {
    const clean = (localPhone || '').replace(/\D/g, '');
    if (clean.length < 7) return '098***678';
    return `${clean.slice(0, 3)}***${clean.slice(-3)}`;
  }

  /**
   * Chuẩn hóa văn bản chứa SĐT lách luật (viết bằng chữ tiếng Việt, thay 0 bằng O/o, thay 1 bằng I/l, chèn dấu chấm/gạch)
   */
  public extractEvasionResistantPhones(rawText: string): Array<{
    rawMatch: string;
    localPhone: string;
    maskedPhone: string;
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
        maskedPhone: string;
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
      const maskedPhone = this.formatMaskedPhone(localPhone);

      resultsMap.set(localPhone, {
        rawMatch: rawCandidate.trim(),
        localPhone,
        maskedPhone,
        e164Phone,
        carrierName,
      });
    }

    return Array.from(resultsMap.values());
  }

  /**
   * Tự động che mọi SĐT trong nội dung tin nhắn ngay từ khi nhận được từ người mua:
   * - Che cả SĐT viết bằng số (`0988123456`, `0988.123.456`, `+84988123456`, `O988-123-456`)
   * - Che cả SĐT viết bằng chữ tiếng Việt lách luật (`"không chín tám tám 123 bốn năm sáu"`)
   * thành dạng bảo mật `098***456` để nhân viên không thấy SĐT trần trên màn hình chat nếu chưa mở khóa 15 giây.
   */
  public maskPhonesInText(
    rawText: string,
    preExtracted?: Array<{ rawMatch: string; localPhone?: string; maskedPhone?: string }>,
  ): string {
    if (!rawText || !rawText.trim()) return rawText;

    const extracted = preExtracted || this.extractEvasionResistantPhones(rawText);
    if (extracted.length === 0) return rawText;

    let maskedText = rawText;

    // 1. Thay thế trực tiếp các chuỗi SĐT dạng chữ số / dấu chấm / ký tự đồng hình trong câu gốc
    const directPhonePattern = /(?:\+?84|0|[Oo])[\s._\-()]*[35789](?:[\s._\-()]*[\dOoIl]){8}\b/g;
    maskedText = maskedText.replace(directPhonePattern, (match) => {
      const normalizedMatch = match.replace(/[Oo]/g, '0').replace(/[Il]/g, '1').replace(/\D/g, '');
      const local =
        normalizedMatch.startsWith('84') && normalizedMatch.length === 11
          ? `0${normalizedMatch.slice(2)}`
          : normalizedMatch;
      return this.formatMaskedPhone(local);
    });

    // 2. Nếu câu gốc còn chứa SĐT viết bằng chữ tiếng Việt (VD: "không chín tám tám 123 bốn năm sáu"),
    // thay thế chuỗi từ chỉ số bằng SĐT đã che tương ứng
    const wordNumberSequencePattern =
      /(?:(?:\b(?:không|khong|một|mốt|mot|hai|ba|bốn|tư|bon|tu|năm|lăm|nam|lam|sáu|sau|bảy|bẩy|bay|tám|tam|chín|chin)\b|\d)[\s._\-]*){9,11}/gi;
    maskedText = maskedText.replace(wordNumberSequencePattern, (seqMatch) => {
      const phonesInSeq = this.extractEvasionResistantPhones(seqMatch);
      if (phonesInSeq.length > 0) {
        return phonesInSeq[0].maskedPhone;
      }
      return seqMatch;
    });

    return maskedText;
  }

  /**
   * Làm sạch đối tượng `ExtractedCommerceEntitiesPayload` trước khi gửi về trình duyệt của nhân viên Sale:
   * Xóa `localPhone` và `e164Phone` gốc trong `extractedEntitiesJson`, chỉ giữ lại `maskedPhone` (`098***456`).
   */
  public sanitizeExtractedEntitiesForPublicResponse(
    extracted?: ExtractedCommerceEntitiesPayload | null,
    phoneTrustSummary?: ExtractedPhoneTrustSummary | null,
  ): ExtractedCommerceEntitiesPayload | null {
    if (!extracted) return null;

    const maskedList = Array.from(
      new Set(
        (extracted.maskedPhones && extracted.maskedPhones.length > 0
          ? extracted.maskedPhones
          : (extracted.phones || []).map((p) => (p.includes('*') ? p : this.formatMaskedPhone(p)))
        ).filter(Boolean),
      ),
    );

    const sanitizedNormalized = Array.isArray(extracted.normalizedPhones)
      ? extracted.normalizedPhones.map((item) => {
          const masked =
            item.maskedPhone ||
            (item.localPhone ? this.formatMaskedPhone(item.localPhone) : '098***678');
          return {
            rawMatch: masked,
            maskedPhone: masked,
            carrierName: item.carrierName,
          };
        })
      : [];

    return {
      ...extracted,
      phones: maskedList,
      maskedPhones: maskedList,
      normalizedPhones: sanitizedNormalized,
      phoneTrustSummary: phoneTrustSummary ?? extracted.phoneTrustSummary ?? null,
    };
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
   * Hỗ trợ nhận diện địa chỉ ngay cả khi khách nhắn riêng địa chỉ ở tin nhắn độc lập hoặc chỉ nhắn số nhà/ngõ/đường/phường/quận.
   */
  public resolveThreeTierVietnameseAddress(rawText: string): {
    hasAddressDetected: boolean;
    province: VnProvinceUnitItem | null;
    district: VnDistrictUnitItem | null;
    ward: VnWardUnitItem | null;
    addressLine: string | null;
    fullFormattedAddress: string | null;
  } {
    if (!rawText || !rawText.trim()) {
      return {
        hasAddressDetected: false,
        province: null,
        district: null,
        ward: null,
        addressLine: null,
        fullFormattedAddress: null,
      };
    }

    // Loại bỏ chuỗi SĐT ra khỏi câu trước khi phân tích địa chỉ để không nhầm SĐT là số nhà
    const textWithoutPhones = rawText
      .replace(/(?:\+?84|0|[Oo])[\s._\-()]*[35789](?:[\s._\-()]*[\dOoIl]){8}\b/g, ' ')
      .replace(/\b(?:sđt|sdt|đt|điện thoại|dien thoai|phone|gọi số)\b[:\s-]*/gi, ' ')
      .trim();

    if (!textWithoutPhones) {
      return {
        hasAddressDetected: false,
        province: null,
        district: null,
        ward: null,
        addressLine: null,
        fullFormattedAddress: null,
      };
    }

    const asciiText = ` ${this.stripDiacritics(textWithoutPhones).replace(/[,.;\-/]+/g, ' ')} `;

    let matchedProvince: VnProvinceUnitItem | null = null;
    let matchedDistrict: VnDistrictUnitItem | null = null;
    let matchedWard: VnWardUnitItem | null = null;

    // 1. Khớp Tỉnh/Thành phố hoặc suy luận từ Quận/Huyện đặc trưng (VD: "Cầu Giấy" -> Hà Nội, "Bình Thạnh" -> TP.HCM)
    for (const prov of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
      const hasProvAlias = prov.aliases.some((alias) =>
        new RegExp(`(^|\\s)${alias.trim()}(\\s|$)`, 'i').test(asciiText),
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
          new RegExp(`(^|\\s)${alias.trim()}(\\s|$)`, 'i').test(asciiText),
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
          new RegExp(`(^|\\s)${alias.trim()}(\\s|$)`, 'i').test(asciiText),
        );
        if (hasWardAlias) {
          matchedWard = ward;
          break;
        }
      }
      if (!matchedWard && matchedDistrict.wards.length > 0) {
        matchedWard = matchedDistrict.wards[0];
      }
    } else {
      const searchProvs = matchedProvince ? [matchedProvince] : VN_ADMINISTRATIVE_UNITS_DICTIONARY;
      for (const prov of searchProvs) {
        for (const dist of prov.districts) {
          for (const ward of dist.wards) {
            const hasWardAlias = ward.aliases.some((alias) =>
              new RegExp(`(^|\\s)${alias.trim()}(\\s|$)`, 'i').test(asciiText),
            );
            if (hasWardAlias) {
              matchedProvince = prov;
              matchedDistrict = dist;
              matchedWard = ward;
              break;
            }
          }
          if (matchedWard) break;
        }
        if (matchedWard) break;
      }
    }

    // 3. Kiểm tra các mẫu câu chứa Địa chỉ chi tiết (kể cả khi khách chỉ nhắn số nhà, ngõ, đường, phường, xã, thôn, xóm, chung cư...)
    const explicitAddressPrefixMatch = textWithoutPhones.match(
      /(?:địa\s*chỉ|dia\s*chi|đ\/c|d\/c|dc|nhận\s*tại|giao\s*về|ship\s*về|gửi\s*về|nhà\s*ở|ở\s*địa\s*chỉ)[:\s\-]+([^\n!?]{4,140})/i,
    );

    const structuralAddressMatch = textWithoutPhones.match(
      /\b((?:số\s*nhà|số|sn|ngõ|ngách|hẻm|đường|phố|tòa\s*nhà|tòa|chung\s*cư|khu\s*đô\s*thị|kđt|thôn|xóm|ấp|tổ\s*\d+|khu\s*phố|kp)\s+[^\n!?]{3,120})/i,
    );

    const streetNumberPatternMatch = textWithoutPhones.match(
      /\b(\d+[A-Za-z0-9/]*\s+(?:ngõ|ngách|hẻm|đường|phố|Nguyễn|Trần|Lê|Phạm|Hoàng|Phan|Vũ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Lý|Cầu\s*Giấy|Xuân\s*Thủy|Láng\s*Hạ|Xã\s*Đàn|Quang\s*Trung|Điện\s*Biên\s*Phủ|Giải\s*Phóng|Trường\s*Chinh|Minh\s*Khai|Sư\s*Vạn\s*Hạnh|Cách\s*Mạng\s*Tháng\s*8|Lê\s*Lợi|Hai\s*Bà\s*Trưng)[^\n!?]{2,100})/i,
    );

    const adminKeywordInText =
      /\b(?:phường|p\.|xã|thị\s*trấn|quận|q\.|huyện|thị\s*xã|tỉnh|thành\s*phố|tp\.)\s+[A-Za-zÀ-ỹ0-9]+/i.test(
        textWithoutPhones,
      );

    if (
      !matchedProvince &&
      !matchedDistrict &&
      !explicitAddressPrefixMatch &&
      !structuralAddressMatch &&
      !streetNumberPatternMatch &&
      !adminKeywordInText
    ) {
      return {
        hasAddressDetected: false,
        province: null,
        district: null,
        ward: null,
        addressLine: null,
        fullFormattedAddress: null,
      };
    }

    const rawAddressCandidate = (
      explicitAddressPrefixMatch?.[1] ||
      structuralAddressMatch?.[1] ||
      streetNumberPatternMatch?.[1] ||
      textWithoutPhones.slice(0, 120)
    )
      .replace(/(?:sđt|sdt|đt|gọi|nhé|nha|ạ|shop\s*ơi).*$/i, '')
      .replace(/^[,.\s\-:]+|[,.\s\-:]+$/g, '')
      .trim();

    const rawAddressLine = rawAddressCandidate || textWithoutPhones.slice(0, 100).trim();

    const fullParts: string[] = [];
    if (rawAddressLine) {
      fullParts.push(rawAddressLine);
    }
    const lowerAddressLine = this.stripDiacritics(rawAddressLine);
    if (
      matchedWard?.name &&
      !lowerAddressLine.includes(this.stripDiacritics(matchedWard.name.replace(/^Phường\s+/i, '')))
    ) {
      fullParts.push(matchedWard.name);
    }
    if (
      matchedDistrict?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedDistrict.name.replace(/^(Quận|Huyện|Thành phố)\s+/i, '')),
      )
    ) {
      fullParts.push(matchedDistrict.name);
    }
    if (
      matchedProvince?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedProvince.name.replace(/^(Thành phố|Tỉnh)\s+/i, '')),
      )
    ) {
      fullParts.push(matchedProvince.name);
    }

    return {
      hasAddressDetected: true,
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
    const maskedPhones = normalizedPhones.map((p) => p.maskedPhone);

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
              !/^(SIZE|1M\d{2}|\d{2}KG|Q\d+|P\d+|HN|SG|SN\d+|DC\d+)$/i.test(token) &&
              /[A-Z]/i.test(token) &&
              /\d/.test(token),
          ),
      ),
    );

    // Bóc tách Size (S, M, L, XL, XXL, 2XL, 3XL, Freesize)
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
      maskedPhones,
      normalizedPhones,
      hasAddressDetected: addressResolved.hasAddressDetected,
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
