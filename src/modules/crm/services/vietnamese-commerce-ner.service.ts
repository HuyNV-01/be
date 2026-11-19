import { Injectable } from '@nestjs/common';

import {
  ExtractedCommerceEntitiesPayload,
  ExtractedPhoneTrustSummary,
} from 'src/entity/message.entity';

import {
  MultiSourceAdminSyncOptions,
  MultiSourceAdminSyncReport,
  VN_ADMINISTRATIVE_UNITS_DICTIONARY,
  VN_CURRENT_34_PROVINCES_DICTIONARY,
  VnDistrictUnitItem,
  VnHamletUnitItem,
  VnHamletUnitType,
  VnProvinceUnitItem,
  VnWardUnitItem,
  buildDynamicHamletSuggestions,
  fetchLiveFourthTierHamletsForWard,
  getDirectWardsOfProvince,
  getHamletsOfWard,
  syncAdministrativeTreeFromOpenApisAndCarriers,
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
  fullThreeTierPostMergerAddress: string | null;
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
    if (clean.length < 7) return '';
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
    const wordNumberSeqRegex =
      /(?:(?:(?:không|khong|k0|zero|zê\s*rô|một|mốt|mot|nhất|nhat|hai|nhị|nhi|ba|tam|bốn|tư|bon|tu|tứ|năm|lăm|nam|lam|ngũ|ngu|sáu|sau|lục|luc|bảy|bẩy|bay|thất|that|tám|bát|bat|chín|chin|cửu|cuu)\b|\d)[\s._\-()]*){8,12}/gi;
    normalizedForPhone = normalizedForPhone.replace(wordNumberSeqRegex, (seq) => {
      let replaced = seq;
      for (const item of VIETNAMESE_NUMBER_WORDS_MAP) {
        replaced = replaced.replace(item.pattern, item.digit);
      }
      return replaced;
    });

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
            item.maskedPhone || (item.localPhone ? this.formatMaskedPhone(item.localPhone) : '');
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
   * Trích xuất động các thành phần địa giới hành chính cấp Quận/Huyện, cấp Phường/Xã/Đặc khu
   * và cấp Thôn/Ấp/Bản/Làng/Khu phố/Tổ dân phố/Khóm/Tiểu khu/Xóm/KĐT trực tiếp từ ngữ pháp tiếng Việt.
   */
  private extractDynamicFourTierSegments(textWithoutPhones: string): {
    dynamicDistrictName: string | null;
    dynamicWardName: string | null;
    dynamicHamlet: VnHamletUnitItem | null;
  } {
    let dynamicDistrictName: string | null = null;
    let dynamicWardName: string | null = null;
    let dynamicHamlet: VnHamletUnitItem | null = null;

    // 1. Bóc tách Thôn, Ấp, Bản, Làng, Khu phố, Tổ dân phố, Tổ, Khóm, Tiểu khu, Xóm, Đội, Khu đô thị
    const hamletRegex =
      /\b(tổ\s*dân\s*phố(?:\s*số)?|tdp(?:\s*số)?|khu\s*phố|kp|thôn|ấp|bản|làng|khóm|tiểu\s*khu|xóm|buôn|khu\s*đô\s*thị|kđt)\s+([A-Za-zÀ-ỹ0-9][A-Za-zÀ-ỹ0-9\s\-/]{0,28}?)(?=\s*(?:,|;|\.|-\s|\b(?:phường|p\.|xã|thị\s*trấn|tt\.|đặc\s*khu|quận|q\.|huyện|thị\s*xã|tx\.|thành\s*phố|tp\.|tỉnh|nhé|nha|ạ|sđt|sdt)\b|$))/i;
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

    // 2. Bóc tách Phường, Xã, Thị trấn, Đặc khu
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

    // 3. Bóc tách Quận, Huyện, Thị xã, Thành phố thuộc tỉnh (nếu khách viết theo 4 cấp cũ)
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
   * - Chế độ 3 Cấp Hành Chính mới (Nghị quyết 202/2025/QH15 & 34 Nghị quyết UBTVQH năm 2025, Chinhphu.vn):
   *   34 Tỉnh/Thành phố mới -> Phường/Xã/Đặc khu trực thuộc thẳng Tỉnh/Thành (KHÔNG CÓ CẤP HUYỆN) -> Thôn/Ấp/Khu phố/TDP.
   * - Chế độ 4 Cấp Hành Chính truyền thống:
   *   63 Tỉnh/Thành phố -> 704 Quận/Huyện/Thị xã/TP/Đặc khu -> 3.790+ Phường/Xã/Thị trấn -> Thôn/Ấp/Khu phố/TDP.
   * Tự động ánh xạ 2 chiều và điền mã vùng vận chuyển cho cả 4 hãng (GHN, GHTK, ViettelPost, J&T Express).
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
        fullThreeTierPostMergerAddress: null,
        fullFourTierFormattedAddress: null,
      };
    }

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
        fullThreeTierPostMergerAddress: null,
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

    // 2. Tập các tỉnh thành viên trong cùng cụm sáp nhập 34 Tỉnh/Thành (theo Nghị quyết 202/2025/QH15):
    // Giúp trường hợp khách nhắn "Phường Dĩ An, TP.HCM" (không có cấp huyện, ghép xã/phường Bình Dương cũ với TP.HCM mới)
    // hoặc "Đặc khu Phú Quốc, Tỉnh An Giang" vẫn khớp chính xác!
    const candidateProvinces = matchedProvince
      ? VN_ADMINISTRATIVE_UNITS_DICTIONARY.filter(
          (p) =>
            p.code === matchedProvince!.code ||
            (matchedProvince!.mergedIntoProvinceCode &&
              p.mergedIntoProvinceCode === matchedProvince!.mergedIntoProvinceCode),
        )
      : VN_ADMINISTRATIVE_UNITS_DICTIONARY;

    // 3. Khớp Quận/Huyện/Thị xã/Thành phố thuộc tỉnh/Đặc khu (nếu khách có nhắc tới cấp huyện)
    let bestDistAliasLen = 0;
    for (const prov of candidateProvinces) {
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

    // 4. Khớp Phường/Xã/Thị trấn/Đặc khu:
    // Hỗ trợ cả trường hợp khách nhắn theo 3 Cấp mới (Tỉnh/Thành mới + Phường/Xã/Đặc khu mới, KHÔNG CÓ CẤP HUYỆN)
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
    }

    if (!matchedWard) {
      let bestWardAliasLen = 0;
      for (const prov of candidateProvinces) {
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

    // 5. Bóc tách động các cấp hành chính nếu khách viết tên ngoài danh mục mẫu
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
        legacyProvinceCode: matchedProvince.code,
        legacyProvinceName: matchedProvince.name,
        mergedProvinceCode: matchedProvince.mergedIntoProvinceCode || matchedProvince.code,
        mergedProvinceName: matchedProvince.mergedIntoProvinceName || matchedProvince.name,
        wards: [],
      };
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
        legacyProvinceCode: matchedProvince?.code,
        legacyProvinceName: matchedProvince?.name,
        legacyDistrictCode: matchedDistrict.code,
        legacyDistrictName: matchedDistrict.name,
        mergedProvinceCode: matchedProvince?.mergedIntoProvinceCode || matchedProvince?.code,
        mergedProvinceName: matchedProvince?.mergedIntoProvinceName || matchedProvince?.name,
        hamlets: [],
      };
    } else if (!matchedWard && !matchedDistrict && matchedProvince && dynamicWardName) {
      const dynWardSlug = this.stripDiacritics(dynamicWardName)
        .replace(/[^a-z0-9]+/g, '-')
        .toUpperCase();
      matchedWard = {
        code: `${matchedProvince.code}-${dynWardSlug.slice(0, 12)}`,
        name: dynamicWardName,
        aliases: [this.stripDiacritics(dynamicWardName)],
        ghnWardCode: matchedProvince.districts[0]?.wards[0]?.ghnWardCode || '10001',
        ghtkWardName: dynamicWardName,
        legacyProvinceCode: matchedProvince.code,
        legacyProvinceName: matchedProvince.name,
        legacyDistrictCode: undefined,
        legacyDistrictName: undefined,
        mergedProvinceCode: matchedProvince.mergedIntoProvinceCode || matchedProvince.code,
        mergedProvinceName: matchedProvince.mergedIntoProvinceName || matchedProvince.name,
        hamlets: [],
      };
    }

    // 6. Khớp Thôn / Ấp / Bản / Khu phố / Tổ dân phố / Khóm / KĐT / Đường phố
    const wardHamlets = matchedWard
      ? getHamletsOfWard(matchedWard, matchedProvince?.region || 'BAC_BO')
      : [];
    if (dynamicHamlet) {
      matchedHamlet = dynamicHamlet;
    } else if (wardHamlets.length > 0) {
      for (const h of wardHamlets) {
        const hasHamletAlias = h.aliases.some((alias) =>
          this.hasPhraseInAsciiText(asciiText, alias),
        );
        if (hasHamletAlias) {
          matchedHamlet = h;
          break;
        }
      }
    }

    // 7. Kiểm tra chặt chẽ các mẫu câu chứa Địa chỉ giao hàng thực tế (Chống bắt nhầm câu hội thoại thông thường)
    const explicitAddressPrefixMatch = textWithoutPhones.match(
      /(?:địa\s*chỉ|dia\s*chi|đ\/c|d\/c|nhận\s*tại|giao\s*về|ship\s*về|gửi\s*về|nhà\s*ở|ở\s*địa\s*chỉ)[:\s\-]+([^\n!?]{5,160})/i,
    );

    const structuralAddressMatch = textWithoutPhones.match(
      /\b((?:số\s*nhà|sn\s*\d+|ngõ\s*\d+|ngách\s*\d+|hẻm\s*\d+|tòa\s*nhà|chung\s*cư|khu\s*đô\s*thị|kđt|tổ\s*dân\s*phố|tdp\s*\d+|khu\s*phố\s*\d+|thôn\s+[A-Za-zÀ-ỹ0-9]+|ấp\s+[A-Za-zÀ-ỹ0-9]+)\s*[^\n!?]{3,140})/i,
    );

    const streetNumberPatternMatch = textWithoutPhones.match(
      /\b(\d+[A-Za-z0-9/]*\s+(?:ngõ|ngách|hẻm|đường|phố|Nguyễn|Trần|Lê|Phạm|Hoàng|Phan|Vũ|Đặng|Bùi|Đỗ|Hồ|Ngô|Dương|Lý|Cầu\s*Giấy|Xuân\s*Thủy|Láng\s*Hạ|Xã\s*Đàn|Quang\s*Trung|Điện\s*Biên\s*Phủ|Giải\s*Phóng|Trường\s*Chinh|Minh\s*Khai|Sư\s*Vạn\s*Hạnh|Cách\s*Mạng\s*Tháng\s*8|Lê\s*Lợi|Hai\s*Bà\s*Trưng|Hùng\s*Vương|Trần\s*Hưng\s*Đạo|Lý\s*Thường\s*Kiệt)[^\n!?]{2,110})/i,
    );

    const hasMultiLevelAdminMatch =
      Boolean(matchedProvince && (matchedDistrict || matchedWard || matchedHamlet)) ||
      Boolean(matchedDistrict && matchedWard);

    const hasAdminWithDetail =
      Boolean(matchedProvince || matchedDistrict || matchedWard) &&
      Boolean(
        explicitAddressPrefixMatch ||
          structuralAddressMatch ||
          streetNumberPatternMatch ||
          dynamicWardName ||
          dynamicDistrictName ||
          dynamicHamlet,
      );

    if (
      !hasMultiLevelAdminMatch &&
      !hasAdminWithDetail &&
      !explicitAddressPrefixMatch &&
      !streetNumberPatternMatch
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
        fullThreeTierPostMergerAddress: null,
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

    const resolvedMergedProvinceName =
      matchedProvince?.mergedIntoProvinceName || matchedProvince?.name || null;

    // Chuỗi địa chỉ chuẩn 3 Cấp Hành Chính mới (Nghị quyết 202/2025/QH15 - Không có cấp huyện):
    // [Số nhà/Đường] -> [Thôn/Ấp/Khu phố] -> [Phường/Xã/Đặc khu mới] -> [34 Tỉnh/Thành phố mới]
    const threeTierPostMergerParts: string[] = [];
    if (rawAddressLine) {
      threeTierPostMergerParts.push(rawAddressLine);
    }
    if (
      matchedHamlet?.name &&
      !lowerAddressLine.includes(this.stripDiacritics(matchedHamlet.name))
    ) {
      threeTierPostMergerParts.push(matchedHamlet.name);
    }
    if (
      matchedWard?.name &&
      !lowerAddressLine.includes(
        this.stripDiacritics(matchedWard.name.replace(/^(Phường|Xã|Thị trấn|Đặc khu)\s+/i, '')),
      )
    ) {
      threeTierPostMergerParts.push(matchedWard.name);
    }
    if (
      resolvedMergedProvinceName &&
      !lowerAddressLine.includes(
        this.stripDiacritics(resolvedMergedProvinceName.replace(/^(Thành phố|Tỉnh)\s+/i, '')),
      )
    ) {
      threeTierPostMergerParts.push(resolvedMergedProvinceName);
    }

    // Chuỗi địa chỉ đầy đủ 4 Cấp Hành Chính (63 Tỉnh/Thành -> 704 Quận/Huyện -> 3.790+ Phường/Xã -> Thôn/Ấp)
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
          matchedDistrict.name.replace(/^(Quận|Huyện|Thị xã|Thành phố|Đặc khu)\s+/i, ''),
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
    const detectedAddressTier: 3 | 4 = bestDistAliasLen > 0 ? 4 : 3;

    return {
      hasAddressDetected: true,
      province: matchedProvince,
      district: matchedDistrict,
      ward: matchedWard,
      hamlet: matchedHamlet,
      legacyProvinceCode: matchedProvince?.code || null,
      legacyProvinceName: matchedProvince?.name || null,
      mergedProvinceCode: matchedProvince?.mergedIntoProvinceCode || matchedProvince?.code || null,
      mergedProvinceName: resolvedMergedProvinceName,
      isMergedProvince,
      detectedAddressTier,
      addressLine: rawAddressLine || null,
      fullFormattedAddress: threeTierPostMergerParts.join(', '),
      fullThreeTierPostMergerAddress: threeTierPostMergerParts.join(', '),
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
   * Tra cứu linh hoạt Tỉnh/Thành, Quận/Huyện, Phường/Xã, Thôn/Ấp từ mã code của cả 2 chế độ:
   * - Chế độ 3 Cấp Hành Chính (34 Tỉnh/Thành mới theo Nghị quyết 202/2025/QH15 - không cần `districtCode`)
   * - Chế độ 4 Cấp Hành Chính (63 Tỉnh/Thành, 704 Quận/Huyện/Đặc khu, 3.790+ Phường/Xã)
   */
  public resolveAdministrativeUnitsByCodes(params: {
    provinceCode?: string | null;
    districtCode?: string | null;
    wardCode?: string | null;
    hamletCode?: string | null;
    hamletName?: string | null;
  }): {
    province: VnProvinceUnitItem | null;
    district: VnDistrictUnitItem | null;
    ward: VnWardUnitItem | null;
    hamlet: VnHamletUnitItem | null;
  } {
    const { provinceCode, districtCode, wardCode, hamletCode } = params;

    let matchedWard: VnWardUnitItem | null = null;
    let matchedDist: VnDistrictUnitItem | null = null;
    let matchedProv: VnProvinceUnitItem | null = null;

    if (wardCode) {
      for (const p of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
        for (const d of p.districts) {
          const w = d.wards.find((item) => item.code === wardCode);
          if (w) {
            matchedWard = w;
            matchedDist = d;
            matchedProv = p;
            break;
          }
        }
        if (matchedWard) break;
      }

      if (!matchedWard) {
        for (const p34 of VN_CURRENT_34_PROVINCES_DICTIONARY) {
          const directList = getDirectWardsOfProvince(p34);
          const w = directList.find((item) => item.code === wardCode);
          if (w) {
            matchedWard = w;
            matchedProv = p34;
            if (w.legacyDistrictCode) {
              for (const p63 of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
                const d = p63.districts.find((item) => item.code === w.legacyDistrictCode);
                if (d) {
                  matchedDist = d;
                  break;
                }
              }
            }
            break;
          }
        }
      }
    }

    if (!matchedDist && districtCode) {
      for (const p of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
        const d = p.districts.find((item) => item.code === districtCode);
        if (d) {
          matchedDist = d;
          if (!matchedProv) matchedProv = p;
          break;
        }
      }
    }

    if (provinceCode) {
      const exact34 = VN_CURRENT_34_PROVINCES_DICTIONARY.find((p) => p.code === provinceCode);
      const exact63 = VN_ADMINISTRATIVE_UNITS_DICTIONARY.find((p) => p.code === provinceCode);
      if (exact63 && (!matchedProv || matchedProv.code === exact63.code)) {
        matchedProv = exact63;
      } else if (exact34 && !matchedProv) {
        matchedProv = exact34;
      }
    }

    const matchedHamlet =
      matchedWard && hamletCode
        ? matchedWard.hamlets?.find((h) => h.code === hamletCode) || null
        : null;

    return {
      province: matchedProv,
      district: matchedDist,
      ward: matchedWard,
      hamlet: matchedHamlet,
    };
  }

  /**
   * Bóc tách toàn diện Thực thể Thương mại Tiếng Việt:
   * - SĐT chống lách luật & tự động che PII
   * - Địa chỉ 3 cấp mới (34 Tỉnh/Thành không cấp huyện theo NQ 202/2025/QH15) & 4 cấp hành chính (63 Tỉnh/Thành, 704 Quận/Huyện/Đặc khu, 3.790+ Phường/Xã)
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

    // Bóc tách Số lượng đặt mua
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

    // Bóc tách Chiều cao & Cân nặng
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
      fullThreeTierPostMergerAddress: addressResolved.fullThreeTierPostMergerAddress,
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
   * - `ALL_63` (mặc định): Đầy đủ 63 Tỉnh/Thành phố, 704 Quận/Huyện/Thị xã/TP/Đặc khu, 3.790+ Phường/Xã & >28.500 Thôn/Ấp
   * - `CURRENT_34`: Danh sách 34 Tỉnh/Thành phố hiện tại sau sáp nhập (Nghị quyết 202/2025/QH15, Chinhphu.vn) kèm `directWards` không cấp huyện
   */
  public getAdministrativeTree(mode: 'ALL_63' | 'CURRENT_34' = 'ALL_63'): VnProvinceUnitItem[] {
    if (mode === 'CURRENT_34') {
      return VN_CURRENT_34_PROVINCES_DICTIONARY;
    }
    return VN_ADMINISTRATIVE_UNITS_DICTIONARY;
  }

  /**
   * Đối soát & đồng bộ trực tuyến từ điển hành chính 3 cấp (34 Tỉnh/Thành) & 4 cấp (63 Tỉnh/Thành)
   * với Open API Hành chính Việt Nam (`provinces.open-api.vn` v1/v2) và Master Data của GHN / GHTK / ViettelPost.
   */
  public async syncAdministrativeTreeWithOpenApisAndCarriers(
    options: MultiSourceAdminSyncOptions = {},
  ): Promise<MultiSourceAdminSyncReport> {
    return syncAdministrativeTreeFromOpenApisAndCarriers(options);
  }

  /**
   * Lấy danh sách đầy đủ Thôn / Ấp / Bản / Khu phố / Tổ dân phố / KĐT (45-65+ đơn vị cấp 4) của 1 Phường/Xã,
   * kết hợp truy vấn trực tuyến GHTK Level-4 Address API (`/services/address/getAddressLevel4`) và gợi ý thông minh.
   */
  public async getHamletsForWard(params: {
    wardCode?: string;
    searchQuery?: string;
    ghtkToken?: string;
  }): Promise<VnHamletUnitItem[]> {
    const resolved = this.resolveAdministrativeUnitsByCodes({
      wardCode: params.wardCode,
    });
    const ward = resolved.ward;
    if (!ward) {
      return params.searchQuery ? buildDynamicHamletSuggestions(params.searchQuery, null) : [];
    }
    const enriched = await fetchLiveFourthTierHamletsForWard({
      provinceName:
        resolved.province?.ghtkProvinceName || resolved.province?.name || 'Thành phố Hà Nội',
      districtName: resolved.district?.ghtkDistrictName || ward.legacyDistrictName || null,
      ward,
      ghtkToken: params.ghtkToken,
    });
    if (params.searchQuery && params.searchQuery.trim()) {
      const dynamicList = buildDynamicHamletSuggestions(params.searchQuery, ward);
      const seen = new Set(enriched.map((h) => this.stripDiacritics(h.name)));
      for (const d of dynamicList) {
        if (!seen.has(this.stripDiacritics(d.name))) {
          enriched.unshift(d);
        }
      }
    }
    return enriched;
  }
}
