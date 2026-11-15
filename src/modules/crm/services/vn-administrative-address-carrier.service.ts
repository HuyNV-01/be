import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';

import {
  BuildCarrierAddressPayloadDto,
  EstimateMultiCarrierShippingFeeDto,
  ResolveAdministrativeCrosswalkDto,
  SyncAdministrativeUnitsDto,
} from 'src/dto/crm/crm.dto';
import { CustomerProfileEntity } from 'src/entity/customer-profile.entity';
import { WarehouseEntity } from 'src/entity/warehouse.entity';
import { Repository } from 'typeorm';

import {
  MultiSourceAdminSyncReport,
  VN_ADMINISTRATIVE_UNITS_DICTIONARY,
  VN_CURRENT_34_PROVINCES_DICTIONARY,
  VnDistrictUnitItem,
  VnHamletUnitItem,
  VnProvinceUnitItem,
  VnWardUnitItem,
  buildDynamicHamletSuggestions,
  fetchLiveFourthTierHamletsForWard,
  getDirectWardsOfProvince,
  getHamletsOfWard,
  syncAdministrativeTreeFromOpenApisAndCarriers,
} from '../dictionaries/vn-administrative-units.constant';
import { PiiVaultAndAuditService } from './pii-vault-and-audit.service';
import { VietnameseCommerceNerService } from './vietnamese-commerce-ner.service';

export interface AdministrativeCrosswalkResult {
  preferredMode: '3_TIER' | '4_TIER';
  detectedInputTier: 3 | 4;
  isMergedProvince: boolean;
  threeTierAddress: {
    provinceCode: string;
    provinceName: string;
    resolutionNumber: string;
    ubtvqhResolutionNumber: string;
    adminCenterName: string;
    wardCode: string | null;
    wardName: string | null;
    wardUnitType: 'PHUONG' | 'XA' | 'DAC_KHU' | null;
    mergedFromWardNames: string[];
    hamletCode: string | null;
    hamletName: string | null;
    addressLine: string | null;
    fullFormattedAddress: string;
  };
  fourTierAddress: {
    provinceCode: string;
    provinceName: string;
    districtCode: string | null;
    districtName: string | null;
    wardCode: string | null;
    wardName: string | null;
    wardUnitType: 'PHUONG' | 'XA' | 'THI_TRAN' | 'DAC_KHU' | null;
    hamletCode: string | null;
    hamletName: string | null;
    addressLine: string | null;
    fullFormattedAddress: string;
  };
  carrierMapping: {
    ghn: {
      provinceId: number;
      districtId: number;
      wardCode: string;
      isReadyForShipment: boolean;
    };
    ghtk: {
      province: string;
      postMergerProvince: string;
      district: string;
      ward: string;
      hamlet: string;
      street: string;
      isReadyForShipment: boolean;
    };
    viettelPost: {
      provinceId: number;
      districtId: number;
      wardId: number;
      nlpThreeTierAddress: string;
      nlpFourTierAddress: string;
      isReadyForShipment: boolean;
    };
    jtExpress: {
      cityCode: string;
      postMergerCityCode: string;
      prov: string;
      city: string;
      area: string;
      address: string;
      isReadyForShipment: boolean;
    };
  };
  processingTimeMs: number;
}

export interface CarrierOrderPayloadBundleResult {
  senderCrosswalk: AdministrativeCrosswalkResult;
  receiverCrosswalk: AdministrativeCrosswalkResult;
  packageSpec: {
    weightGrams: number;
    chargeableWeightGrams: number;
    lengthCm: number;
    widthCm: number;
    heightCm: number;
    codAmount: number;
    insuranceValue: number;
  };
  carrierPayloads: {
    ghn: {
      endpoint: string;
      feeEndpoint: string;
      headers: { token: string; ShopId: string };
      orderBody: Record<string, unknown>;
      feeBody: Record<string, unknown>;
    };
    ghtk: {
      endpoint: string;
      feeEndpoint: string;
      level4Endpoint: string;
      headers: { Token: string };
      orderBody: Record<string, unknown>;
      feeQuery: Record<string, string | number>;
    };
    viettelPost: {
      endpoint: string;
      feeByIdEndpoint: string;
      feeByNlpEndpoint: string;
      headers: { Token: string };
      orderBody: Record<string, unknown>;
      feeByIdBody: Record<string, unknown>;
      feeByNlpBody: Record<string, unknown>;
    };
    jtExpress: {
      endpoint: string;
      feeEndpoint: string;
      orderBody: Record<string, unknown>;
    };
  };
}

export interface CarrierShippingQuoteItem {
  carrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT';
  carrierName: string;
  serviceCode: string;
  serviceName: string;
  totalFeeVnd: number;
  baseFeeVnd: number;
  insuranceFeeVnd: number;
  codFeeVnd: number;
  remoteAreaSurchargeVnd: number;
  estimatedDeliveryHours: number;
  estimatedDeliveryLabel: string;
  routeZoneType: 'INTRA_PROVINCE' | 'SAME_REGION' | 'CROSS_REGION' | 'ISLAND_SPECIAL_ZONE';
  quoteSource: 'LIVE_CARRIER_API' | 'CALIBRATED_RATE_TABLE';
  mappedAddressSummary: string;
  isRecommendedCheapest?: boolean;
  isRecommendedFastest?: boolean;
}

export interface MultiCarrierShippingFeeEstimateResult {
  routeZoneType: 'INTRA_PROVINCE' | 'SAME_REGION' | 'CROSS_REGION' | 'ISLAND_SPECIAL_ZONE';
  routeZoneLabel: string;
  chargeableWeightGrams: number;
  cheapestCarrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT';
  fastestCarrierCode: 'GHN' | 'GHTK' | 'VTP' | 'JT';
  quotes: CarrierShippingQuoteItem[];
  senderCrosswalk: AdministrativeCrosswalkResult;
  receiverCrosswalk: AdministrativeCrosswalkResult;
  evaluatedAt: string;
}

@Injectable()
export class VnAdministrativeAddressCarrierService {
  private readonly logger = new Logger(VnAdministrativeAddressCarrierService.name);

  constructor(
    @InjectRepository(CustomerProfileEntity)
    private readonly customerRepo: Repository<CustomerProfileEntity>,
    @InjectRepository(WarehouseEntity)
    private readonly warehouseRepo: Repository<WarehouseEntity>,
    private readonly nerService: VietnameseCommerceNerService,
    private readonly piiVaultService: PiiVaultAndAuditService,
  ) {}

  private stripDiacritics(input: string): string {
    return (input || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/gi, 'd')
      .toLowerCase()
      .trim();
  }

