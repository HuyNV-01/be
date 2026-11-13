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
            aliases: [
              'dich vong hau',
              'p dich vong hau',
              'dvh',
              'xuan thuy',
              'tran thai tong',
              'duy tan',
            ],
            ghnWardCode: '1A0602',
            ghtkWardName: 'Phường Dịch Vọng Hậu',
          },
          {
            code: 'VN-HN-CG-DV',
            name: 'Phường Dịch Vọng',
            aliases: ['dich vong', 'p dich vong', 'chua ha', 'khuc thua du', 'thanh thai'],
            ghnWardCode: '1A0601',
            ghtkWardName: 'Phường Dịch Vọng',
          },
          {
            code: 'VN-HN-CG-TH',
            name: 'Phường Trung Hòa',
            aliases: [
              'trung hoa',
              'p trung hoa',
              'tran duy hung',
              'nguyen khang',
              'hoang dao thuy',
            ],
            ghnWardCode: '1A0607',
            ghtkWardName: 'Phường Trung Hòa',
          },
          {
            code: 'VN-HN-CG-QH',
            name: 'Phường Quan Hoa',
            aliases: [
              'quan hoa',
              'p quan hoa',
              'duong quang ham',
              'ngo 68 cau giay',
              'cau giay',
              'nguyen khanh toan',
            ],
            ghnWardCode: '1A0606',
            ghtkWardName: 'Phường Quan Hoa',
          },
          {
            code: 'VN-HN-CG-MD',
            name: 'Phường Mai Dịch',
            aliases: ['mai dich', 'p mai dich', 'ho tung mau', 'pham van dong', 'doan ke thien'],
            ghnWardCode: '1A0603',
            ghtkWardName: 'Phường Mai Dịch',
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
            aliases: ['lang ha', 'p lang ha', 'huynh thuc khang', 'thai ha', 'chua lang'],
            ghnWardCode: '1A0406',
            ghtkWardName: 'Phường Láng Hạ',
          },
          {
            code: 'VN-HN-DD-OCB',
            name: 'Phường Ô Chợ Dừa',
            aliases: ['o cho dua', 'p o cho dua', 'xa dan', 'hoang cau', 'ton duc thang'],
            ghnWardCode: '1A0410',
            ghtkWardName: 'Phường Ô Chợ Dừa',
          },
          {
            code: 'VN-HN-DD-TC',
            name: 'Phường Trung Tự',
            aliases: ['trung tu', 'p trung tu', 'pham ngoc thach', 'chua boc', 'dang van ngu'],
            ghnWardCode: '1A0419',
            ghtkWardName: 'Phường Trung Tự',
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
            aliases: [
              'nhan chinh',
              'p nhan chinh',
              'le van luong',
              'quan nhan',
              'vinhomes royal city',
              'nguyen trai',
            ],
            ghnWardCode: '1A0704',
            ghtkWardName: 'Phường Nhân Chính',
          },
          {
            code: 'VN-HN-TX-KDT',
            name: 'Phường Khương Đình',
            aliases: [
              'khuong dinh',
              'p khuong dinh',
              'khuong trung',
              'vu trong phung',
              'khuong ha',
            ],
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
            aliases: ['minh khai', 'p minh khai', 'times city', 'vinh tuy'],
            ghnWardCode: '1A0307',
            ghtkWardName: 'Phường Minh Khai',
          },
          {
            code: 'VN-HN-HBT-BK',
            name: 'Phường Bách Khoa',
            aliases: [
              'bach khoa',
              'p bach khoa',
              'ta quang buu',
              'le thanh nghi',
              'tran dai nghia',
            ],
            ghnWardCode: '1A0301',
            ghtkWardName: 'Phường Bách Khoa',
          },
        ],
      },
      {
        code: 'VN-HN-HK',
        name: 'Quận Hoàn Kiếm',
        aliases: ['hoan kiem', 'q hoan kiem', 'quan hoan kiem', 'pho co'],
        ghnDistrictId: 1489,
        ghtkDistrictName: 'Quận Hoàn Kiếm',
        wards: [
          {
            code: 'VN-HN-HK-HB',
            name: 'Phường Hàng Bài',
            aliases: [
              'hang bai',
              'p hang bai',
              'trang tien',
              'pho hue',
              'ly thuong kiet',
              'tran hung dao',
            ],
            ghnWardCode: '1A0104',
            ghtkWardName: 'Phường Hàng Bài',
          },
        ],
      },
      {
        code: 'VN-HN-BD',
        name: 'Quận Ba Đình',
        aliases: ['ba dinh', 'q ba dinh', 'quan ba dinh'],
        ghnDistrictId: 1484,
        ghtkDistrictName: 'Quận Ba Đình',
        wards: [
          {
            code: 'VN-HN-BD-KM',
            name: 'Phường Kim Mã',
            aliases: ['kim ma', 'p kim ma', ' Giang vo', 'lieu giai', 'doi can', 'ngoc khanh'],
            ghnWardCode: '1A0204',
            ghtkWardName: 'Phường Kim Mã',
          },
        ],
      },
      {
        code: 'VN-HN-HM',
        name: 'Quận Hoàng Mai',
        aliases: ['hoang mai', 'q hoang mai', 'quan hoang mai', 'linh dam'],
        ghnDistrictId: 1490,
        ghtkDistrictName: 'Quận Hoàng Mai',
        wards: [
          {
            code: 'VN-HN-HM-HL',
            name: 'Phường Hoàng Liệt',
            aliases: ['hoang liet', 'p hoang liet', 'linh dam', 'giai phong', 'kim giang'],
            ghnWardCode: '1A0805',
            ghtkWardName: 'Phường Hoàng Liệt',
          },
        ],
      },
      {
        code: 'VN-HN-LB',
        name: 'Quận Long Biên',
        aliases: ['long bien', 'q long bien', 'quan long bien', 'nguyen van cu'],
        ghnDistrictId: 1491,
        ghtkDistrictName: 'Quận Long Biên',
        wards: [
          {
            code: 'VN-HN-LB-BD',
            name: 'Phường Bồ Đề',
            aliases: ['bo de', 'p bo de', 'nguyen van cu', 'ngoc lam', 'co linh'],
            ghnWardCode: '1A0901',
            ghtkWardName: 'Phường Bồ Đề',
          },
        ],
      },
      {
        code: 'VN-HN-HD',
        name: 'Quận Hà Đông',
        aliases: ['ha dong', 'q ha dong', 'quan ha dong', 'van quan', 'mo lao'],
        ghnDistrictId: 1542,
        ghtkDistrictName: 'Quận Hà Đông',
        wards: [
          {
            code: 'VN-HN-HD-ML',
            name: 'Phường Mộ Lao',
            aliases: ['mo lao', 'p mo lao', 'tran phu ha dong', 'van quan', 'quang trung ha dong'],
            ghnWardCode: '1B1506',
            ghtkWardName: 'Phường Mộ Lao',
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
            aliases: ['my dinh 1', 'my dinh', 'p my dinh 1', 'ham nghi', 'pham hung'],
            ghnWardCode: '1B1904',
            ghtkWardName: 'Phường Mỹ Đình 1',
          },
          {
            code: 'VN-HN-NTL-MD2',
            name: 'Phường Mỹ Đình 2',
            aliases: ['my dinh 2', 'p my dinh 2', 'le duc tho', 'nguyen hoang'],
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
            aliases: ['ben nghe', 'p ben nghe', 'nguyen hue', 'le loi', 'dong khoi'],
            ghnWardCode: '20101',
            ghtkWardName: 'Phường Bến Nghé',
          },
          {
            code: 'VN-SG-Q1-BT',
            name: 'Phường Bến Thành',
            aliases: [
              'ben thanh',
              'p ben thanh',
              'le thanh ton',
              'ly tu trong',
              'nguyen thi minh khai',
            ],
            ghnWardCode: '20102',
            ghtkWardName: 'Phường Bến Thành',
          },
        ],
      },
      {
        code: 'VN-SG-Q3',
        name: 'Quận 3',
        aliases: ['quan 3', 'q3', 'q.3', 'q 3'],
        ghnDistrictId: 1444,
        ghtkDistrictName: 'Quận 3',
        wards: [
          {
            code: 'VN-SG-Q3-VTS',
            name: 'Phường Võ Thị Sáu',
            aliases: [
              'vo thi sau',
              'p vo thi sau',
              'nam ky khoi nghia',
              'pasteur',
              'hai ba trung q3',
              'cach mang thang 8',
            ],
            ghnWardCode: '20306',
            ghtkWardName: 'Phường Võ Thị Sáu',
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
            aliases: ['phuong 3', 'p3', 'p.3', 'nguyen trai', 'an duong vuong', 'tran hung dao q5'],
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
        code: 'VN-SG-Q7',
        name: 'Quận 7',
        aliases: ['quan 7', 'q7', 'q.7', 'q 7', 'phu my hung'],
        ghnDistrictId: 1449,
        ghtkDistrictName: 'Quận 7',
        wards: [
          {
            code: 'VN-SG-Q7-TP',
            name: 'Phường Tân Phong',
            aliases: [
              'tan phong',
              'p tan phong',
              'nguyen van linh',
              'phu my hung',
              'nguyen thi thap',
            ],
            ghnWardCode: '20708',
            ghtkWardName: 'Phường Tân Phong',
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
            aliases: ['phuong 14', 'p14', 'p.14', 'thanh thai', 'ly thuong kiet q10'],
            ghnWardCode: '21014',
            ghtkWardName: 'Phường 14',
          },
        ],
      },
      {
        code: 'VN-SG-TB',
        name: 'Quận Tân Bình',
        aliases: ['tan binh', 'q tan binh', 'quan tan binh', 'tb', 'cong hoa'],
        ghnDistrictId: 1457,
        ghtkDistrictName: 'Quận Tân Bình',
        wards: [
          {
            code: 'VN-SG-TB-P13',
            name: 'Phường 13',
            aliases: ['phuong 13', 'p13', 'cong hoa', 'truong chinh', 'hoang hoa tham'],
            ghnWardCode: '21413',
            ghtkWardName: 'Phường 13',
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
            aliases: [
              'phuong 22',
              'p22',
              'vinhomes central park',
              'nguyen huu canh',
              'landmark 81',
            ],
            ghnWardCode: '21722',
            ghtkWardName: 'Phường 22',
          },
          {
            code: 'VN-SG-BT-P25',
            name: 'Phường 25',
            aliases: [
              'phuong 25',
              'p25',
              'dien bien phu',
              'ung van khiem',
              'd2',
              'xo viet nghe tinh',
            ],
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
            aliases: ['phuong 10', 'p10', 'quang trung', 'phan van tri', 'nguyen oanh'],
            ghnWardCode: '21610',
            ghtkWardName: 'Phường 10',
          },
        ],
      },
      {
        code: 'VN-SG-TD',
        name: 'Thành phố Thủ Đức',
        aliases: ['thu duc', 'tp thu duc', 'quan 2', 'q2', 'quan 9', 'q9', 'thao dien'],
        ghnDistrictId: 3695,
        ghtkDistrictName: 'Thành phố Thủ Đức',
        wards: [
          {
            code: 'VN-SG-TD-TD',
            name: 'Phường Thảo Điền',
            aliases: [
              'thao dien',
              'p thao dien',
              'vo nguyen giap',
              'xa lo ha noi',
              'pham van dong thu duc',
            ],
            ghnWardCode: '90737',
            ghtkWardName: 'Phường Thảo Điền',
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
            aliases: [
              'hai chau 1',
              'hai chau i',
              'p hai chau 1',
              'bach dang',
              'le duan',
              'nguyen van linh da nang',
            ],
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
      {
        code: 'VN-DN-TK',
        name: 'Quận Thanh Khê',
        aliases: ['thanh khe', 'q thanh khe', 'quan thanh khe'],
        ghnDistrictId: 1527,
        ghtkDistrictName: 'Quận Thanh Khê',
        wards: [
          {
            code: 'VN-DN-TK-TC',
            name: 'Phường Thạc Gián',
            aliases: ['thac gian', 'p thac gian', 'dien bien phu da nang', 'ham nghi da nang'],
            ghnWardCode: '40205',
            ghtkWardName: 'Phường Thạc Gián',
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
        aliases: ['ngo quyen', 'q ngo quyen', 'quan ngo quyen', 'le chan'],
        ghnDistrictId: 1816,
        ghtkDistrictName: 'Quận Ngô Quyền',
        wards: [
          {
            code: 'VN-HP-NQ-DG',
            name: 'Phường Đông Khê',
            aliases: ['dong khe', 'p dong khe', 'le hong phong', 'lach tray', 'cau dat'],
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
            aliases: [
              'xuan khanh',
              'p xuan khanh',
              'duong 30/4',
              'mau than',
              'nguyen van cu can tho',
            ],
            ghnWardCode: '920110',
            ghtkWardName: 'Phường Xuân Khánh',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-BD',
    name: 'Tỉnh Bình Dương',
    aliases: ['binh duong', 'tinh binh duong', 'bd', 'thu dau mot', 'di an', 'thuan an'],
    ghnProvinceId: 205,
    ghtkProvinceName: 'Bình Dương',
    vtpProvinceId: 6,
    jtCityCode: 'BDU',
    districts: [
      {
        code: 'VN-BD-TDM',
        name: 'Thành phố Thủ Dầu Một',
        aliases: ['thu dau mot', 'tp thu dau mot', 'tdm', 'di an', 'thuan an'],
        ghnDistrictId: 1538,
        ghtkDistrictName: 'Thành phố Thủ Dầu Một',
        wards: [
          {
            code: 'VN-BD-TDM-PC',
            name: 'Phường Phú Cường',
            aliases: ['phu cuong', 'p phu cuong', 'phu hoa', 'dai lo binh duong'],
            ghnWardCode: '440104',
            ghtkWardName: 'Phường Phú Cường',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-DNA',
    name: 'Tỉnh Đồng Nai',
    aliases: ['dong nai', 'tinh dong nai', 'bien hoa', 'tp bien hoa', 'long thanh'],
    ghnProvinceId: 204,
    ghtkProvinceName: 'Đồng Nai',
    vtpProvinceId: 7,
    jtCityCode: 'DNI',
    districts: [
      {
        code: 'VN-DNA-BH',
        name: 'Thành phố Biên Hòa',
        aliases: ['bien hoa', 'tp bien hoa', 'trang dai', 'tan hiep'],
        ghnDistrictId: 1536,
        ghtkDistrictName: 'Thành phố Biên Hòa',
        wards: [
          {
            code: 'VN-DNA-BH-TH',
            name: 'Phường Tân Hiệp',
            aliases: ['tan hiep', 'p tan hiep', 'pham van thuan', 'dong khoi bien hoa'],
            ghnWardCode: '430112',
            ghtkWardName: 'Phường Tân Hiệp',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-BN',
    name: 'Tỉnh Bắc Ninh',
    aliases: ['bac ninh', 'tinh bac ninh', 'tp bac ninh', 'tu son', 'yen phong'],
    ghnProvinceId: 230,
    ghtkProvinceName: 'Bắc Ninh',
    vtpProvinceId: 8,
    jtCityCode: 'BNI',
    districts: [
      {
        code: 'VN-BN-TP',
        name: 'Thành phố Bắc Ninh',
        aliases: ['tp bac ninh', 'thanh pho bac ninh', 'tu son', 'vo cuong', 'suoi hoa'],
        ghnDistrictId: 1840,
        ghtkDistrictName: 'Thành phố Bắc Ninh',
        wards: [
          {
            code: 'VN-BN-TP-VC',
            name: 'Phường Võ Cường',
            aliases: ['vo cuong', 'p vo cuong', 'suoi hoa', 'inh ba', 'ly thai to bac ninh'],
            ghnWardCode: '220109',
            ghtkWardName: 'Phường Võ Cường',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-QN',
    name: 'Tỉnh Quảng Ninh',
    aliases: [
      'quang ninh',
      'tinh quang ninh',
      'ha long',
      'tp ha long',
      'cam pha',
      'uong bi',
      'mong cai',
    ],
    ghnProvinceId: 232,
    ghtkProvinceName: 'Quảng Ninh',
    vtpProvinceId: 9,
    jtCityCode: 'QNI',
    districts: [
      {
        code: 'VN-QN-HL',
        name: 'Thành phố Hạ Long',
        aliases: ['ha long', 'tp ha long', 'bai chay', 'hon gai'],
        ghnDistrictId: 1852,
        ghtkDistrictName: 'Thành phố Hạ Long',
        wards: [
          {
            code: 'VN-QN-HL-BC',
            name: 'Phường Bãi Cháy',
            aliases: ['bai chay', 'p bai chay', 'hong hai', 'hong gai'],
            ghnWardCode: '190101',
            ghtkWardName: 'Phường Bãi Cháy',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-TH',
    name: 'Tỉnh Thanh Hóa',
    aliases: ['thanh hoa', 'tinh thanh hoa', 'tp thanh hoa', 'sam son', 'bim son'],
    ghnProvinceId: 237,
    ghtkProvinceName: 'Thanh Hóa',
    vtpProvinceId: 10,
    jtCityCode: 'THA',
    districts: [
      {
        code: 'VN-TH-TP',
        name: 'Thành phố Thanh Hóa',
        aliases: ['tp thanh hoa', 'thanh pho thanh hoa', 'dien bien thanh hoa', 'dong huong'],
        ghnDistrictId: 1915,
        ghtkDistrictName: 'Thành phố Thanh Hóa',
        wards: [
          {
            code: 'VN-TH-TP-DB',
            name: 'Phường Điện Biên',
            aliases: ['dien bien', 'p dien bien', 'dong huong', 'le hoan'],
            ghnWardCode: '280102',
            ghtkWardName: 'Phường Điện Biên',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-NA',
    name: 'Tỉnh Nghệ An',
    aliases: ['nghe an', 'tinh nghe an', 'tp vinh', 'thanh pho vinh', 'cua lo'],
    ghnProvinceId: 238,
    ghtkProvinceName: 'Nghệ An',
    vtpProvinceId: 11,
    jtCityCode: 'NAN',
    districts: [
      {
        code: 'VN-NA-VINH',
        name: 'Thành phố Vinh',
        aliases: ['tp vinh', 'thanh pho vinh', 'vinh', 'hung dung', 'le loi vinh'],
        ghnDistrictId: 1938,
        ghtkDistrictName: 'Thành phố Vinh',
        wards: [
          {
            code: 'VN-NA-VINH-HB',
            name: 'Phường Hưng Bình',
            aliases: ['hung binh', 'p hung binh', 'nguyen van cu vinh', 'quang trung vinh'],
            ghnWardCode: '290108',
            ghtkWardName: 'Phường Hưng Bình',
          },
        ],
      },
    ],
  },
  {
    code: 'VN-KH',
    name: 'Tỉnh Khánh Hòa',
    aliases: ['khanh hoa', 'tinh khanh hoa', 'nha trang', 'tp nha trang', 'cam ranh'],
    ghnProvinceId: 208,
    ghtkProvinceName: 'Khánh Hòa',
    vtpProvinceId: 12,
    jtCityCode: 'KHA',
    districts: [
      {
        code: 'VN-KH-NT',
        name: 'Thành phố Nha Trang',
        aliases: ['nha trang', 'tp nha trang', 'loc tho', 'vinh hai'],
        ghnDistrictId: 1554,
        ghtkDistrictName: 'Thành phố Nha Trang',
        wards: [
          {
            code: 'VN-KH-NT-LT',
            name: 'Phường Lộc Thọ',
            aliases: ['loc tho', 'p loc tho', 'tran phu nha trang'],
            ghnWardCode: '370104',
            ghtkWardName: 'Phường Lộc Thọ',
          },
        ],
      },
    ],
  },
];
