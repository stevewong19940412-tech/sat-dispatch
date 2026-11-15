// ─── 卫星型号能力表（唯一事实源）────────────────────────────────────────────
// 背景：历史上有两张互相矛盾的幅宽表——
//   candidate_calc.mjs 的 DEFAULT_CAPS（JILIN 12km / GAOFEN 统一 14km）
//   payload_specs.mjs 的 PAYLOAD_SPECS（JILIN 150km / GAOFEN-1 60km）
// 前者用于"能不能拍到"的覆盖判定，后者用于数传量估算；两者都靠 startWith 前缀匹配，
// 导致 GAOFEN-9/11/13 全部落到 GAOFEN-1 的 60km、JILIN-1 GAOFEN 03D50 落到 JILIN 上。
// 2026-11-15 按官方公开参数重做本表：幅宽/分辨率/侧摆以官方发布为准，逐条记 source。
//
// 取值口径（重要）：
//   swathKm 取该卫星"高分辨率主载荷"星下点成像幅宽，不取宽幅相机/多光谱低分辨率通道，
//   因为覆盖判定是要回答"这张图能不能拍到目标"，只能用与任务分辨率档匹配的那台相机。
//   resM 为对应主载荷的星下点分辨率（全色/PPI 口径）。

// 匹配用正则（从最具体到最泛，按顺序首个命中即用）
export const SAT_SPECS = [
  // ── 吉林一号（长光卫星 jl1.cn 官方产品页）──
  // 宽幅星：0.75m / 幅宽 136km（红旗一号-H9，jl1.cn 专题页；宽幅 01 星参数表同）
  // ├─ 宽幅 01 星 / 红旗一号-H9：0.75m / 幅宽 136km（jl1.cn id=1991/758）
  // └─ 01B / 02B 系（新一代宽幅）：0.5m / 幅宽 ≥150km
  { re: /^JILIN.*KUANFU.*(0?1B|0?2B)/i, key: 'JILIN-KUANFU-NEW', resM: 0.5, swathKm: 150, slewMax: 45, cat: '光学',
    src: 'jl1.cn 宽幅 01B/02B（0.5m，幅宽≥150km）' },
  { re: /^JILIN.*KUANFU/i, key: 'JILIN-KUANFU', resM: 0.75, swathKm: 136, slewMax: 45, cat: '光学',
    src: 'jl1.cn 宽幅星专题（0.75m，幅宽136km）' },
  // 吉林一号高分 3x（3A/3E/3F）为 SAR 星：C 波段 1m 级条带 30km（typical）
  { re: /^JILIN.*GAOFEN[\s-]?3/i, key: 'JILIN-GF3-SAR', resM: 3, swathKm: 30, slewMax: 45, cat: 'SAR',
    src: 'jl1.cn 吉林一号高分03 SAR（C 波段；typical 3m/30km）' },
  // 吉星高分 07 系列（2026-080 一箭八星：07A02-04 / 07B02-04 / 07C02-03，
  // CelesTrak 名称为 JILIN GAOFEN OBJECT A~H）：优于 0.5m，推扫幅宽 15km
  // 依据：新华社/jl1.cn 2026-04-14 发射通报（分辨率优于0.5m）+ 人民日报 2026-01-17（该系列推扫幅宽15km）
  { re: /^JILIN GAOFEN OBJECT/i, key: 'JILIN-GF07', resM: 0.5, swathKm: 15, slewMax: 45, cat: '光学',
    src: '新华社/jl1.cn 2026-04-14 吉星高分07系列（>0.5m）；人民日报 2026-01-17（幅宽15km）' },
  // 高分系列 0.5m 级：高分04A 幅宽优于 15km（jl1.cn product id=2920/4248）
  { re: /^JILIN-?1? GAOFEN 0[45]/i, key: 'JILIN-GF04', resM: 0.5, swathKm: 15, slewMax: 45, cat: '光学',
    src: 'jl1.cn 高分04A（0.5m，幅宽优于15km）' },
  // 高分系列 0.75m 级（高分02/03 系列、道达星座）：幅宽大于 17km
  { re: /^JILIN-?1? GAOFEN/i, key: 'JILIN-GF', resM: 0.75, swathKm: 17, slewMax: 45, cat: '光学',
    src: 'jl1.cn 道达星座/高分03D（0.75m，幅宽>17km）' },
  // 吉林一号光学 A 星等早期型号：0.72m / 幅宽 11.6km
  { re: /^JILIN/i, key: 'JILIN-LEGACY', resM: 0.72, swathKm: 11.6, slewMax: 45, cat: '光学',
    src: '空天院《吉林一号星座》用户简讯 表一（0.72m，幅宽11.6km）' },

  // ── 高分系列（高分专项，国家航天局 / 中国资源卫星应用中心 / 国土卫星中心）──
  { re: /^GAOFEN[-\s]?DUOMO|^GFDM/i, key: 'GFDM', resM: 0.5, swathKm: 15, slewMax: 45, cat: '光学',
    src: 'cnsa.gov.cn 高分多模（0.5m/2m，条带幅宽15km）' },
  { re: /^GAOFEN[-\s]?1(?!\d)/i, key: 'GF-1', resM: 2, swathKm: 60, slewMax: 35, cat: '光学',
    src: 'cnsa.gov.cn/lasac（2m 全色幅宽>60km，16m 宽幅800km）' },
  { re: /^GAOFEN[-\s]?2/i, key: 'GF-2', resM: 0.8, swathKm: 45, slewMax: 35, cat: '光学',
    src: 'cnsa.gov.cn 高分二号（0.8m，幅宽优于45km）' },
  // GF-3：模式与幅宽必须取自同一模式（1m 只在滑块聚束 10km；3m→超精细条带 30km）
  // 取 3m/30km（可成像的常规模式），避免“1m 分辨率 + 30km 幅宽”这种不存在于任何模式的组合
  { re: /^GAOFEN[-\s]?3/i, key: 'GF-3', resM: 3, swathKm: 30, slewMax: 40, cat: 'SAR',
    src: 'cnsa.gov.cn 高分三号（1~500m，10~650km；UFS 3m/30km）' },
  // GF-4 GEO 凝视：可见光 50m / 幅宽优于 500km（cma.gov.cn 投用通报）
  { re: /^GAOFEN[-\s]?4/i, key: 'GF-4', resM: 50, swathKm: 500, slewMax: 0, cat: '光学',
    src: 'cma.gov.cn 高分四号投用（50m，幅宽优于500km）' },
  { re: /^GAOFEN[-\s]?5/i, key: 'GF-5', resM: 30, swathKm: 60, slewMax: 25, cat: '高光谱',
    src: 'AHSI 60km 幅宽 / 30m（航天返回与遥感 2018;39(3)）；VIMI 60km/20m' },
  { re: /^GAOFEN[-\s]?6/i, key: 'GF-6', resM: 2, swathKm: 90, slewMax: 25, cat: '光学',
    src: 'cnsa.gov.cn 高分六号（2m 相机幅宽90km，16m 宽幅800km）' },
  // 高分七号：0.8m 双线阵立体测绘，幅宽 20km，侧摆 ±32°（cnsa 在轨四周年参数表）
  { re: /^GAOFEN[-\s]?7/i, key: 'GF-7', resM: 0.8, swathKm: 20, slewMax: 32, cat: '光学',
    src: 'cnsa.gov.cn GF-7（0.8m，幅宽20km，侧摆±32°）' },
  // 高分八号：与 GF-2 同源 1m/0.8m 级敏捷光学（幅宽 45km 量级，typical）
  { re: /^GAOFEN[-\s]?8/i, key: 'GF-8', resM: 1, swathKm: 45, slewMax: 35, cat: '光学',
    src: 'GF-8 亚米级敏捷光学（typical：45km，对标GF-2）' },
  // 高分九号：官方只说“亚米级”，幅宽从未公开（0.8m@60km 需 7.5 万像元，物理不可能）。
  // 取 0.8m 级敏捷卫星常见幅宽 20km（typical，偏保守）
  { re: /^GAOFEN[-\s]?9/i, key: 'GF-9', resM: 0.8, swathKm: 20, slewMax: 35, cat: '光学',
    src: 'GF-9 亚米级（幅宽官方未公开；取 0.8m 级常见 20km，typical）' },
  // 高分十号：SAR（C 波段）。注：库中名称为 GAOFEN-10R，必须在 GAOFEN-1x 系列之前判定，
  // 否则会被 GAOFEN-1 的正则吞掉而错配成光学 60km（2026-11-15 核验发现的真实错配）
  { re: /^GAOFEN[-\s]?10(?![0-9])|^GAOFEN[-\s]?10R/i, key: 'GF-10', resM: 1, swathKm: 30, slewMax: 40, cat: 'SAR',
    src: 'GF-10 SAR（C 波段；幅宽官方未公开，取1m条带30km typical）' },
  // 高分十一号：亚米级高分辨率光学，幅宽官方未公开（取 0.8m 级常见 20km，typical 偏保守）
  { re: /^GAOFEN[-\s]?11/i, key: 'GF-11', resM: 0.8, swathKm: 20, slewMax: 35, cat: '光学',
    src: 'cnsa.gov.cn 高分十一号（亚米级；幅宽未官方公开，取20km typical）' },
  // 高分十二号：SAR（C 波段 1m 级，幅宽 30km 量级）
  { re: /^GAOFEN[-\s]?12/i, key: 'GF-12', resM: 1, swathKm: 30, slewMax: 40, cat: 'SAR',
    src: 'GF-12 SAR（typical：1m 条带30km）' },
  // 高分十三号：GEO 高轨光学（官方未公开参数，按 GF-4 同源推断，typical）
  { re: /^GAOFEN[-\s]?13/i, key: 'GF-13', resM: 50, swathKm: 500, slewMax: 0, cat: '光学',
    src: 'GF-13 GEO 光学（官方未公开，按 GF-4 同源推断 50m/500km typical）' },
  // 高分十四号：立体测绘（0.8m 级）
  { re: /^GAOFEN[-\s]?14/i, key: 'GF-14', resM: 0.8, swathKm: 20, slewMax: 25, cat: '光学',
    src: 'GF-14 测绘（typical：0.8m/20km）' },

  // ── 资源系列（自然资源部国土卫星遥感应用中心 lasac.cn / 中国资源卫星应用中心）──
  // 资源三号：正视 2.1m，幅宽 >50km（lasac.cn 参数表）；Skyrocket 记 51km
  { re: /^ZIYUAN[-\s]?3|^ZY[-\s]?3/i, key: 'ZY-3', resM: 2.1, swathKm: 51, slewMax: 32, cat: '光学',
    src: 'lasac.cn 资源三号参数表（正视2.1m，幅宽>50km）' },
  // 资源一号 02D（5米光学卫星）：2.5m 全色，幅宽 115km（中新网/新华社）
  { re: /^ZIYUAN[-\s]?1[-\s]?02D|^ZY[-\s]?1[-\s]?02D/i, key: 'ZY1-02D', resM: 2.5, swathKm: 115, slewMax: 26, cat: '光学',
    src: '新华社/中新网 资源一号02D（2.5m，幅宽115km）' },
  // 资源一号 02C：2.36m 全色 / 幅宽 54km
  { re: /^ZIYUAN[-\s]?1|^ZY[-\s]?1/i, key: 'ZY-1', resM: 2.36, swathKm: 54, slewMax: 32, cat: '光学',
    src: 'ZY-1 02C（2.36m PAN，幅宽54km）' },
  { re: /^ZIYUAN|^ZY[-\s]?/i, key: 'ZY-GENERIC', resM: 2, swathKm: 60, slewMax: 32, cat: '光学',
    src: '资源系列 typical' },

  // ── 天绘（中国空间技术研究院 cast.cn）──
  // 天绘一号：2m / 幅宽 60km（cast.cn 官方：幅宽60km、2m）
  { re: /^TIANHUI[-\s]?1/i, key: 'TH-1', resM: 2, swathKm: 60, slewMax: 32, cat: '光学',
    src: 'cast.cn 天绘一号（2m，幅宽60km）' },
  // 天绘二号：双星 InSAR 地形测绘，幅宽 30km 量级；
  // 该类星在库中标注为 optical，故类别以库标为准（类型判定优先于型号推断），仅提供幅宽/分辨率
  { re: /^TIANHUI[-\s]?2/i, key: 'TH-2', resM: 3, swathKm: 30, slewMax: 30, cat: '光学',
    src: '天绘二号双星 InSAR（typical：3m/30km；库标注为光学）' },
  { re: /^TIANHUI/i, key: 'TH-GENERIC', resM: 2, swathKm: 60, slewMax: 32, cat: '光学',
    src: '天绘系列 typical' },

  // ── 高景 / 四维（中国四维，航天世景 spacewillinfo.com）──
  // 四维高景一号 01/02：0.5m，幅宽 12km（航天世景官网页）
  { re: /^SUPERVIEW/i, key: 'SV', resM: 0.5, swathKm: 12, slewMax: 45, cat: '光学',
    src: 'spacewillinfo.com 四维高景一号（0.5m，幅宽12km）' },

  // ── 国际 ──
  // Sentinel-1：C 波段 SAR IW 模式 5m/250km
  { re: /^SENTINEL[-\s]?1/i, key: 'S1', resM: 5, swathKm: 250, slewMax: 30, cat: 'SAR',
    src: 'ESA Copernicus Sentinel-1 IW（5m×20m，幅宽250km）' },
  // Sentinel-2：10m 多光谱，幅宽 290km
  { re: /^SENTINEL[-\s]?2/i, key: 'S2', resM: 10, swathKm: 290, slewMax: 0, cat: '光学',
    src: 'ESA Sentinel-2 MSI（10m，幅宽290km）' },
  // Sentinel-3：OLCI 300m，幅宽 1270km（SLSTR 1400km）
  { re: /^SENTINEL[-\s]?3/i, key: 'S3', resM: 300, swathKm: 1270, slewMax: 0, cat: '光学',
    src: 'ESA Sentinel-3 OLCI（300m，幅宽1270km）' },
  { re: /^SENTINEL[-\s]?6/i, key: 'S6', resM: 300, swathKm: 300, slewMax: 0, cat: '光学',
    src: 'Sentinel-6 高度计（typical）' },
  // WorldView 按代拆分（earth.esa.int / Maxar·EUSI datasheet）
  { re: /^WORLDVIEW[-\s]?1|^WV[-\s]?1/i, key: 'WV-1', resM: 0.5, swathKm: 17.6, slewMax: 45, cat: '光学',
    src: 'earth.esa.int WorldView 系列（WV-1 0.5m，星下点幅宽17.6km）' },
  { re: /^WORLDVIEW[-\s]?2/i, key: 'WV-2', resM: 0.46, swathKm: 16.4, slewMax: 45, cat: '光学',
    src: 'earth.esa.int WorldView 系列（WV-2 0.46m，星下点幅宽16.4km）' },
  { re: /^WORLDVIEW|^WV[-\s]?/i, key: 'WV-3', resM: 0.31, swathKm: 13.1, slewMax: 45, cat: '光学',
    src: 'EUSI WorldView-3 datasheet（31cm，星下点幅宽13.1km）' },
  // Pléiades 1A/1B：0.5m/2m，幅宽 20km
  { re: /^PLEIADES(?!.*NEO)/i, key: 'PHR', resM: 0.5, swathKm: 20, slewMax: 45, cat: '光学',
    src: 'Airbus Pléiades 1A/1B（0.5m，幅宽20km）' },
  // Pléiades Neo：0.3m，幅宽 14km（ESA/WMO OSCAR）
  { re: /^PLEIADES NEO/i, key: 'PNEO', resM: 0.3, swathKm: 14, slewMax: 30, cat: '光学',
    src: 'ESA Earth Online / WMO OSCAR（0.3m，幅宽14km）' },
  { re: /^GEOEYE/i, key: 'GEOEYE', resM: 0.41, swathKm: 15.3, slewMax: 45, cat: '光学',
    src: 'Maxar/Terradue GeoEye-1（0.41m，星下点幅宽15.3km）' },
  { re: /^LANDSAT/i, key: 'LANDSAT', resM: 15, swathKm: 185, slewMax: 15, cat: '光学',
    src: 'USGS Landsat 8/9 OLI（15m 全色，幅宽185km）' },
  // ALOS-4 (DAICHI-4)：PALSAR-3 条带 10m / 200km（JAXA/EORC）
  { re: /^ALOS[-\s]?4|^DAICHI[-\s]?4/i, key: 'ALOS-4', resM: 10, swathKm: 200, slewMax: 30, cat: 'SAR',
    src: 'JAXA EORC ALOS-4（PALSAR-3 条带10m/200km）' },
  // ALOS-2：PALSAR-2 条带 10m / 70km（RESTEC / NASA Earthdata）
  { re: /^ALOS/i, key: 'ALOS-2', resM: 10, swathKm: 70, slewMax: 30, cat: 'SAR',
    src: 'RESTEC ALOS-2 PALSAR-2（条带10m/70km）' },
  // ICEYE：模式必须取自同一档——取 Strip 3m/30km（1m 仅对应 Spot 5km）
  { re: /^ICEYE/i, key: 'ICEYE', resM: 3, swathKm: 30, slewMax: 30, cat: 'SAR',
    src: 'ICEYE Product Specification（Strip 3m/30km；Spot 1m/5km）' },
  { re: /^GEO-KOMPSAT/i, key: 'GK2A', resM: 500, swathKm: 1000, slewMax: 0, cat: '光学',
    src: 'GEO-KOMPSAT-2A AMI（500m，GEO 全盘）' },
  { re: /^HAIYANG/i, key: 'HY', resM: 50, swathKm: 500, slewMax: 20, cat: '光学',
    src: '海洋系列（typical）' },
  { re: /^FENGYUN/i, key: 'FY', resM: 500, swathKm: 500, slewMax: 10, cat: '气象',
    src: '风云系列（typical）' },
  // ── 遥感（YAOGAN）系列：必须按子系列细分，光学与 SAR 混编 ──────────────────
  // 历史坑：曾用一条 ^YAOGAN 通配把所有遥感星判成 SAR，导致遥-30 这类光学星座
  // 在光学任务里被整体筛掉（"候选里没有中国星"的直接原因之一）。
  // 遥-30：光学成像星座（0.72m 级，幅宽约 12km 量级）—— 官方未公开完整参数，取典型值
  { re: /^YAOGAN[-\s]?30/i, key: 'YG-30', resM: 0.72, swathKm: 12, slewMax: 45, cat: '光学',
    src: '遥感三十号 光学星座（typical：0.72m/12km）' },
  // 遥-33：立体测绘光学（1:5万测图），幅宽约 50km 量级
  { re: /^YAOGAN[-\s]?33/i, key: 'YG-33', resM: 2, swathKm: 50, slewMax: 32, cat: '光学',
    src: '遥感三十三号 立体测绘光学（typical：2m/50km）' },
  // 遥-3（YAOGAN-3，NORAD 32289）：598km 光学成像，须在通配 SAR 规则前命中
  { re: /^YAOGAN[-\s]?3(?![0-9])/i, key: 'YG-3', resM: 1, swathKm: 20, slewMax: 40, cat: '光学',
    src: '遥感三号 光学（typical：1m/20km）' },
  // 遥-31 / 40 / 43：SAR（C 波段）。必须排在光学规则之前，且允许 "01A/02B" 这类子型号后缀
  { re: /^YAOGAN[-\s]?(31|40|43)(?![0-9])/i, key: 'YG-SAR', resM: 3, swathKm: 30, slewMax: 40, cat: 'SAR',
    src: '遥感系列 SAR（typical：3m/30km）' },
  // 遥-32 / 42 / 12 / 47：光学成像（注意 4 要加边界，避免吞掉 40/43/45/46）
  { re: /^YAOGAN[-\s]?(32|42|12|47)(?![0-9])/i, key: 'YG-OPT', resM: 1, swathKm: 20, slewMax: 40, cat: '光学',
    src: '遥感系列光学（typical：1m/20km）' },
  { re: /^YAOGAN[-\s]?4(?![0-9])/i, key: 'YG-OPT', resM: 1, swathKm: 20, slewMax: 40, cat: '光学',
    src: '遥感四号 光学（typical：1m/20km）' },
  // 其余遥感星：类型未明确，按 SAR 保守处理（不误入光学候选）
  { re: /^YAOGAN/i, key: 'YG', resM: 3, swathKm: 30, slewMax: 40, cat: 'SAR',
    src: '遥感系列（类型未明确，typical SAR）' },
];