  private stripUnitPrefix(input: string): string {
    return (input || '')
      .replace(
        /^(Thành phố|Tỉnh|Quận|Huyện|Thị xã|Phường|Xã|Thị trấn|Đặc khu|Thôn|Ấp|Bản|Làng|Khu phố|Tổ dân phố|Khóm|Tiểu khu|Xóm)\s+/i,
        '',
      )
      .trim();
  }

  /**
   * Thống kê tổng quan & kiểm tra sức khỏe độ phủ ánh xạ vận chuyển của cả 2 cây hành chính:
   * - `3_TIER` (34 Tỉnh/Thành phố mới - 3.321 Phường/Xã/Đặc khu trực thuộc thẳng Tỉnh/Thành, 0 Quận/Huyện, 0 Thị trấn)
   * - `4_TIER` (63 Tỉnh/Thành phố - 704 Quận/Huyện/TX/TP/Đặc khu - 9.752+ Phường/Xã/Thị trấn - >537.000 Thôn/Ấp)
   */
  public getAdministrativeCoverageStats(): {
    threeTierStats: {
      totalProvinces34: number;
      totalDirectWards3321: number;
      totalSpecialZones: number;
      totalThiTranIn3Tier: number;
      hasDistrictLevelIn3Tier: boolean;
    };
    fourTierStats: {
      totalProvinces63: number;
      totalDistricts704: number;
      totalWards: number;
      emptyDistrictsCount: number;
      estimatedTotalHamlets: number;
    };
    carrierMappingCoveragePercent: {
      ghn: number;
      ghtk: number;
      viettelPost: number;
      jtExpress: number;
    };
  } {
    let totalDirectWards3321 = 0;
    let totalSpecialZones = 0;
    let totalThiTranIn3Tier = 0;

    for (const p34 of VN_CURRENT_34_PROVINCES_DICTIONARY) {
      const directList = getDirectWardsOfProvince(p34);
      totalDirectWards3321 += directList.length;
      for (const w of directList) {
        if (w.unitType === 'DAC_KHU' || /^Đặc khu\s+/i.test(w.name)) {
          totalSpecialZones += 1;
        }
        if (w.unitType === 'THI_TRAN' || /^Thị trấn\s+/i.test(w.name)) {
          totalThiTranIn3Tier += 1;
        }
      }
    }

    let totalDistricts704 = 0;
    let totalWards4Tier = 0;
    let emptyDistrictsCount = 0;
    let ghnMappedWards = 0;
    let ghtkMappedWards = 0;

    for (const p63 of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
      totalDistricts704 += p63.districts.length;
      for (const d of p63.districts) {
        if (!d.wards || d.wards.length === 0) {
          emptyDistrictsCount += 1;
        }
        totalWards4Tier += d.wards.length;
        for (const w of d.wards) {
          if (w.ghnWardCode) ghnMappedWards += 1;
          if (w.ghtkWardName) ghtkMappedWards += 1;
        }
      }
    }

    const ghnPct =
      totalWards4Tier > 0
        ? Math.min(100, Math.round((ghnMappedWards / totalWards4Tier) * 100))
        : 100;
    const ghtkPct =
      totalWards4Tier > 0
        ? Math.min(100, Math.round((ghtkMappedWards / totalWards4Tier) * 100))
        : 100;

    return {
      threeTierStats: {
        totalProvinces34: VN_CURRENT_34_PROVINCES_DICTIONARY.length,
        totalDirectWards3321,
        totalSpecialZones,
        totalThiTranIn3Tier,
        hasDistrictLevelIn3Tier: false,
      },
      fourTierStats: {
        totalProvinces63: VN_ADMINISTRATIVE_UNITS_DICTIONARY.length,
        totalDistricts704,
        totalWards: totalWards4Tier,
        emptyDistrictsCount,
        estimatedTotalHamlets: totalWards4Tier * 55,
      },
      carrierMappingCoveragePercent: {
        ghn: ghnPct,
        ghtk: ghtkPct,
        viettelPost: 100,
        jtExpress: 100,
      },
    };
  }

  /**
   * Tìm kiếm nhanh hợp nhất trên cả 2 chế độ 3 Cấp Mới (34 Tỉnh - 3.321 Phường/Xã/Đặc khu)
   * và 4 Cấp Cũ (63 Tỉnh - 704 Quận/Huyện - 9.752+ Phường/Xã/Thị trấn).
   */
  public searchAdministrativeUnitsFast(params: {
    query: string;
    mode?: '3_TIER' | '4_TIER' | 'BOTH';
    provinceCode?: string;
    limit?: number;
  }): Array<{
    tierMode: '3_TIER' | '4_TIER';
    provinceCode: string;
    provinceName: string;
    districtCode: string | null;
    districtName: string | null;
    wardCode: string;
    wardName: string;
    unitType: string;
    mergedFromWardNames?: string[];
    mergedIntoNewWardName?: string | null;
    ghnProvinceId: number;
    ghnDistrictId: number;
    ghnWardCode: string;
    ghtkProvinceName: string;
    ghtkDistrictName: string;
    ghtkWardName: string;
    displayLabel: string;
  }> {
    const qNorm = this.stripDiacritics(params.query || '');
    const mode = params.mode || 'BOTH';
    const maxItems = Math.min(100, Math.max(5, Number(params.limit || 30)));
    const results: Array<{
      tierMode: '3_TIER' | '4_TIER';
      provinceCode: string;
      provinceName: string;
      districtCode: string | null;
      districtName: string | null;
      wardCode: string;
      wardName: string;
      unitType: string;
      mergedFromWardNames?: string[];
      mergedIntoNewWardName?: string | null;
      ghnProvinceId: number;
      ghnDistrictId: number;
      ghnWardCode: string;
      ghtkProvinceName: string;
      ghtkDistrictName: string;
      ghtkWardName: string;
      displayLabel: string;
    }> = [];

    // 1. Tìm trong cây 3 Cấp Mới (34 Tỉnh/Thành - 3.321 Phường/Xã/Đặc khu, không cấp huyện)
    if (mode === '3_TIER' || mode === 'BOTH') {
      for (const p34 of VN_CURRENT_34_PROVINCES_DICTIONARY) {
        if (params.provinceCode && p34.code !== params.provinceCode) continue;
        const directList = getDirectWardsOfProvince(p34);
        for (const w of directList) {
          if (results.length >= maxItems) break;
          const haystack = this.stripDiacritics(
            `${w.name} ${(w.mergedFromWardNames || []).join(' ')} ${w.legacyDistrictName || ''} ${w.legacyProvinceName || ''} ${p34.name} ${w.code}`,
          );
          if (!qNorm || haystack.includes(qNorm)) {
            results.push({
              tierMode: '3_TIER',
              provinceCode: p34.code,
              provinceName: p34.name,
              districtCode: w.legacyDistrictCode || null,
              districtName: w.legacyDistrictName || null,
              wardCode: w.code,
              wardName: w.name,
              unitType: w.unitType || 'XA',
              mergedFromWardNames: w.mergedFromWardNames || [],
              mergedIntoNewWardName: w.name,
              ghnProvinceId: w.ghnProvinceId || p34.ghnProvinceId,
              ghnDistrictId: w.ghnDistrictId || p34.districts[0]?.ghnDistrictId || 1500,
              ghnWardCode: w.ghnWardCode,
              ghtkProvinceName: w.ghtkProvinceName || p34.ghtkProvinceName,
              ghtkDistrictName: w.ghtkDistrictName || w.legacyDistrictName || p34.name,
              ghtkWardName: w.ghtkWardName || w.name,
              displayLabel: `${w.name}, ${p34.name}`,
            });
          }
        }
      }
    }

    // 2. Tìm trong cây 4 Cấp Cũ (63 Tỉnh/Thành - 704 Quận/Huyện - 9.752+ Phường/Xã/Thị trấn)
    if ((mode === '4_TIER' || mode === 'BOTH') && results.length < maxItems) {
      for (const p63 of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
        if (params.provinceCode && p63.code !== params.provinceCode) continue;
        for (const dist of p63.districts) {
          for (const w of dist.wards) {
            if (results.length >= maxItems) break;
            const haystack = this.stripDiacritics(
              `${w.name} ${dist.name} ${p63.name} ${w.mergedIntoNewWardName || ''} ${w.code}`,
            );
            if (!qNorm || haystack.includes(qNorm)) {
              results.push({
                tierMode: '4_TIER',
                provinceCode: p63.code,
                provinceName: p63.name,
                districtCode: dist.code,
                districtName: dist.name,
                wardCode: w.code,
                wardName: w.name,
                unitType: w.unitType || 'XA',
                mergedFromWardNames: w.mergedFromWardNames,
                mergedIntoNewWardName: w.mergedIntoNewWardName || null,
                ghnProvinceId: p63.ghnProvinceId,
                ghnDistrictId: dist.ghnDistrictId,
                ghnWardCode: w.ghnWardCode,
                ghtkProvinceName: p63.ghtkProvinceName,
                ghtkDistrictName: dist.ghtkDistrictName,
                ghtkWardName: w.ghtkWardName || w.name,
                displayLabel: `${w.name}, ${dist.name}, ${p63.name}`,
              });
            }
          }
        }
      }
    }

    return results;
  }

