export interface VnWardUnitItem {
  code: string;
  name: string;
  aliases: string[];
  ghnWardCode: string;
  ghtkWardName: string;
}

export interface VnDistrictUnitItem {
  code: string;
  name: string;
  aliases: string[];
  ghnDistrictId: number;
  ghtkDistrictName: string;
  wards: VnWardUnitItem[];
}

export interface VnProvinceUnitItem {
  code: string;
  name: string;
  aliases: string[];
  ghnProvinceId: number;
  ghtkProvinceName: string;
  vtpProvinceId: number;
  jtCityCode: string;
  districts: VnDistrictUnitItem[];
}

/**
 * Từ điển Đơn vị Hành chính 3 Cấp Việt Nam chuẩn hóa cho 4 hãng vận chuyển (GHN, GHTK, ViettelPost, J&T)
 * kèm danh sách từ viết tắt thực chiến khi khách bình luận / nhắn tin chốt đơn.
 */
export const VN_ADMINISTRATIVE_UNITS_DICTIONARY: VnProvinceUnitItem[] = [
  {
    code: 'VN-HN',
    name: 'Thành phố Hà Nội',
    aliases: ['ha noi', 'hn', 'tp ha noi', 'hanoi', 'thu do ha noi'],
    ghnProvinceId: 201,
    ghtkProvinceName: 'Hà Nội',
    vtpProvinceId: 1,
    jtCityCode: 'HNI',
    districts: [
      {
        code: 'VN-HN-CG',
        name: 'Quận Cầu Giấy',
        aliases: ['cau giay', 'q cau giay', 'quan cau giay', 'cg'],
        ghnDistrictId: 1485,
        ghtkDistrictName: 'Quận Cầu Giấy',
        wards: [
          {
            code: 'VN-HN-CG-DVH',
            name: 'Phường Dịch Vọng Hậu',
            aliases: ['dich vong hau', 'p dich vong hau', 'dvh', 'xuan thuy', 'tran thai tong'],
            ghnWardCode: '1A0602',
            ghtkWardName: 'Phường Dịch Vọng Hậu',
          },
          {
            code: 'VN-HN-CG-DV',
            name: 'Phường Dịch Vọng',
            aliases: ['dich vong', 'p dich vong', 'chua ha', 'khuc thua du'],
            ghnWardCode: '1A0601',
            ghtkWardName: 'Phường Dịch Vọng',
          },
          {
            code: 'VN-HN-CG-TH',
            name: 'Phường Trung Hòa',
            aliases: ['trung hoa', 'p trung hoa', 'tran duy hung', 'nguyen khang'],
            ghnWardCode: '1A0607',
            ghtkWardName: 'Phường Trung Hòa',
          },
          {
            code: 'VN-HN-CG-QH',
            name: 'Phường Quan Hoa',
            aliases: ['quan hoa', 'p quan hoa', 'duong quang ham', 'ngo 68 cau giay', 'cau giay'],
            ghnWardCode: '1A0606',
            ghtkWardName: 'Phường Quan Hoa',
          },
        ],
      },
      {
        code: 'VN-HN-DD',
        name: 'Quận Đống Đa',
        aliases: ['dong da', 'q dong da', 'quan dong da'],
        ghnDistrictId: 1486,
        ghtkDistrictName: 'Quận Đống Đa',
        wards: [
          {
            code: 'VN-HN-DD-LH',
            name: 'Phường Láng Hạ',
            aliases: ['lang ha', 'p lang ha', 'huynh thuc khang', 'thai ha'],
            ghnWardCode: '1A0406',
            ghtkWardName: 'Phường Láng Hạ',
          },
          {
            code: 'VN-HN-DD-OCB',
            name: 'Phường Ô Chợ Dừa',
            aliases: ['o cho dua', 'p o cho dua', 'xa dan', 'hoang cau'],
            ghnWardCode: '1A0410',
            ghtkWardName: 'Phường Ô Chợ Dừa',
          },
        ],
      },
      {
        code: 'VN-HN-TX',
        name: 'Quận Thanh Xuân',
        aliases: ['thanh xuan', 'q thanh xuan', 'quan thanh xuan', 'tx'],
        ghnDistrictId: 1493,
        ghtkDistrictName: 'Quận Thanh Xuân',
        wards: [
          {
            code: 'VN-HN-TX-NT',
            name: 'Phường Nhân Chính',
            aliases: ['nhan chinh', 'p nhan chinh', 'le van luong', 'quan nhan'],
            ghnWardCode: '1A0704',
            ghtkWardName: 'Phường Nhân Chính',
          },
          {
            code: 'VN-HN-TX-KDT',
            name: 'Phường Khương Đình',
            aliases: ['khuong dinh', 'p khuong dinh', 'khuong trung', 'vu trong phung'],
            ghnWardCode: '1A0702',
            ghtkWardName: 'Phường Khương Đình',
          },
        ],
      },
      {
        code: 'VN-HN-HBT',
        name: 'Quận Hai Bà Trưng',
        aliases: ['hai ba trung', 'q hai ba trung', 'hbt', 'minh khai', 'bach mai'],
        ghnDistrictId: 1488,
        ghtkDistrictName: 'Quận Hai Bà Trưng',
        wards: [
          {
            code: 'VN-HN-HBT-MK',
            name: 'Phường Minh Khai',
            aliases: ['minh khai', 'p minh khai', 'times city'],
            ghnWardCode: '1A0307',
            ghtkWardName: 'Phường Minh Khai',
          },
          {
            code: 'VN-HN-HBT-BK',
            name: 'Phường Bách Khoa',
            aliases: ['bach khoa', 'p bach khoa', 'ta quang buu', 'le thanh nghi'],
            ghnWardCode: '1A0301',
            ghtkWardName: 'Phường Bách Khoa',
          },
        ],
      },
      {
        code: 'VN-HN-NTL',
        name: 'Quận Nam Từ Liêm',
        aliases: ['nam tu liem', 'q nam tu liem', 'ntl', 'my dinh'],
        ghnDistrictId: 3440,
        ghtkDistrictName: 'Quận Nam Từ Liêm',
        wards: [
          {
            code: 'VN-HN-NTL-MD1',
            name: 'Phường Mỹ Đình 1',
            aliases: ['my dinh 1', 'my dinh', 'p my dinh 1', 'ham nghi'],
            ghnWardCode: '1B1904',
            ghtkWardName: 'Phường Mỹ Đình 1',
          },
          {
            code: 'VN-HN-NTL-MD2',
            name: 'Phường Mỹ Đình 2',
            aliases: ['my dinh 2', 'p my dinh 2', 'le duc tho'],
            ghnWardCode: '1B1905',
            ghtkWardName: 'Phường Mỹ Đình 2',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-SG',
    name: 'Thành phố Hồ Chí Minh',
    aliases: ['ho chi minh', 'tp ho chi minh', 'tphcm', 'hcm', 'sg', 'sai gon', 'saigon'],
    ghnProvinceId: 202,
    ghtkProvinceName: 'TP. Hồ Chí Minh',
    vtpProvinceId: 2,
    jtCityCode: 'SGN',
    districts: [
      {
        code: 'VN-SG-Q1',
        name: 'Quận 1',
        aliases: ['quan 1', 'q1', 'q.1', 'q 1'],
        ghnDistrictId: 1442,
        ghtkDistrictName: 'Quận 1',
        wards: [
          {
            code: 'VN-SG-Q1-BN',
            name: 'Phường Bến Nghé',
            aliases: ['ben nghe', 'p ben nghe', 'nguyen hue', 'le loi'],
            ghnWardCode: '20101',
            ghtkWardName: 'Phường Bến Nghé',
          },
          {
            code: 'VN-SG-Q1-BT',
            name: 'Phường Bến Thành',
            aliases: ['ben thanh', 'p ben thanh', 'le thanh ton', 'ly tu trong'],
            ghnWardCode: '20102',
            ghtkWardName: 'Phường Bến Thành',
          },
        ],
      },
      {
        code: 'VN-SG-Q5',
        name: 'Quận 5',
        aliases: ['quan 5', 'q5', 'q.5', 'q 5'],
        ghnDistrictId: 1447,
        ghtkDistrictName: 'Quận 5',
        wards: [
          {
            code: 'VN-SG-Q5-P3',
            name: 'Phường 3',
            aliases: ['phuong 3', 'p3', 'p.3', 'nguyen trai', 'an duong vuong'],
            ghnWardCode: '20503',
            ghtkWardName: 'Phường 3',
          },
          {
            code: 'VN-SG-Q5-P8',
            name: 'Phường 8',
            aliases: ['phuong 8', 'p8', 'p.8', 'tran phu'],
            ghnWardCode: '20508',
            ghtkWardName: 'Phường 8',
          },
        ],
      },
      {
        code: 'VN-SG-Q10',
        name: 'Quận 10',
        aliases: ['quan 10', 'q10', 'q.10', 'q 10'],
        ghnDistrictId: 1452,
        ghtkDistrictName: 'Quận 10',
        wards: [
          {
            code: 'VN-SG-Q10-P12',
            name: 'Phường 12',
            aliases: ['phuong 12', 'p12', 'p.12', 'su van hanh', 'ba thang hai', '3/2'],
            ghnWardCode: '21012',
            ghtkWardName: 'Phường 12',
          },
          {
            code: 'VN-SG-Q10-P14',
            name: 'Phường 14',
            aliases: ['phuong 14', 'p14', 'p.14', 'thanh thai'],
            ghnWardCode: '21014',
            ghtkWardName: 'Phường 14',
          },
        ],
      },
      {
        code: 'VN-SG-BT',
        name: 'Quận Bình Thạnh',
        aliases: ['binh thanh', 'q binh thanh', 'quan binh thanh', 'bt'],
        ghnDistrictId: 1462,
        ghtkDistrictName: 'Quận Bình Thạnh',
        wards: [
          {
            code: 'VN-SG-BT-P22',
            name: 'Phường 22',
            aliases: ['phuong 22', 'p22', 'vinhomes central park', 'nguyen huu canh'],
            ghnWardCode: '21722',
            ghtkWardName: 'Phường 22',
          },
          {
            code: 'VN-SG-BT-P25',
            name: 'Phường 25',
            aliases: ['phuong 25', 'p25', 'dien bien phu', 'ung van khiem', 'd2'],
            ghnWardCode: '21725',
            ghtkWardName: 'Phường 25',
          },
        ],
      },
      {
        code: 'VN-SG-GV',
        name: 'Quận Gò Vấp',
        aliases: ['go vap', 'q go vap', 'quan go vap', 'gv'],
        ghnDistrictId: 1461,
        ghtkDistrictName: 'Quận Gò Vấp',
        wards: [
          {
            code: 'VN-SG-GV-P10',
            name: 'Phường 10',
            aliases: ['phuong 10', 'p10', 'quang trung', 'phan van tri'],
            ghnWardCode: '21610',
            ghtkWardName: 'Phường 10',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-DN',
    name: 'Thành phố Đà Nẵng',
    aliases: ['da nang', 'dn', 'tp da nang', 'danang'],
    ghnProvinceId: 203,
    ghtkProvinceName: 'Đà Nẵng',
    vtpProvinceId: 3,
    jtCityCode: 'DAD',
    districts: [
      {
        code: 'VN-DN-HC',
        name: 'Quận Hải Châu',
        aliases: ['hai chau', 'q hai chau', 'quan hai chau'],
        ghnDistrictId: 1526,
        ghtkDistrictName: 'Quận Hải Châu',
        wards: [
          {
            code: 'VN-DN-HC-HC1',
            name: 'Phường Hải Châu I',
            aliases: ['hai chau 1', 'hai chau i', 'p hai chau 1', 'bach dang', 'le duan'],
            ghnWardCode: '40103',
            ghtkWardName: 'Phường Hải Châu I',
          },
        ],
      },
      {
        code: 'VN-DN-ST',
        name: 'Quận Sơn Trà',
        aliases: ['son tra', 'q son tra', 'quan son tra'],
        ghnDistrictId: 1528,
        ghtkDistrictName: 'Quận Sơn Trà',
        wards: [
          {
            code: 'VN-DN-ST-AHB',
            name: 'Phường An Hải Bắc',
            aliases: ['an hai bac', 'p an hai bac', 'pham van dong'],
            ghnWardCode: '40301',
            ghtkWardName: 'Phường An Hải Bắc',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-HP',
    name: 'Thành phố Hải Phòng',
    aliases: ['hai phong', 'hp', 'tp hai phong'],
    ghnProvinceId: 224,
    ghtkProvinceName: 'Hải Phòng',
    vtpProvinceId: 4,
    jtCityCode: 'HPH',
    districts: [
      {
        code: 'VN-HP-NQ',
        name: 'Quận Ngô Quyền',
        aliases: ['ngo quyen', 'q ngo quyen', 'quan ngo quyen'],
        ghnDistrictId: 1816,
        ghtkDistrictName: 'Quận Ngô Quyền',
        wards: [
          {
            code: 'VN-HP-NQ-DG',
            name: 'Phường Đông Khê',
            aliases: ['dong khe', 'p dong khe', 'le hong phong'],
            ghnWardCode: '30204',
            ghtkWardName: 'Phường Đông Khê',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-CT',
    name: 'Thành phố Cần Thơ',
    aliases: ['can tho', 'ct', 'tp can tho'],
    ghnProvinceId: 220,
    ghtkProvinceName: 'Cần Thơ',
    vtpProvinceId: 5,
    jtCityCode: 'VCA',
    districts: [
      {
        code: 'VN-CT-NK',
        name: 'Quận Ninh Kiều',
        aliases: ['ninh kieu', 'q ninh kieu', 'quan ninh kieu', 'nk'],
        ghnDistrictId: 1572,
        ghtkDistrictName: 'Quận Ninh Kiều',
        wards: [
          {
            code: 'VN-CT-NK-XH',
            name: 'Phường Xuân Khánh',
            aliases: ['xuan khanh', 'p xuan khanh', 'duong 30/4', 'mau than'],
            ghnWardCode: '920110',
            ghtkWardName: 'Phường Xuân Khánh',
          },
        ],
      },
    ],
  },
];