// 未收录型号的类别兜底（保守优先：宁小勿大——幅宽估大会让拍不到的任务被放行）
const CATEGORY_FALLBACK = {
  imaging: { resM: 1.0, swathKm: 14, slewMax: 40, cat: '光学' },
  recon: { resM: 3, swathKm: 30, slewMax: 40, cat: 'SAR' },
  weather: { resM: 500, swathKm: 500, slewMax: 10, cat: '气象' },
};

/**
 * 按卫星查型号规格。名字用正则从具体到泛匹配（SAT_SPECS 已按优先级排序），
 * 避免历史 startWith 前缀匹配造成的错配（如 JILIN-1 GAOFEN 03D50 落到 JILIN 统配）。
 * @param {{name?:string, category?:string, subCategory?:string}} sat
 * @returns {{key:string,resM:number,swathKm:number,slewMax:number,cat:string,src:string,fallback:boolean}}
 */
/**
 * 未收录型号兜底：保守优先。宁可将幅宽估小（判“拍不到”后人工复核），
 * 不可估大（让根本拍不到的任务被放行）。历史上的 100km/30m 兜底对 0.5m 商业光学星
 * 是量级错误（estDataMB 会放大千倍），已改为 14km/1m 级保守值。
 */
export function getSatSpec(sat) {
  const name = (sat?.name ?? '').toUpperCase().trim();
  if (name) {
    for (const s of SAT_SPECS) {
      if (s.re.test(name)) {
        return { key: s.key, resM: s.resM, swathKm: s.swathKm, slewMax: s.slewMax, cat: s.cat, src: s.src, fallback: false };
      }
    }
  }
  // 名称没命中：按数据库标注的载荷类型兜底（SAR 星给 SAR 口径）
  if (sat?.subCategory === 'sar') return { key: 'GENERIC-SAR', resM: 3, swathKm: 30, slewMax: 40, cat: 'SAR', src: '类别兜底（SAR 3m/30km）', fallback: true };
  const f = CATEGORY_FALLBACK[sat?.category] ?? CATEGORY_FALLBACK.imaging;
  return { key: 'GENERIC', ...f, src: '类别兜底（typical，保守）', fallback: true };
}

// 向后兼容：既有代码按 {resolution, swathKm, slewLimitDeg, spectral} 结构取用
export function getCapabilityBySpec(sat) {
  const s = getSatSpec(sat);
  return { resolution: s.resM, swathKm: s.swathKm, slewLimitDeg: s.slewMax, spectral: s.cat, key: s.key, src: s.src };
}