  /**
   * Động cơ Ánh xạ Chéo Hai Chiều (`Bidirectional 3-Tier <-> 4-Tier Crosswalk Engine`):
   * - Cho phép truyền vào địa chỉ ở chế độ 3 Cấp Mới (không có Quận/Huyện) hoặc 4 Cấp Cũ (có Quận/Huyện) hoặc chuỗi văn bản tự do.
   * - Tự động suy diễn và trả về đầy đủ cả `threeTierAddress`, `fourTierAddress` và bộ `carrierMapping` (GHN, GHTK Level-4, ViettelPost, J&T Express).
   */
  public resolveBidirectionalAddressCrosswalk(
    dto: ResolveAdministrativeCrosswalkDto,
  ): AdministrativeCrosswalkResult {
    const startTime = performance.now();
    const preferredMode = dto.preferredMode === '4_TIER' ? '4_TIER' : '3_TIER';

    let provinceCode = dto.provinceCode || null;
    let districtCode = dto.districtCode || null;
    let wardCode = dto.wardCode || null;
    let hamletCode = dto.hamletCode || null;
    let hamletName = dto.hamletName || null;
    let addressLine = dto.addressLine || null;
    let detectedInputTier: 3 | 4 = districtCode ? 4 : 3;

    // Nếu người dùng truyền vào câu địa chỉ tự do `rawText`, bóc tách tự động qua NER trước
    if (dto.rawText && dto.rawText.trim()) {
      const nerAddr = this.nerService.resolveFourTierVietnameseAddress(dto.rawText);
      if (nerAddr.hasAddressDetected) {
        provinceCode = provinceCode || nerAddr.province?.code || null;
        districtCode = districtCode || nerAddr.district?.code || null;
        wardCode = wardCode || nerAddr.ward?.code || null;
        hamletCode = hamletCode || nerAddr.hamlet?.code || null;
        hamletName = hamletName || nerAddr.hamlet?.name || null;
        addressLine = addressLine || nerAddr.addressLine || null;
        detectedInputTier = nerAddr.detectedAddressTier || (districtCode ? 4 : 3);
      }
    }

    let postMergerProv: VnProvinceUnitItem | null = null;
    let postMergerWard: VnWardUnitItem | null = null;
    let legacyProv: VnProvinceUnitItem | null = null;
    let legacyDist: VnDistrictUnitItem | null = null;
    let legacyWard: VnWardUnitItem | null = null;

    // Bước 1: Giải mã từ `wardCode` nếu có (tra trên cả cây 34 tỉnh mới và cây 63 tỉnh cũ)
    if (wardCode) {
      for (const p34 of VN_CURRENT_34_PROVINCES_DICTIONARY) {
        const directWards = getDirectWardsOfProvince(p34);
        const found34 = directWards.find((w) => w.code === wardCode);
        if (found34) {
          postMergerProv = p34;
          postMergerWard = found34;
          legacyProv =
            (found34.legacyProvinceCode &&
              VN_ADMINISTRATIVE_UNITS_DICTIONARY.find(
                (p) => p.code === found34.legacyProvinceCode,
              )) ||
            VN_ADMINISTRATIVE_UNITS_DICTIONARY.find((p) => p.code === p34.code) ||
            null;
          legacyDist =
            (legacyProv &&
              found34.legacyDistrictCode &&
              legacyProv.districts.find((d) => d.code === found34.legacyDistrictCode)) ||
            legacyProv?.districts[0] ||
            null;
          legacyWard =
            (legacyDist &&
              legacyDist.wards.find(
                (lw) =>
                  lw.mergedIntoNewWardCode === found34.code ||
                  this.stripDiacritics(this.stripUnitPrefix(lw.name)) ===
                    this.stripDiacritics(this.stripUnitPrefix(found34.name)),
              )) ||
            legacyDist?.wards[0] ||
            null;
          break;
        }
      }

      if (!postMergerWard) {
        for (const p63 of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
          for (const d of p63.districts) {
            const found63 = d.wards.find((w) => w.code === wardCode);
            if (found63) {
              legacyProv = p63;
              legacyDist = d;
              legacyWard = found63;
              const targetCode34 = p63.mergedIntoProvinceCode || p63.code;
              postMergerProv =
                VN_CURRENT_34_PROVINCES_DICTIONARY.find((p) => p.code === targetCode34) || p63;
              const pmList = getDirectWardsOfProvince(postMergerProv);
              postMergerWard =
                (found63.mergedIntoNewWardCode &&
                  pmList.find((pw) => pw.code === found63.mergedIntoNewWardCode)) ||
                pmList.find(
                  (pw) =>
                    this.stripDiacritics(this.stripUnitPrefix(pw.name)) ===
                      this.stripDiacritics(this.stripUnitPrefix(found63.name)) ||
                    (Array.isArray(pw.mergedFromWardNames) &&
                      pw.mergedFromWardNames.some(
                        (mfn) =>
                          this.stripDiacritics(this.stripUnitPrefix(mfn)) ===
                          this.stripDiacritics(this.stripUnitPrefix(found63.name)),
                      )),
                ) ||
                pmList[0] ||
                null;
              break;
            }
          }
          if (legacyWard) break;
        }
      }
    }

    // Bước 2: Giải mã từ `districtCode` nếu chưa tìm thấy qua `wardCode`
    if (!legacyDist && districtCode) {
      for (const p63 of VN_ADMINISTRATIVE_UNITS_DICTIONARY) {
        const d = p63.districts.find((item) => item.code === districtCode);
        if (d) {
          legacyProv = p63;
          legacyDist = d;
          legacyWard = legacyWard || d.wards[0] || null;
          break;
        }
      }
    }

    // Bước 3: Giải mã từ `provinceCode`
    if (!legacyProv && provinceCode) {
      legacyProv =
        VN_ADMINISTRATIVE_UNITS_DICTIONARY.find((p) => p.code === provinceCode) ||
        VN_CURRENT_34_PROVINCES_DICTIONARY.find((p) => p.code === provinceCode) ||
        VN_ADMINISTRATIVE_UNITS_DICTIONARY[0];
    }
    if (!legacyProv) {
      legacyProv = VN_ADMINISTRATIVE_UNITS_DICTIONARY[0];
    }

    const mergedTargetCode = legacyProv.mergedIntoProvinceCode || legacyProv.code;
    if (!postMergerProv) {
      postMergerProv =
        VN_CURRENT_34_PROVINCES_DICTIONARY.find((p) => p.code === mergedTargetCode) || legacyProv;
    }
    if (!legacyDist) {
      legacyDist = legacyProv.districts[0] || null;
    }
    if (!legacyWard && legacyDist) {
      legacyWard = legacyDist.wards[0] || null;
    }
    if (!postMergerWard && postMergerProv) {
      const pmList = getDirectWardsOfProvince(postMergerProv);
      postMergerWard =
        (legacyWard?.mergedIntoNewWardCode &&
          pmList.find((pw) => pw.code === legacyWard!.mergedIntoNewWardCode)) ||
        (legacyWard &&
          pmList.find(
            (pw) =>
              this.stripDiacritics(this.stripUnitPrefix(pw.name)) ===
              this.stripDiacritics(this.stripUnitPrefix(legacyWard!.name)),
          )) ||
        pmList[0] ||
        null;
    }

    // Bước 4: Khớp hoặc khởi tạo Thôn/Ấp/Khu phố/Tổ dân phố (Cấp 3 của 3_TIER / Cấp 4 của 4_TIER)
    const activeWardForHamlet = postMergerWard || legacyWard;
    const wardHamlets = activeWardForHamlet
      ? getHamletsOfWard(activeWardForHamlet, postMergerProv.region || 'BAC_BO')
      : [];

    let matchedHamlet: VnHamletUnitItem | null = null;
    if (hamletCode) {
      matchedHamlet = wardHamlets.find((h) => h.code === hamletCode) || null;
    }
    if (!matchedHamlet && hamletName) {
      const normH = this.stripDiacritics(hamletName);
      matchedHamlet =
        wardHamlets.find((h) => this.stripDiacritics(h.name) === normH) ||
        buildDynamicHamletSuggestions(hamletName, activeWardForHamlet)[0] ||
        null;
    }

    const resolvedHamletCode = matchedHamlet?.code || hamletCode || null;
    const resolvedHamletName = matchedHamlet?.name || hamletName || null;
    const cleanAddressLine = (addressLine || '').trim() || null;

    // Chuỗi địa chỉ chuẩn 3 Cấp Mới (Không có Quận/Huyện, không còn Thị trấn)
    const threeTierParts = [
      cleanAddressLine,
      resolvedHamletName,
      postMergerWard?.name || null,
      postMergerProv.name,
    ].filter((part): part is string => Boolean(part && part.trim()));

    // Chuỗi địa chỉ chuẩn 4 Cấp Cũ (Đầy đủ Số nhà -> Thôn/Ấp -> Phường/Xã/Thị trấn -> Quận/Huyện -> Tỉnh/Thành)
    const fourTierParts = [
      cleanAddressLine,
      resolvedHamletName,
      legacyWard?.name || postMergerWard?.name || null,
      legacyDist?.name || postMergerWard?.legacyDistrictName || null,
      legacyProv.name,
    ].filter((part): part is string => Boolean(part && part.trim()));

    const ghnProvinceId =
      postMergerWard?.ghnProvinceId ||
      legacyProv.ghnProvinceId ||
      postMergerProv.ghnProvinceId ||
      201;
    const ghnDistrictId = legacyDist?.ghnDistrictId || postMergerWard?.ghnDistrictId || 1482;
    const ghnWardCode = legacyWard?.ghnWardCode || postMergerWard?.ghnWardCode || '1A0101';

    const ghtkProvince =
      legacyProv.ghtkProvinceName || postMergerProv.ghtkProvinceName || legacyProv.name;
    const ghtkDistrict =
      legacyDist?.ghtkDistrictName ||
      postMergerWard?.legacyDistrictName ||
      legacyDist?.name ||
      'Quận Trung Tâm';
    const ghtkWard =
      legacyWard?.ghtkWardName || postMergerWard?.ghtkWardName || legacyWard?.name || 'Phường 1';
    const ghtkHamlet =
      matchedHamlet?.ghtkHamletName || resolvedHamletName || cleanAddressLine || 'Khác';

    const vtpProvinceId = legacyProv.vtpProvinceId || postMergerProv.vtpProvinceId || 1;
    const vtpDistrictId = ghnDistrictId;
    const vtpWardId = Number(String(ghnWardCode).replace(/\D/g, '').slice(0, 6) || 101);

    const isMergedProvince = Boolean(
      legacyProv.mergedIntoProvinceCode && legacyProv.mergedIntoProvinceCode !== legacyProv.code,
    );

    const processingTimeMs = Number((performance.now() - startTime).toFixed(2));

    return {
      preferredMode,
      detectedInputTier,
      isMergedProvince,
      threeTierAddress: {
        provinceCode: postMergerProv.code,
        provinceName: postMergerProv.name,
        resolutionNumber: postMergerProv.resolutionNumber || 'Nghị quyết 202/2025/QH15',
        ubtvqhResolutionNumber: postMergerProv.ubtvqhResolutionNumber || 'NQ-UBTVQH15 (2025)',
        adminCenterName: postMergerProv.adminCenterName || postMergerProv.name,
        wardCode: postMergerWard?.code || null,
        wardName: postMergerWard?.name || null,
        wardUnitType:
          postMergerWard?.unitType === 'DAC_KHU'
            ? 'DAC_KHU'
            : postMergerWard?.unitType === 'PHUONG'
              ? 'PHUONG'
              : 'XA',
        mergedFromWardNames:
          postMergerWard?.mergedFromWardNames || (legacyWard ? [legacyWard.name] : []),
        hamletCode: resolvedHamletCode,
        hamletName: resolvedHamletName,
        addressLine: cleanAddressLine,
        fullFormattedAddress: threeTierParts.join(', '),
      },
      fourTierAddress: {
        provinceCode: legacyProv.code,
        provinceName: legacyProv.name,
        districtCode: legacyDist?.code || null,
        districtName: legacyDist?.name || null,
        wardCode: legacyWard?.code || null,
        wardName: legacyWard?.name || null,
        wardUnitType: legacyWard?.unitType || 'XA',
        hamletCode: resolvedHamletCode,
        hamletName: resolvedHamletName,
        addressLine: cleanAddressLine,
        fullFormattedAddress: fourTierParts.join(', '),
      },
      carrierMapping: {
        ghn: {
          provinceId: ghnProvinceId,
          districtId: ghnDistrictId,
          wardCode: ghnWardCode,
          isReadyForShipment: Boolean(ghnProvinceId && ghnDistrictId && ghnWardCode),
        },
        ghtk: {
          province: ghtkProvince,
          postMergerProvince: postMergerProv.ghtkProvinceName || postMergerProv.name,
          district: ghtkDistrict,
          ward: ghtkWard,
          hamlet: ghtkHamlet,
          street: cleanAddressLine || ghtkHamlet,
          isReadyForShipment: Boolean(ghtkProvince && ghtkDistrict && ghtkWard && ghtkHamlet),
        },
        viettelPost: {
          provinceId: vtpProvinceId,
          districtId: vtpDistrictId,
          wardId: vtpWardId,
          nlpThreeTierAddress: threeTierParts.join(', '),
          nlpFourTierAddress: fourTierParts.join(', '),
          isReadyForShipment: true,
        },
        jtExpress: {
          cityCode: legacyProv.jtCityCode || 'HNI',
          postMergerCityCode: postMergerProv.jtCityCode || 'HNI',
          prov: ghtkProvince,
          city: ghtkDistrict,
          area: ghtkWard,
          address: [cleanAddressLine, resolvedHamletName].filter(Boolean).join(', ') || ghtkWard,
          isReadyForShipment: true,
        },
      },
      processingTimeMs,
    };
  }

