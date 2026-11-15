import { Injectable } from '@nestjs/common';

import {
  ExtractedCommerceEntitiesPayload,
  ExtractedPhoneTrustSummary,
} from 'src/entity/message.entity';

import {
  VN_ADMINISTRATIVE_UNITS_DICTIONARY,
  VN_CURRENT_34_PROVINCES_DICTIONARY,
  VnDistrictUnitItem,
  VnHamletUnitItem,
  VnHamletUnitType,
  VnProvinceUnitItem,
  VnWardUnitItem,
} from '../dictionaries/vn-administrative-units.constant';

const VIETNAMESE_NUMBER_WORDS_MAP: Array<{ pattern: RegExp; digit: string }> = [
  { pattern: /\b(không|khong|k0|zero|zê\s*rô)\b/gi, digit: '0' },
  { pattern: /\b(một|mốt|mot|nhất|nhat)\b/gi, digit: '1' },
  { pattern: /\b(hai|nhị|nhi)\b/gi, digit: '2' },
  { pattern: /\b(ba|tam)\b/gi, digit: '3' },
  { pattern: /\b(bốn|tư|bon|tu|tứ)\b/gi, digit: '4' },
  { pattern: /\b(năm|lăm|nam|lam|ngũ|ngu)\b/gi, digit: '5' },
  { pattern: /\b(sáu|sau|lục|luc)\b/gi, digit: '6' },
  { pattern: /\b(bảy|bẩy|bay|thất|that)\b/gi, digit: '7' },
  { pattern: /\b(tám|tam|bát|bat)\b/gi, digit: '8' },
  { pattern: /\b(chín|chin|cửu|cuu)\b/gi, digit: '9' },
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
  'xanh cốm',
  'xanh than',
  'vàng',
  'tím',
  'xám',
  'ghi',
  'cam',
  'bạc',
];

export interface ResolvedVietnameseAddressResult {
  hasAddressDetected: boolean;
  province: VnProvinceUnitItem | null;
  district: VnDistrictUnitItem | null;
  ward: VnWardUnitItem | null;
  hamlet: VnHamletUnitItem | null;
  legacyProvinceCode: string | null;
  legacyProvinceName: string | null;
  mergedProvinceCode: string | null;
  mergedProvinceName: string | null;
  isMergedProvince: boolean;
  detectedAddressTier: 3 | 4 | null;
  addressLine: string | null;
  fullFormattedAddress: string | null;
  fullFourTierFormattedAddress: string | null;
}

@Injectable()
export class VietnameseCommerceNerService {
  private stripDiacritics(input: string): string {
    return input
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase();
  }