  /**
   * Chuẩn hóa và sinh bộ Payload JSON kết nối trực tiếp tới 4 Đơn vị Vận chuyển (`GHN`, `GHTK`, `ViettelPost`, `J&T Express`).
   * Hỗ trợ giải mã SĐT khách hàng trong RAM từ `PII Vault` nếu truyền `customerId` mà không làm lộ SĐT trần ra ngoài.
   */
  public async buildMultiCarrierOrderPayloads(
    shopId: string,
    dto: BuildCarrierAddressPayloadDto,
  ): Promise<CarrierOrderPayloadBundleResult> {
    // 1. Lấy địa chỉ kho mặc định của cửa hàng nếu chưa truyền địa chỉ người gửi
    let senderProvinceCode = dto.senderProvinceCode || '01';
    let senderDistrictCode = dto.senderDistrictCode || null;
    let senderWardCode = dto.senderWardCode || null;
    let senderAddressLine = dto.senderAddressLine || 'Kho Tổng Cửa Hàng';

    if (!dto.senderProvinceCode && !dto.senderWardCode) {
      const defaultWarehouse = await this.warehouseRepo
        .findOne({ where: { shopId, isDefault: true } })
        .catch(() => null);
      if (defaultWarehouse) {
        senderProvinceCode = defaultWarehouse.provinceCode || '01';
        senderDistrictCode = defaultWarehouse.districtCode || null;
        senderWardCode = defaultWarehouse.wardCode || null;
        senderAddressLine = defaultWarehouse.addressLine || defaultWarehouse.name;
      }
    }

    // 2. Lấy địa chỉ & SĐT khách nhận từ Hồ sơ CRM 360 nếu truyền `customerId`
    let receiverName = dto.receiverName || 'Khách hàng';
    let receiverPhoneMaskedOrInternal = dto.receiverPhone || '098***678';
    let receiverProvinceCode = dto.receiverProvinceCode || null;
    let receiverDistrictCode = dto.receiverDistrictCode || null;
    let receiverWardCode = dto.receiverWardCode || null;
    let receiverHamletCode = dto.receiverHamletCode || null;
    let receiverHamletName = dto.receiverHamletName || null;
    let receiverAddressLine = dto.receiverAddressLine || null;

    if (dto.customerId) {
      const customer = await this.customerRepo.findOne({
        where: { id: dto.customerId, shopId },
      });
      if (customer) {
        receiverName = dto.receiverName || customer.fullName || 'Khách hàng';
        receiverPhoneMaskedOrInternal = dto.receiverPhone || customer.phoneMasked || '098***678';
        receiverProvinceCode = receiverProvinceCode || customer.defaultProvinceCode;
        receiverDistrictCode = receiverDistrictCode || customer.defaultDistrictCode;
        receiverWardCode = receiverWardCode || customer.defaultWardCode;
        receiverHamletCode = receiverHamletCode || customer.defaultHamletCode;
        receiverHamletName = receiverHamletName || customer.defaultHamletName;
        receiverAddressLine = receiverAddressLine || customer.defaultAddressLine;
      }
    }

    const senderCrosswalk = this.resolveBidirectionalAddressCrosswalk({
      preferredMode: '3_TIER',
      provinceCode: senderProvinceCode,
      districtCode: senderDistrictCode,
      wardCode: senderWardCode,
      addressLine: senderAddressLine,
    });

    const receiverCrosswalk = this.resolveBidirectionalAddressCrosswalk({
      preferredMode: '3_TIER',
      provinceCode: receiverProvinceCode || '79',
      districtCode: receiverDistrictCode,
      wardCode: receiverWardCode,
      hamletCode: receiverHamletCode,
      hamletName: receiverHamletName,
      addressLine: receiverAddressLine,
    });

    const weightGrams = Math.max(50, Number(dto.weightGrams || 500));
    const lengthCm = Math.max(1, Number(dto.lengthCm || 20));
    const widthCm = Math.max(1, Number(dto.widthCm || 15));
    const heightCm = Math.max(1, Number(dto.heightCm || 10));
    const volumetricWeightGrams = Math.round(((lengthCm * widthCm * heightCm) / 5000) * 1000);
    const chargeableWeightGrams = Math.max(weightGrams, volumetricWeightGrams);
    const codAmount = Math.max(0, Number(dto.codAmount || 0));
    const insuranceValue = Math.max(0, Number(dto.insuranceValue ?? 350000));

    return {
      senderCrosswalk,
      receiverCrosswalk,
      packageSpec: {
        weightGrams,
        chargeableWeightGrams,
        lengthCm,
        widthCm,
        heightCm,
        codAmount,
        insuranceValue,
      },
      carrierPayloads: {
        ghn: {
          endpoint: 'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/create',
          feeEndpoint: 'https://online-gateway.ghn.vn/shiip/public-api/v2/shipping-order/fee',
          headers: {
            token: '<GHN_API_TOKEN>',
            ShopId: '<GHN_SHOP_ID>',
          },
          orderBody: {
            payment_type_id: codAmount > 0 ? 2 : 1,
            required_note: 'CHOXEMHANGKHONGTHU',
            from_name: 'Cửa Hàng Pancake Seller OS',
            from_address: senderCrosswalk.fourTierAddress.fullFormattedAddress,
            from_ward_name: senderCrosswalk.fourTierAddress.wardName,
            from_district_name: senderCrosswalk.fourTierAddress.districtName,
            from_province_name: senderCrosswalk.fourTierAddress.provinceName,
            to_name: receiverName,
            to_phone: receiverPhoneMaskedOrInternal,
            to_address: receiverCrosswalk.threeTierAddress.fullFormattedAddress,
            to_ward_code: receiverCrosswalk.carrierMapping.ghn.wardCode,
            to_district_id: receiverCrosswalk.carrierMapping.ghn.districtId,
            cod_amount: codAmount,
            insurance_value: insuranceValue,
            weight: weightGrams,
            length: lengthCm,
            width: widthCm,
            height: heightCm,
            service_type_id: 2,
          },
          feeBody: {
            service_type_id: 2,
            from_district_id: senderCrosswalk.carrierMapping.ghn.districtId,
            from_ward_code: senderCrosswalk.carrierMapping.ghn.wardCode,
            to_district_id: receiverCrosswalk.carrierMapping.ghn.districtId,
            to_ward_code: receiverCrosswalk.carrierMapping.ghn.wardCode,
            weight: weightGrams,
            length: lengthCm,
            width: widthCm,
            height: heightCm,
            insurance_value: insuranceValue,
            coupon: null,
          },
        },
        ghtk: {
          endpoint: 'https://services.giaohangtietkiem.vn/services/shipment/order',
          feeEndpoint: 'https://services.giaohangtietkiem.vn/services/shipment/fee',
          level4Endpoint: 'https://services.giaohangtietkiem.vn/services/address/getAddressLevel4',
          headers: {
            Token: '<GHTK_API_TOKEN>',
          },
          orderBody: {
            products: [
              {
                name: 'Đơn hàng Thương mại Đa kênh',
                weight: Number((weightGrams / 1000).toFixed(2)),
                quantity: 1,
              },
            ],
            order: {
              id: `ORD_${Date.now()}`,
              pick_name: 'Kho Cửa Hàng',
              pick_address: senderCrosswalk.carrierMapping.ghtk.street,
              pick_province: senderCrosswalk.carrierMapping.ghtk.province,
              pick_district: senderCrosswalk.carrierMapping.ghtk.district,
              pick_ward: senderCrosswalk.carrierMapping.ghtk.ward,
              name: receiverName,
              tel: receiverPhoneMaskedOrInternal,
              address: receiverCrosswalk.carrierMapping.ghtk.street,
              province: receiverCrosswalk.carrierMapping.ghtk.province,
              district: receiverCrosswalk.carrierMapping.ghtk.district,
              ward: receiverCrosswalk.carrierMapping.ghtk.ward,
              hamlet: receiverCrosswalk.carrierMapping.ghtk.hamlet,
              is_freeship: codAmount > 0 ? 0 : 1,
              pick_money: codAmount,
              value: insuranceValue,
              transport: 'road',
            },
          },
          feeQuery: {
            pick_province: senderCrosswalk.carrierMapping.ghtk.province,
            pick_district: senderCrosswalk.carrierMapping.ghtk.district,
            pick_ward: senderCrosswalk.carrierMapping.ghtk.ward,
            province: receiverCrosswalk.carrierMapping.ghtk.province,
            district: receiverCrosswalk.carrierMapping.ghtk.district,
            ward: receiverCrosswalk.carrierMapping.ghtk.ward,
            address: receiverCrosswalk.carrierMapping.ghtk.hamlet,
            weight: weightGrams,
            value: insuranceValue,
            transport: 'road',
          },
        },
        viettelPost: {
          endpoint: 'https://partner.viettelpost.vn/v2/order/createOrder',
          feeByIdEndpoint: 'https://partner.viettelpost.vn/v2/order/getPriceAll',
          feeByNlpEndpoint: 'https://partner.viettelpost.vn/v2/order/getPriceAllNlp',
          headers: {
            Token: '<VIETTELPOST_API_TOKEN>',
          },
          orderBody: {
            ORDER_NUMBER: `VTP_${Date.now()}`,
            SENDER_FULLNAME: 'Kho Cửa Hàng',
            SENDER_ADDRESS: senderCrosswalk.carrierMapping.viettelPost.nlpFourTierAddress,
            SENDER_PROVINCE: senderCrosswalk.carrierMapping.viettelPost.provinceId,
            SENDER_DISTRICT: senderCrosswalk.carrierMapping.viettelPost.districtId,
            SENDER_WARD: senderCrosswalk.carrierMapping.viettelPost.wardId,
            RECEIVER_FULLNAME: receiverName,
            RECEIVER_PHONE: receiverPhoneMaskedOrInternal,
            RECEIVER_ADDRESS: receiverCrosswalk.carrierMapping.viettelPost.nlpThreeTierAddress,
            RECEIVER_PROVINCE: receiverCrosswalk.carrierMapping.viettelPost.provinceId,
            RECEIVER_DISTRICT: receiverCrosswalk.carrierMapping.viettelPost.districtId,
            RECEIVER_WARD: receiverCrosswalk.carrierMapping.viettelPost.wardId,
            PRODUCT_TYPE: 'HH',
            ORDER_PAYMENT: codAmount > 0 ? 3 : 1,
            ORDER_SERVICE: 'VCN',
            PRODUCT_WEIGHT: weightGrams,
            PRODUCT_PRICE: insuranceValue,
            MONEY_COLLECTION: codAmount,
            PRODUCT_LENGTH: lengthCm,
            PRODUCT_WIDTH: widthCm,
            PRODUCT_HEIGHT: heightCm,
          },
          feeByIdBody: {
            SENDER_PROVINCE: senderCrosswalk.carrierMapping.viettelPost.provinceId,
            SENDER_DISTRICT: senderCrosswalk.carrierMapping.viettelPost.districtId,
            RECEIVER_PROVINCE: receiverCrosswalk.carrierMapping.viettelPost.provinceId,
            RECEIVER_DISTRICT: receiverCrosswalk.carrierMapping.viettelPost.districtId,
            PRODUCT_TYPE: 'HH',
            PRODUCT_WEIGHT: weightGrams,
            PRODUCT_PRICE: insuranceValue,
            MONEY_COLLECTION: String(codAmount),
            PRODUCT_LENGTH: lengthCm,
            PRODUCT_WIDTH: widthCm,
            PRODUCT_HEIGHT: heightCm,
            TYPE: 1,
          },
          feeByNlpBody: {
            SENDER_ADDRESS: senderCrosswalk.carrierMapping.viettelPost.nlpThreeTierAddress,
            RECEIVER_ADDRESS: receiverCrosswalk.carrierMapping.viettelPost.nlpThreeTierAddress,
            PRODUCT_TYPE: 'HH',
            PRODUCT_WEIGHT: weightGrams,
            PRODUCT_PRICE: insuranceValue,
            MONEY_COLLECTION: String(codAmount),
            PRODUCT_LENGTH: lengthCm,
            PRODUCT_WIDTH: widthCm,
            PRODUCT_HEIGHT: heightCm,
            TYPE: 1,
          },
        },
        jtExpress: {
          endpoint: 'https://openapi.jtexpress.vn/webopenplatformapi/api/order/addOrder',
          feeEndpoint: 'https://openapi.jtexpress.vn/webopenplatformapi/api/order/getFreight',
          orderBody: {
            txlogisticId: `JT_${Date.now()}`,
            expressType: 'EZ',
            serviceType: '1',
            payType: 'PP_PM',
            sender: {
              name: 'Kho Cửa Hàng',
              prov: senderCrosswalk.carrierMapping.jtExpress.prov,
              city: senderCrosswalk.carrierMapping.jtExpress.city,
              area: senderCrosswalk.carrierMapping.jtExpress.area,
              address: senderCrosswalk.carrierMapping.jtExpress.address,
            },
            receiver: {
              name: receiverName,
              mobile: receiverPhoneMaskedOrInternal,
              prov: receiverCrosswalk.carrierMapping.jtExpress.prov,
              city: receiverCrosswalk.carrierMapping.jtExpress.city,
              area: receiverCrosswalk.carrierMapping.jtExpress.area,
              address: receiverCrosswalk.carrierMapping.jtExpress.address,
            },
            itemsValue: insuranceValue,
            weight: Number((weightGrams / 1000).toFixed(2)),
          },
        },
      },
    };
  }

  /**
   * Ước tính và so sánh cước phí vận chuyển đa hãng (`GHN`, `GHTK`, `ViettelPost`, `J&T Express`)
   * từ địa chỉ 3 cấp mới hoặc 4 cấp cũ.
   */
  public async estimateMultiCarrierShippingFee(
    shopId: string,
    dto: EstimateMultiCarrierShippingFeeDto,
  ): Promise<MultiCarrierShippingFeeEstimateResult> {
    const bundle = await this.buildMultiCarrierOrderPayloads(shopId, dto);
    const { senderCrosswalk, receiverCrosswalk, packageSpec } = bundle;

    const senderProv34 = senderCrosswalk.threeTierAddress.provinceCode;
    const receiverProv34 = receiverCrosswalk.threeTierAddress.provinceCode;
    const isIslandSpecialZone =
      receiverCrosswalk.threeTierAddress.wardUnitType === 'DAC_KHU' ||
      /^(Đặc khu|Huyện đảo)\s+/i.test(receiverCrosswalk.threeTierAddress.wardName || '');

    const senderProvObj = VN_CURRENT_34_PROVINCES_DICTIONARY.find((p) => p.code === senderProv34);
    const receiverProvObj = VN_CURRENT_34_PROVINCES_DICTIONARY.find(
      (p) => p.code === receiverProv34,
    );

    let routeZoneType: 'INTRA_PROVINCE' | 'SAME_REGION' | 'CROSS_REGION' | 'ISLAND_SPECIAL_ZONE' =
      'CROSS_REGION';
    let routeZoneLabel = 'Liên miền (Bắc — Trung — Nam)';

    if (isIslandSpecialZone) {
      routeZoneType = 'ISLAND_SPECIAL_ZONE';
      routeZoneLabel = 'Tuyến Đặc khu / Hải đảo';
    } else if (senderProv34 === receiverProv34) {
      routeZoneType = 'INTRA_PROVINCE';
      routeZoneLabel = `Nội tỉnh / Nội thành (${receiverCrosswalk.threeTierAddress.provinceName})`;
    } else if (
      senderProvObj?.region &&
      receiverProvObj?.region &&
      senderProvObj.region === receiverProvObj.region
    ) {
      routeZoneType = 'SAME_REGION';
      routeZoneLabel = `Nội miền (${receiverProvObj.region})`;
    }

    const extraHalfKgSteps = Math.max(
      0,
      Math.ceil((packageSpec.chargeableWeightGrams - 500) / 500),
    );
    const stepCostPer500g =
      routeZoneType === 'INTRA_PROVINCE'
        ? 2500
        : routeZoneType === 'SAME_REGION'
          ? 4000
          : routeZoneType === 'ISLAND_SPECIAL_ZONE'
            ? 8500
            : 5500;

    const insuranceFee =
      packageSpec.insuranceValue > 1_000_000 ? Math.round(packageSpec.insuranceValue * 0.005) : 0;
    const islandSurcharge = routeZoneType === 'ISLAND_SPECIAL_ZONE' ? 25000 : 0;

    const baseByZone = {
      INTRA_PROVINCE: { ghn: 16500, ghtk: 18000, vtp: 15500, jt: 16000 },
      SAME_REGION: { ghn: 24000, ghtk: 23000, vtp: 22500, jt: 23500 },
      CROSS_REGION: { ghn: 32000, ghtk: 30000, vtp: 31000, jt: 29500 },
      ISLAND_SPECIAL_ZONE: { ghn: 42000, ghtk: 45000, vtp: 38000, jt: 44000 },
    }[routeZoneType];

    const etaByZone = {
      INTRA_PROVINCE: { ghn: 12, ghtk: 10, vtp: 16, jt: 14 },
      SAME_REGION: { ghn: 24, ghtk: 24, vtp: 30, jt: 28 },
      CROSS_REGION: { ghn: 48, ghtk: 42, vtp: 54, jt: 48 },
      ISLAND_SPECIAL_ZONE: { ghn: 72, ghtk: 72, vtp: 64, jt: 80 },
    }[routeZoneType];

    // Thử gọi trực tuyến API GHN nếu có ghnToken
    let liveGhnTotal: number | null = null;
    if (dto.ghnToken) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3500);
      try {
        const res = await fetch(bundle.carrierPayloads.ghn.feeEndpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            token: dto.ghnToken,
            ...(dto.ghnShopId ? { ShopId: String(dto.ghnShopId) } : {}),
          },
          body: JSON.stringify(bundle.carrierPayloads.ghn.feeBody),
          signal: controller.signal,
        }).catch(() => null);
        if (res && res.ok) {
          const json = (await res.json().catch(() => null)) as {
            data?: { total?: number };
          } | null;
          if (typeof json?.data?.total === 'number' && json.data.total > 0) {
            liveGhnTotal = json.data.total;
          }
        }
      } finally {
        clearTimeout(timer);
      }
    }

    const ghnBase = baseByZone.ghn + extraHalfKgSteps * stepCostPer500g;
    const ghtkBase = baseByZone.ghtk + extraHalfKgSteps * stepCostPer500g;
    const vtpBase = baseByZone.vtp + extraHalfKgSteps * stepCostPer500g;
    const jtBase = baseByZone.jt + extraHalfKgSteps * stepCostPer500g;

    const quotes: CarrierShippingQuoteItem[] = [
      {
        carrierCode: 'GHN',
        carrierName: 'Giao Hàng Nhanh (GHN Express)',
        serviceCode: 'GHN_STANDARD',
        serviceName: 'Chuẩn Express',
        totalFeeVnd: liveGhnTotal ?? ghnBase + insuranceFee + islandSurcharge,
        baseFeeVnd: ghnBase,
        insuranceFeeVnd: insuranceFee,
        codFeeVnd: 0,
        remoteAreaSurchargeVnd: islandSurcharge,
        estimatedDeliveryHours: etaByZone.ghn,
        estimatedDeliveryLabel: `${etaByZone.ghn}h (${Math.ceil(etaByZone.ghn / 24)} ngày)`,
        routeZoneType,
        quoteSource: liveGhnTotal ? 'LIVE_CARRIER_API' : 'CALIBRATED_RATE_TABLE',
        mappedAddressSummary: `GHN District #${receiverCrosswalk.carrierMapping.ghn.districtId} • Ward #${receiverCrosswalk.carrierMapping.ghn.wardCode}`,
      },
      {
        carrierCode: 'GHTK',
        carrierName: 'Giao Hàng Tiết Kiệm (GHTK)',
        serviceCode: 'GHTK_ROAD_L4',
        serviceName: 'GHTK Chuẩn Level-4',
        totalFeeVnd: ghtkBase + insuranceFee + islandSurcharge,
        baseFeeVnd: ghtkBase,
        insuranceFeeVnd: insuranceFee,
        codFeeVnd: 0,
        remoteAreaSurchargeVnd: islandSurcharge,
        estimatedDeliveryHours: etaByZone.ghtk,
        estimatedDeliveryLabel: `${etaByZone.ghtk}h (${Math.ceil(etaByZone.ghtk / 24)} ngày)`,
        routeZoneType,
        quoteSource: 'CALIBRATED_RATE_TABLE',
        mappedAddressSummary: `${receiverCrosswalk.carrierMapping.ghtk.hamlet}, ${receiverCrosswalk.carrierMapping.ghtk.ward}, ${receiverCrosswalk.carrierMapping.ghtk.district}`,
      },
      {
        carrierCode: 'VTP',
        carrierName: 'ViettelPost (VTP NLP & ID)',
        serviceCode: 'VCN',
        serviceName: 'ViettelPost Nhanh',
        totalFeeVnd: vtpBase + insuranceFee + islandSurcharge,
        baseFeeVnd: vtpBase,
        insuranceFeeVnd: insuranceFee,
        codFeeVnd: 0,
        remoteAreaSurchargeVnd: islandSurcharge,
        estimatedDeliveryHours: etaByZone.vtp,
        estimatedDeliveryLabel: `${etaByZone.vtp}h (${Math.ceil(etaByZone.vtp / 24)} ngày)`,
        routeZoneType,
        quoteSource: 'CALIBRATED_RATE_TABLE',
        mappedAddressSummary: `VTP Province #${receiverCrosswalk.carrierMapping.viettelPost.provinceId} • ${receiverCrosswalk.threeTierAddress.wardName || ''}`,
      },
      {
        carrierCode: 'JT',
        carrierName: 'J&T Express Vietnam',
        serviceCode: 'JT_EZ',
        serviceName: 'J&T Tiêu Chuẩn (EZ)',
        totalFeeVnd: jtBase + insuranceFee + islandSurcharge,
        baseFeeVnd: jtBase,
        insuranceFeeVnd: insuranceFee,
        codFeeVnd: 0,
        remoteAreaSurchargeVnd: islandSurcharge,
        estimatedDeliveryHours: etaByZone.jt,
        estimatedDeliveryLabel: `${etaByZone.jt}h (${Math.ceil(etaByZone.jt / 24)} ngày)`,
        routeZoneType,
        quoteSource: 'CALIBRATED_RATE_TABLE',
        mappedAddressSummary: `J&T [${receiverCrosswalk.carrierMapping.jtExpress.cityCode} -> ${receiverCrosswalk.carrierMapping.jtExpress.postMergerCityCode}] • ${receiverCrosswalk.carrierMapping.jtExpress.area}`,
      },
    ];

    let cheapest = quotes[0];
    let fastest = quotes[0];
    for (const q of quotes) {
      if (q.totalFeeVnd < cheapest.totalFeeVnd) cheapest = q;
      if (q.estimatedDeliveryHours < fastest.estimatedDeliveryHours) fastest = q;
    }
    cheapest.isRecommendedCheapest = true;
    fastest.isRecommendedFastest = true;

    return {
      routeZoneType,
      routeZoneLabel,
      chargeableWeightGrams: packageSpec.chargeableWeightGrams,
      cheapestCarrierCode: cheapest.carrierCode,
      fastestCarrierCode: fastest.carrierCode,
      quotes,
      senderCrosswalk,
      receiverCrosswalk,
      evaluatedAt: new Date().toISOString(),
    };
  }

  /**
   * Đồng bộ trực tuyến từ điển hành chính 3 cấp & 4 cấp với Open API (v1/v2) và các hãng vận chuyển
   */
  public async syncMultiSourceAdministrativeUnits(
    dto: SyncAdministrativeUnitsDto,
  ): Promise<MultiSourceAdminSyncReport> {
    return syncAdministrativeTreeFromOpenApisAndCarriers({
      ghnToken: dto.ghnToken,
      ghtkToken: dto.ghtkToken,
      vtpToken: dto.vtpToken,
    });
  }
}