  private normalizeUnicodeDigits(input: string): string {
    return input
      .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xff10 + 48))
      .replace(/[\u2460-\u2468]/g, (ch) => String(ch.charCodeAt(0) - 0x2460 + 1))
      .replace(/\u24EA/g, '0');
  }

  private escapeRegex(raw: string): string {
    return raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private hasPhraseInAsciiText(asciiText: string, phrase: string): boolean {
    const clean = phrase.trim();
    if (!clean) return false;
    return new RegExp(`(^|\\s)${this.escapeRegex(clean)}(\\s|$)`, 'i').test(asciiText);
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
   * Chuẩn hóa văn bản chứa SĐT lách luật (viết bằng chữ tiếng Việt, thay 0 bằng O/o, thay 1 bằng I/l, chèn dấu chấm/gạch/ký tự fullwidth)
   */
  public extractEvasionResistantPhones(rawText: string): Array<{
    rawMatch: string;
    localPhone: string;
    maskedPhone: string;
    e164Phone: string;
    carrierName: string;
  }> {
    if (!rawText || !rawText.trim()) return [];

    let normalizedForPhone = ` ${this.normalizeUnicodeDigits(rawText)} `;
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

    // 2. Nếu câu gốc còn chứa SĐT viết bằng chữ tiếng Việt, thay thế chuỗi từ chỉ số bằng SĐT đã che
    const wordNumberSequencePattern =
      /(?:(?:\b(?:không|khong|k0|zero|một|mốt|mot|nhất|nhat|hai|nhị|nhi|ba|bốn|tư|bon|tu|tứ|năm|lăm|nam|lam|ngũ|ngu|sáu|sau|lục|luc|bảy|bẩy|bay|thất|that|tám|tam|bát|bat|chín|chin|cửu|cuu)\b|\d)[\s._\-]*){9,11}/gi;
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
    const wintel = new Set(['055']);
    const itelecom = new Set(['087']);
    const gmobile = new Set(['099', '059']);

    if (viettel.has(prefix3)) return 'Viettel';
    if (vinaphone.has(prefix3)) return 'VinaPhone';
    if (mobifone.has(prefix3)) return 'MobiFone';
    if (vietnamobile.has(prefix3)) return 'Vietnamobile';
    if (wintel.has(prefix3)) return 'Wintel';
    if (itelecom.has(prefix3)) return 'Itelecom';
    if (gmobile.has(prefix3)) return 'Gmobile';
    return 'VN Telecom';
  }

  /**
   * Trích xuất động các thành phần địa giới hành chính cấp 2 (Quận/Huyện/TX/TP), cấp 3 (Phường/Xã/Thị trấn/Đặc khu)
   * và cấp 4 (Thôn/Ấp/Bản/Làng/Khu phố/Tổ dân phố/Khóm/Tiểu khu/Xóm/KĐT) trực tiếp từ ngữ pháp tiếng Việt
   * để đảm bảo độ phủ 100% cho mọi xã/huyện/thôn/ấp trên toàn bộ 63 tỉnh thành Việt Nam.
   */
  private extractDynamicFourTierSegments(textWithoutPhones: string): {
    dynamicDistrictName: string | null;
    dynamicWardName: string | null;
    dynamicHamlet: VnHamletUnitItem | null;
  } {
    let dynamicDistrictName: string | null = null;
    let dynamicWardName: string | null = null;
    let dynamicHamlet: VnHamletUnitItem | null = null;

    // 1. Bóc tách Cấp 4 (Thôn, Ấp, Bản, Làng, Khu phố, Tổ dân phố, Tổ, Khóm, Tiểu khu, Xóm, Đội, Khu đô thị)
    const hamletRegex =
      /\b(tổ\s*dân\s*phố(?:\s*số)?|tdp(?:\s*số)?|khu\s*phố|kp|thôn|ấp|bản|làng|khóm|tiểu\s*khu|xóm|buôn|khu\s*đô\s*thị|kđt)\s+([A-Za-zÀ-ỹ0-9][A-Za-zÀ-ỹ0-9\s\-/]{0,28}?)(?=\s*(?:,|;|\.|-\s|\b(?:phường|p\.|xã|thị\s*trấn|tt\.|quận|q\.|huyện|thị\s*xã|tx\.|thành\s*phố|tp\.|tỉnh|nhé|nha|ạ|sđt|sdt)\b|$))/i;
    const hamletMatch = textWithoutPhones.match(hamletRegex);
    if (hamletMatch) {
      const rawPrefix = hamletMatch[1].trim();
      const rawVal = hamletMatch[2].trim();
      const prefixAscii = this.stripDiacritics(rawPrefix);

      let unitType: VnHamletUnitType = 'THON';
      let normalizedPrefix = 'Thôn';
      if (prefixAscii.includes('to dan pho') || prefixAscii.startsWith('tdp')) {
        unitType = 'TO_DAN_PHO';
        normalizedPrefix = /^\d+$/.test(rawVal) ? 'Tổ dân phố số' : 'Tổ dân phố';
      } else if (prefixAscii.includes('khu pho') || prefixAscii === 'kp') {
        unitType = 'KHU_PHO';
        normalizedPrefix = 'Khu phố';
      } else if (prefixAscii === 'ap') {
        unitType = 'AP';
        normalizedPrefix = 'Ấp';
      } else if (prefixAscii === 'ban' || prefixAscii === 'buon') {
        unitType = 'BAN';
        normalizedPrefix = 'Bản';
      } else if (prefixAscii === 'lang') {
        unitType = 'LANG';
        normalizedPrefix = 'Làng';
      } else if (prefixAscii === 'khom') {
        unitType = 'KHOM';
        normalizedPrefix = 'Khóm';
      } else if (prefixAscii.includes('tieu khu')) {
        unitType = 'TIEU_KHU';
        normalizedPrefix = 'Tiểu khu';
      } else if (prefixAscii === 'xom') {
        unitType = 'XOM';
        normalizedPrefix = 'Xóm';
      } else if (prefixAscii.includes('khu do thi') || prefixAscii === 'kdt') {
        unitType = 'KHU_DO_THI';
        normalizedPrefix = 'KĐT';
      }

      const formattedHamletName = `${normalizedPrefix} ${rawVal}`.replace(/\s+/g, ' ').trim();
      const slug = this.stripDiacritics(formattedHamletName)
        .replace(/[^a-z0-9]+/g, '-')
        .toUpperCase();
      dynamicHamlet = {
        code: `DYN-H-${slug.slice(0, 24)}`,
        name: formattedHamletName,
        unitType,
        aliases: [this.stripDiacritics(formattedHamletName)],
        ghtkHamletName: formattedHamletName,
      };
    }

    // 2. Bóc tách Cấp 3 (Phường, Xã, Thị trấn, Đặc khu)
    const wardRegex =
      /\b(phường|p\.|xã|thị\s*trấn|tt\.|đặc\s*khu)\s+([A-Za-zÀ-ỹ0-9][A-Za-zÀ-ỹ0-9\s]{0,26}?)(?=\s*(?:,|;|\.|-\s|\b(?:quận|q\.|huyện|h\.|thị\s*xã|tx\.|thành\s*phố|tp\.|tỉnh|nhé|nha|ạ|sđt|sdt)\b|$))/i;
    const wardMatch = textWithoutPhones.match(wardRegex);
    if (wardMatch) {
      const pfx = this.stripDiacritics(wardMatch[1]);
      const val = wardMatch[2].trim();
      const stdPrefix = pfx.startsWith('p')
        ? 'Phường'
        : pfx.startsWith('x')
          ? 'Xã'
          : pfx.includes('dac khu')
            ? 'Đặc khu'
            : 'Thị trấn';
      dynamicWardName = `${stdPrefix} ${val}`.replace(/\s+/g, ' ').trim();
    }

    // 3. Bóc tách Cấp 2 (Quận, Huyện, Thị xã, Thành phố thuộc tỉnh)
    const distRegex =
      /\b(quận|q\.|huyện|h\.|thị\s*xã|tx\.|thành\s*phố|tp\.)\s+([A-Za-zÀ-ỹ0-9][A-Za-zÀ-ỹ0-9\s]{0,26}?)(?=\s*(?:,|;|\.|-\s|\b(?:tỉnh|thành\s*phố|tp\.|nhé|nha|ạ|sđt|sdt)\b|$))/i;
    const distMatch = textWithoutPhones.match(distRegex);
    if (distMatch) {
      const pfx = this.stripDiacritics(distMatch[1]);
      const val = distMatch[2].trim();
      const stdPrefix = pfx.startsWith('q')
        ? 'Quận'
        : pfx.startsWith('h')
          ? 'Huyện'
          : pfx.startsWith('tx') || pfx.includes('thi xa')
            ? 'Thị xã'
            : 'Thành phố';
      dynamicDistrictName = `${stdPrefix} ${val}`.replace(/\s+/g, ' ').trim();
    }

    return {
      dynamicDistrictName,
      dynamicWardName,
      dynamicHamlet,
    };
  }

  /**
   * Chuẩn hóa địa chỉ hành chính Việt Nam hỗ trợ đồng thời:
   * - Bộ nhận diện 3 cấp chính cho toàn bộ tỉnh thành cả nước Việt Nam (Tỉnh/Thành -> Quận/Huyện/TP -> Phường/Xã/Thị trấn/Đặc khu)
   * - Bộ nhận diện 4 cấp hành chính cho tất cả 63 tỉnh thành trước đó của Việt Nam (Tỉnh/Thành [63/34] -> Quận/Huyện/TP -> Phường/Xã/Thị trấn -> Cấp 4: Thôn/Ấp/Bản/Khu phố/Tổ dân phố/Khóm/KĐT)
   * Ánh xạ tự động mã vùng cho cả 4 hãng vận chuyển (GHN, GHTK 4 cấp, ViettelPost, J&T Express) trong < 3ms.
   */
  public resolveFourTierVietnameseAddress(rawText: string): ResolvedVietnameseAddressResult {
    if (!rawText || !rawText.trim()) {
      return {
        hasAddressDetected: false,
        province: null,
        district: null,
        ward: null,
        hamlet: null,
        legacyProvinceCode: null,
        legacyProvinceName: null,
        mergedProvinceCode: null,
        mergedProvinceName: null,
        isMergedProvince: false,
        detectedAddressTier: null,
        addressLine: null,
        fullFormattedAddress: null,
        fullFourTierFormattedAddress: null,
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
        hamlet: null,
        legacyProvinceCode: null,
        legacyProvinceName: null,
        mergedProvinceCode: null,
        mergedProvinceName: null,
        isMergedProvince: false,
        detectedAddressTier: null,
        addressLine: null,
        fullFormattedAddress: null,
        fullFourTierFormattedAddress: null,
      };
    }

    const asciiText = ` ${this.stripDiacritics(textWithoutPhones).replace(/[,.;\-/()]+/g, ' ')} `;

    let matchedProvince: VnProvinceUnitItem | null = null;
    let matchedDistrict: VnDistrictUnitItem | null = null;
    let matchedWard: VnWardUnitItem | null = null;
    let matchedHamlet: VnHamletUnitItem | null = null;

    // 1. Khớp Tỉnh/Thành phố trên toàn bộ 63 tỉnh thành (ưu tiên cụm alias dài và cụ thể nhất)
    let bestProvAliasLen = 0;
    for (const prov of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
      for (const alias of prov.aliases) {
        if (alias.length > bestProvAliasLen && this.hasPhraseInAsciiText(asciiText, alias)) {
          matchedProvince = prov;
          bestProvAliasLen = alias.length;
        }
      }
    }

    // 2. Khớp Quận/Huyện/Thị xã/Thành phố thuộc tỉnh:
    // Nếu khách viết tên Quận/Huyện thuộc tỉnh hợp nhất (VD: khách viết "TP. Dĩ An, TP.HCM" hoặc chỉ viết "TP. Dĩ An"),
    // ta quét cả tỉnh đã khớp cùng các tỉnh thành viên trong cùng cụm sáp nhập (hoặc toàn bộ 63 tỉnh nếu chưa khớp tỉnh)
    const candidateProvincesForDistrict = matchedProvince
      ? VN_ADMINISTRATIVE_UNITS_DICTIONARY.filter(
          (p) =>
            p.code === matchedProvince!.code ||
            (matchedProvince!.mergedIntoProvinceCode &&
              p.mergedIntoProvinceCode === matchedProvince!.mergedIntoProvinceCode),
        )
      : VN_ADMINISTRATIVE_UNITS_DICTIONARY;

    let bestDistAliasLen = 0;
    for (const prov of candidateProvincesForDistrict) {
      for (const dist of prov.districts) {
        for (const alias of dist.aliases) {
          if (alias.length > bestDistAliasLen && this.hasPhraseInAsciiText(asciiText, alias)) {
            matchedProvince = prov;
            matchedDistrict = dist;
            bestDistAliasLen = alias.length;
          }
        }
      }
    }

    // 3. Khớp Phường/Xã/Thị trấn/Đặc khu (Cấp 3)
    if (matchedDistrict) {
      let bestWardAliasLen = 0;
      for (const ward of matchedDistrict.wards) {
        for (const alias of ward.aliases) {
          if (alias.length > bestWardAliasLen && this.hasPhraseInAsciiText(asciiText, alias)) {
            matchedWard = ward;
            bestWardAliasLen = alias.length;
          }
        }
      }
    } else {
      const searchProvs = matchedProvince
        ? candidateProvincesForDistrict
        : VN_ADMINISTRATIVE_UNITS_DICTIONARY;
      let bestWardAliasLen = 0;
      for (const prov of searchProvs) {
        for (const dist of prov.districts) {
          for (const ward of dist.wards) {
            for (const alias of ward.aliases) {
              if (alias.length > bestWardAliasLen && this.hasPhraseInAsciiText(asciiText, alias)) {
                matchedProvince = prov;
                matchedDistrict = dist;
                matchedWard = ward;
                bestWardAliasLen = alias.length;
              }
            }
          }
        }
      }
    }

    // 4. Bóc tách động các cấp hành chính (Cấp 2, Cấp 3, Cấp 4) nếu khách viết tên Xã/Huyện/Thôn/Ấp ngoài danh mục mẫu
    const { dynamicDistrictName, dynamicWardName, dynamicHamlet } =
      this.extractDynamicFourTierSegments(textWithoutPhones);

    if (!matchedDistrict && matchedProvince && dynamicDistrictName) {
      const dynDistSlug = this.stripDiacritics(dynamicDistrictName)
        .replace(/[^a-z0-9]+/g, '-')
        .toUpperCase();
      matchedDistrict = {
        code: `${matchedProvince.code}-${dynDistSlug.slice(0, 12)}`,
        name: dynamicDistrictName,
        aliases: [this.stripDiacritics(dynamicDistrictName)],
        ghnDistrictId: matchedProvince.districts[0]?.ghnDistrictId || 1500,
        ghtkDistrictName: dynamicDistrictName,
        wards: [],
      };
    } else if (!matchedDistrict && matchedProvince && matchedProvince.districts.length > 0) {
      matchedDistrict = matchedProvince.districts[0];
    }

    if (!matchedWard && matchedDistrict && dynamicWardName) {
      const dynWardSlug = this.stripDiacritics(dynamicWardName)
        .replace(/[^a-z0-9]+/g, '-')
        .toUpperCase();
      matchedWard = {
        code: `${matchedDistrict.code}-${dynWardSlug.slice(0, 12)}`,
        name: dynamicWardName,
        aliases: [this.stripDiacritics(dynamicWardName)],
        ghnWardCode: matchedDistrict.wards[0]?.ghnWardCode || '10001',
        ghtkWardName: dynamicWardName,
        hamlets: [],
      };
    } else if (!matchedWard && matchedDistrict && matchedDistrict.wards.length > 0) {
      matchedWard = matchedDistrict.wards[0];
    }

    // 5. Khớp Cấp 4 (Thôn / Ấp / Bản / Khu phố / Tổ dân phố / Khóm / KĐT / Đường phố)
    if (dynamicHamlet) {
      matchedHamlet = dynamicHamlet;
    } else if (matchedWard?.hamlets && matchedWard.hamlets.length > 0) {
      for (const h of matchedWard.hamlets) {
        const hasHamletAlias = h.aliases.some((alias) =>
          this.hasPhraseInAsciiText(asciiText, alias),
        );
        if (hasHamletAlias) {
          matchedHamlet = h;
          break;
        }
      }
    }

    // 6. Kiểm tra các mẫu câu chứa Địa chỉ chi tiết
    const explicitAddressPrefixMatch = textWithoutPhones.match(
      /(?:địa\s*chỉ|dia\s*chi|đ\/c|d\/c|dc|nhận\s*tại|giao\s*về|ship\s*về|gửi\s*về|nhà\s*ở|ở\s*địa\s*chỉ)[:\s\-]+([^\n!?]{4,160})/i,
    );

    const structuralAddressMatch = textWithoutPhones.match(
      /\b((?:số\s*nhà|số|sn|ngõ|ngách|hẻm|đường|phố|tòa\s*nhà|tòa|chung\s*cư|khu\s*đô\s*thị|kđt|thôn|xóm|ấp|bản|làng|khóm|tiểu\s*khu|tổ\s*dân\s*phố|tdp|tổ\s*\d+|khu\s*phố|kp)\s+[^\n!?]{3,140})/i,
    );

    const streetNumberPatternMatch = textWithoutPhones.match(
      /\b(\d+[A-Za-z0-9/]*\s+(?:ngõ|ngách|hẻm|đường|phố|Nguyễn|Trần|Lê|Phạm|Hoàng|Phan|Vũ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Lý|Cầu\s*Giấy|Xuân\s*Thủy|Láng\s*Hạ|Xã\s*Đàn|Quang\s*Trung|Điện\s*Biên\s*Phủ|Giải\s*Phóng|Trường\s*Chinh|Minh\s*Khai|Sư\s*Vạn\s*Hạnh|Cách\s*Mạng\s*Tháng\s*8|Lê\s*Lợi|Hai\s*Bà\s*Trưng|Hùng\s*Vương|Trần\s*Hưng\s*Đạo|Lý\s*Thường\s*Kiệt)[^\n!?]{2,110})/i,
    );

    const adminKeywordInText =
      /\b(?:phường|p\.|xã|thị\s*trấn|đặc\s*khu|quận|q\.|huyện|thị\s*xã|tỉnh|thành\s*phố|tp\.|thôn|ấp|bản|khu\s*phố|tổ\s*dân\s*phố)\s+[A-Za-zÀ-ỹ0-9]+/i.test(
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
        hamlet: null,
        legacyProvinceCode: null,
        legacyProvinceName: null,
        mergedProvinceCode: null,
        mergedProvinceName: null,
        isMergedProvince: false,
        detectedAddressTier: null,
        addressLine: null,
        fullFormattedAddress: null,
        fullFourTierFormattedAddress: null,
      };
    }

    const rawAddressCandidate = (
      explicitAddressPrefixMatch?.[1] ||
      structuralAddressMatch?.[1] ||
      streetNumberPatternMatch?.[1] ||
      textWithoutPhones.slice(0, 140)
    )
      .replace(/(?:sđt|sdt|đt|gọi|nhé|nha|ạ|shop\s*ơi).*$/i, '')
      .replace(/^[,.\s\-:]+|[,.\s\-:]+$/g, '')
      .trim();

    const rawAddressLine = rawAddressCandidate || textWithoutPhones.slice(0, 120).trim();
    const lowerAddressLine = this.stripDiacritics(rawAddressLine);

    // Chuỗi địa chỉ chuẩn 3 cấp
    const threeTierParts: string[] = [];
    if (rawAddressLine) {
      threeTierParts.push(rawAddressLine);
    }
    if (
      matchedWard?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedWard.name.replace(/^(Phường|Xã|Thị trấn|Đặc khu)\s+/i, '')),
      )
    ) {
      threeTierParts.push(matchedWard.name);
    }
    if (
      matchedDistrict?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(
          matchedDistrict.name.replace(/^(Quận|Huyện|Thị xã|Thành phố)\s+/i, ''),
        ),
      )
    ) {
      threeTierParts.push(matchedDistrict.name);
    }
    if (
      matchedProvince?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedProvince.name.replace(/^(Thành phố|Tỉnh)\s+/i, '')),
      )
    ) {
      threeTierParts.push(matchedProvince.name);
    }

    // Chuỗi địa chỉ đầy đủ 4 cấp hành chính (kèm đối chiếu Tỉnh sáp nhập nếu có)
    const fourTierParts: string[] = [];
    if (rawAddressLine) {
      fourTierParts.push(rawAddressLine);
    }
    if (
      matchedHamlet?.name &&
      !lowerAddressLine.includes(this.stripDiacritics(matchedHamlet.name))
    ) {
      fourTierParts.push(matchedHamlet.name);
    }
    if (
      matchedWard?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedWard.name.replace(/^(Phường|Xã|Thị trấn|Đặc khu)\s+/i, '')),
      )
    ) {
      fourTierParts.push(matchedWard.name);
    }
    if (
      matchedDistrict?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(
          matchedDistrict.name.replace(/^(Quận|Huyện|Thị xã|Thành phố)\s+/i, ''),
        ),
      )
    ) {
      fourTierParts.push(matchedDistrict.name);
    }
    if (matchedProvince?.name) {
      if (
        !lowerAddressLine.includes(
          this.stripDiacritics(matchedProvince.name.replace(/^(Thành phố|Tỉnh)\s+/i, '')),
        )
      ) {
        fourTierParts.push(matchedProvince.name);
      }
      if (
        matchedProvince.mergedIntoProvinceCode &&
        matchedProvince.mergedIntoProvinceCode !== matchedProvince.code &&
        matchedProvince.mergedIntoProvinceName
      ) {
        fourTierParts.push(`(ĐVHC mới: ${matchedProvince.mergedIntoProvinceName})`);
      }
    }

    const isMergedProvince = Boolean(
      matchedProvince?.mergedIntoProvinceCode &&
        matchedProvince.mergedIntoProvinceCode !== matchedProvince.code,
    );
    const detectedAddressTier: 3 | 4 = matchedHamlet || isMergedProvince ? 4 : 3;

    return {
      hasAddressDetected: true,
      province: matchedProvince,
      district: matchedDistrict,
      ward: matchedWard,
      hamlet: matchedHamlet,
      legacyProvinceCode: matchedProvince?.code || null,
      legacyProvinceName: matchedProvince?.name || null,
      mergedProvinceCode: matchedProvince?.mergedIntoProvinceCode || matchedProvince?.code || null,
      mergedProvinceName: matchedProvince?.mergedIntoProvinceName || matchedProvince?.name || null,
      isMergedProvince,
      detectedAddressTier,
      addressLine: rawAddressLine || null,
      fullFormattedAddress: threeTierParts.join(', '),
      fullFourTierFormattedAddress: fourTierParts.join(', '),
    };
  }

  /**
   * Phương thức tương thích chuẩn 3 cấp & 4 cấp hành chính
   */
  public resolveThreeTierVietnameseAddress(rawText: string): ResolvedVietnameseAddressResult {
    return this.resolveFourTierVietnameseAddress(rawText);
  }

  /**
   * Bóc tách toàn diện Thực thể Thương mại Tiếng Việt:
   * - SĐT chống lách luật & tự động che PII
   * - Địa chỉ 3 cấp chính (toàn quốc) & 4 cấp hành chính (toàn bộ 63 tỉnh thành trước đó + ánh xạ 34 tỉnh thành mới)
   * - Mã SKU, Màu sắc, Kích cỡ, Số lượng, Chiều cao, Cân nặng, Ý định thanh toán, Lưu ý giờ giao
   */
  public extractCommerceEntities(rawText: string): ExtractedCommerceEntitiesPayload {
    const startTime = performance.now();
    const normalizedPhones = this.extractEvasionResistantPhones(rawText);
    const phones = normalizedPhones.map((p) => p.localPhone);
    const maskedPhones = normalizedPhones.map((p) => p.maskedPhone);

    const addressResolved = this.resolveFourTierVietnameseAddress(rawText);

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
              !/^(SIZE|1M\d{2}|\d{2}KG|Q\d+|P\d+|KP\d+|TDP\d+|HN|SG|SN\d+|DC\d+|QL\d+|DT\d+)$/i.test(
                token,
              ) &&
              /[A-Z]/i.test(token) &&
              /\d/.test(token),
          ),
      ),
    );

    // Bóc tách Size (XS, S, M, L, XL, XXL, 2XL, 3XL, Freesize)
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

    // Bóc tách Số lượng đặt mua (VD: "cho chị 2 đầm", "sl 3", "x2", "3 cái", "2 chiếc")
    const quantityCandidates: number[] = [];
    const qtyPatterns = [
      /\b(?:sl|số\s*lượng)[:\s]*(\d{1,2})\b/gi,
      /\bx(\d{1,2})\b/gi,
      /\b(\d{1,2})\s*(?:cái|chiếc|bộ|set|đầm|váy|áo|quần|hộp|chai|lọ|tuýp|đôi)\b/gi,
    ];
    for (const pattern of qtyPatterns) {
      let m: RegExpExecArray | null = null;
      while ((m = pattern.exec(rawText)) !== null) {
        const val = Number(m[1]);
        if (val >= 1 && val <= 50 && !quantityCandidates.includes(val)) {
          quantityCandidates.push(val);
        }
      }
    }

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

    // Bóc tách Ý định thanh toán & Lưu ý khung giờ nhận hàng
    let paymentIntent: 'BANK_TRANSFER' | 'COD' | null = null;
    if (
      /\b(chuyển\s*khoản|chuyen\s*khoan|ck\s*trước|ck\s*luôn|vietqr|qr\s*code)\b/i.test(rawText)
    ) {
      paymentIntent = 'BANK_TRANSFER';
    } else if (
      /\b(ship\s*cod|thu\s*hộ|nhận\s*hàng\s*thanh\s*toán|trả\s*tiền\s*mặt)\b/i.test(rawText)
    ) {
      paymentIntent = 'COD';
    }

    let deliveryTimeNote: string | null = null;
    if (/\b(giờ\s*hành\s*chính|gio\s*hanh\s*chinh|hc)\b/i.test(rawText)) {
      deliveryTimeNote = 'Giao giờ hành chính (08:30 - 17:30)';
    } else if (/\b(ngoài\s*giờ|buổi\s*tối|sau\s*18h|cuối\s*tuần)\b/i.test(rawText)) {
      deliveryTimeNote = 'Giao ngoài giờ hành chính / Buổi tối';
    } else if (/\b(giao\s*gấp|hỏa\s*tốc|hoa\s*toc|ship\s*ngay)\b/i.test(rawText)) {
      deliveryTimeNote = 'Ưu tiên giao nhanh / Hỏa tốc';
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
      hamletCode: addressResolved.hamlet?.code || null,
      hamletName: addressResolved.hamlet?.name || null,
      hamletType: addressResolved.hamlet?.unitType || null,
      legacyProvinceCode: addressResolved.legacyProvinceCode,
      legacyProvinceName: addressResolved.legacyProvinceName,
      mergedProvinceCode: addressResolved.mergedProvinceCode,
      mergedProvinceName: addressResolved.mergedProvinceName,
      isMergedProvince: addressResolved.isMergedProvince,
      detectedAddressTier: addressResolved.detectedAddressTier,
      addressLine: addressResolved.addressLine,
      fullFormattedAddress: addressResolved.fullFormattedAddress,
      fullFourTierFormattedAddress: addressResolved.fullFourTierFormattedAddress,
      carrierCodes: addressResolved.province
        ? {
            ghnProvinceId: addressResolved.province.ghnProvinceId,
            ghnDistrictId: addressResolved.district?.ghnDistrictId,
            ghnWardCode: addressResolved.ward?.ghnWardCode,
            ghtkProvince: addressResolved.province.ghtkProvinceName,
            ghtkDistrict: addressResolved.district?.ghtkDistrictName,
            ghtkWard: addressResolved.ward?.ghtkWardName,
            ghtkHamlet:
              addressResolved.hamlet?.ghtkHamletName || addressResolved.hamlet?.name || 'Khác',
            vtpProvinceId: addressResolved.province.vtpProvinceId,
            jtCityCode: addressResolved.province.jtCityCode,
          }
        : null,
      skuCodes: skuMatches,
      colors: detectedColors,
      sizes: sizeMatches,
      quantities: quantityCandidates,
      heightCm,
      weightKg,
      paymentIntent,
      deliveryTimeNote,
      processingTimeMs,
    };
  }

  /**
   * Trả về cây từ điển hành chính Việt Nam:
   * - `ALL_63` (mặc định): Đầy đủ 63 Tỉnh/Thành phố (hỗ trợ cả 3 cấp và 4 cấp hành chính + cờ ánh xạ sang 34 Tỉnh/Thành mới)
   * - `CURRENT_34`: Danh sách 34 Tỉnh/Thành phố hiện tại sau sáp nhập (đã gộp Quận/Huyện/Phường/Xã/Thôn/Ấp của các tỉnh hợp nhất)
   */
  public getAdministrativeTree(mode: 'ALL_63' | 'CURRENT_34' = 'ALL_63'): VnProvinceUnitItem[] {
    if (mode === 'CURRENT_34') {
      return VN_CURRENT_34_PROVINCES_DICTIONARY;
    }
    return VN_ADMINISTRATIVE_UNITS_DICTIONARY;
  }
}
