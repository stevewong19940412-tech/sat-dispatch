// 卫星载荷参数库（相机体制/量化位数/侧摆速率/像元尺寸）
// ⚠️ 幅宽、分辨率、侧摆上限自 2026-11-15 统一由 sat_specs.mjs 提供（官方公开参数），本表不再维护，
//    避免出现 JILIN swathKm=150 与 DEFAULT_CAPS=12 这类同一型号两套口径的冲突。
// 标注规则：real（文献/官方真实值）、typical（类别典型值，型号未公开）
// 字段规格依据：docs/载荷参数规格-真实调研.md + CN102830951B（指令时序） + CCSDS 231/232（指令格式）
import { getSatSpec } from "./sat_specs.mjs";

export const PAYLOAD_SPECS = {
  'GAOFEN-1': { quantBits: 10, quantSrc: 'typical', slewRate: 0.13, slewSrc: 'real(±25°/200s,应急35°)', tdiSrc: 'typical', pixelUm: 10,
             mode: 'strip', camera: 'TDI-CCD线阵推扫' },
  'GAOFEN-2': { quantBits: 10, quantSrc: 'typical', slewRate: 0.19, slewSrc: 'real(±35°/180s)', tdiSrc: 'typical', pixelUm: 10,
             mode: 'strip', camera: 'TDI-CCD线阵推扫' },
  'GAOFEN-4': { quantBits: 10, quantSrc: 'typical', slewRate: 0,    slewSrc: 'GEO凝视指向控制', tdiSrc: 'n/a(CMOS电子快门)', pixelUm: 10,
             mode: 'staring', camera: '面阵凝视CMOS' },
  'GAOFEN-6': { quantBits: 10, quantSrc: 'typical', slewRate: 0.13, slewSrc: 'typical(±25°级)', tdiSrc: 'typical(CMOS非TDI)', pixelUm: 10,
             mode: 'strip', camera: '线阵推扫+宽幅CMOS' },
  'JILIN': { quantBits: 12, quantSrc: 'typical', slewRate: 1.0,  slewSrc: 'real(高分02系列±45°)', tdiSrc: 'typical', pixelUm: 7,
             mode: 'strip+multiStrip', camera: 'TDI-CCD推扫' },
  'SUPERVIEW': { quantBits: 11, quantSrc: 'real(SV-1 11bit)', slewRate: 1.2, slewSrc: 'real(±30°重点45°)', tdiSrc: 'typical', pixelUm: 8,
             mode: 'strip', camera: 'TDI-CCD推扫' },
  'ZY3': { quantBits: 10, quantSrc: 'typical', slewRate: 0.3,  slewSrc: 'real(±32°)', tdiSrc: 'typical', pixelUm: 10,
             mode: 'strip+stereo', camera: 'TDI-CCD三线阵' },
  'HAIYANG': { quantBits: 10, quantSrc: 'typical', slewRate: 0,    slewSrc: 'SAR条带模式', tdiSrc: 'n/a(SAR)', pixelUm: 0,
             mode: 'sarStrip', camera: 'SAR-C' },
};

// 按卫星名匹配载荷规格：相机体制取本表，幅宽/分辨率/侧摆取 sat_specs 单一数据源
export function getPayloadSpec(satName, satMeta = null) {
  const key = Object.keys(PAYLOAD_SPECS).find(k => satName?.toUpperCase().startsWith(k));
  // 载荷类型以数据库标注（satMeta.subCategory）为准，名称只用于查参数。
  // 历史 bug：JILIN GAOFEN OBJECT G 等 SAR 星因名称匹配到 JILIN 光学规则，
  // 直控时生成 TDI-CCD 光学指令（相机/压缩/量化位全错）。
  const spec = getSatSpec({ name: satName, subCategory: satMeta?.subCategory, category: satMeta?.category });
  const isSarSat = satMeta?.subCategory === 'sar' || spec.cat === 'SAR';
  const base = key ? { series: key, ...PAYLOAD_SPECS[key] } : {
    series: 'GENERIC', quantBits: 10, quantSrc: 'typical',
    slewRate: spec.cat === 'SAR' ? 0 : 1.0, slewSrc: 'typical', tdiSrc: 'typical', pixelUm: 10,
    mode: spec.cat === 'SAR' ? 'sarStrip' : 'strip',
    camera: spec.cat === 'SAR' ? 'SAR' : '推扫',
  };
  // 幅宽/分辨率以型号规格表（官方公开参数）为准，避免与覆盖判定口径不一致。
  // 历史问题：本表曾写 JILIN swathKm=150、DEFAULT_CAPS 写 12，同一型号差 12 倍。
  // SAR 星强制覆盖为 SAR 参数，避免名称误匹配带来的光学参数
  if (isSarSat) {
    base.mode = 'sarStrip';
    base.camera = 'SAR-C 相控阵';
    base.tdiSrc = 'n/a(SAR)';
    base.quantSrc = base.quantSrc || 'typical';
  }
  return {
    ...base,
    isSAR: isSarSat,
    gsdPan: spec.resM,
    gsdMs: base.gsdMs ?? Math.max(2, spec.resM * 4),
    swathKm: spec.swathKm,
    slewMax: spec.slewMax,
    specKey: spec.key,
    swathSrc: spec.src,
    swathFallback: spec.fallback,
  };
}

/**
 * 直控成像参数解算（输入：明确的时间段+星历+载荷规格 → 确定性解算）
 * 依据：像移匹配 T = 像元尺寸/像面像移速度；行频 = 地面像移速度/GSD（SPIE 2016）
 *       TDI 级数按太阳高度角二维查找（侧摆角降档：大侧摆+高TDI边缘MTF退化，《红外与激光工程》2022）
 */
export function solveImagingParams({ satName, altKm, gsdM, sunElDeg, slewDeg, imagingSec }) {
  const spec = getPayloadSpec(satName) ?? {
    // 未收录型号：类别典型值兜底（标注 typical）
    series: 'GENERIC', gsdPan: gsdM, gsdMs: gsdM * 4, swathKm: 14, quantBits: 10, quantSrc: 'typical', slewRate: 1.0, slewSrc: 'typical', tdiSrc: 'typical', pixelUm: 10,
    mode: 'strip', camera: '推扫',
  };
  const isGEO = altKm > 10000;
  const isSAR = spec.mode === 'sarStrip';
  // 像移速度：v_ground = v_orbit × R/(R+h)
  const vOrbit = isGEO ? 3.1 : 7.5;
  const vGround = vOrbit * 6371 / (6371 + altKm);           // km/s
  // 积分时间 T = GSD / v_ground（秒）——行频匹配
  const integrationSec = gsdM / 1000 / vGround;
  // TDI 级数：太阳高度角分档 + 侧摆降档
  let tdi = sunElDeg > 30 ? 32 : sunElDeg >= 10 ? 64 : 96;   // 光照弱→高级数
  if (slewDeg > 20 && tdi > 64) tdi = 64;                    // 侧摆降档（MTF保护）
  if (slewDeg > 35 && tdi > 32) tdi = 32;
  // 压缩比：JPEG2000 遥感工程 4:1~8:1（近无损2:1）
  const compression = gsdM <= 1 ? 4 : gsdM <= 4 ? 6 : 8;
  // 成像数据量：V(MB) ≈ (幅宽/GSD)×(沿轨长度/GSD)×量化位数/8，沿轨长度≈v_ground×成像时长
  const widePx = (spec.swathKm * 1000) / gsdM;             // 宽像素数
  const alongKm = vGround * imagingSec;                    // km
  const dataMB = Math.round(((spec.swathKm * 1000) / gsdM) * ((alongKm * 1000) / gsdM) * (spec.quantBits / 8) / 1024 / 1024);
  return {
    camera: spec.camera,
    imagingMode: isGEO ? '凝视' : isSAR ? 'SAR条带' : '主动推扫',
    gsdM, swathKm: spec.swathKm,
    quantBits: spec.quantBits, quantSource: spec.quantSrc,
    tdiStages: isSAR || isGEO ? null : tdi, tdiSource: spec.tdiSrc,
    integrationMs: Math.round(integrationSec * 1e6) / 1000,
    lineRateHz: Math.round(1 / integrationSec),              // 行频 = 1/积分时间
    imageMotionVelKmS: Math.round(vGround * 100) / 100,
    gain: sunElDeg > 30 ? '低' : sunElDeg >= 10 ? '中' : '高',
    compression, compressionMode: 'JPEG2000',
    estDataMB: dataMB, estDataRows: Math.round(alongKm * 1000 / gsdM),
    slewDeg: Math.round(slewDeg * 10) / 10,
    slewRateLimitDegS: spec.slewRate, slewSource: spec.slewSrc,
    sources: { swath: spec.swathSrc, quant: spec.quantSrc, slew: spec.slewSrc, tdi: spec.tdiSrc },
  };
}

/**
 * 指令时序（CN102830951B 真实结构）：全部指令以 T0 为基准的相对偏移；
 * 分系统顺序：姿控机动 → 稳定等待 → 相机开机 → 成像 → 关机；数据量决定数传需求。
 * 机动时长按 slewRate 三段式（加速-匀速-减速含稳定）：
 */
export function solveCommandTimeline({ slewDeg, slewRateDegS, stabilizeSec = 10, warmupSec = 8, imagingSec }) {
  const slewTime = slewRateDegS > 0 ? Math.abs(slewDeg) / slewRateDegS + 2 : 5; // +2s 加减速余量
  let off = 0;
  const mk = (action, duration, param) => {
    const cmd = { seq: 0, action, startOffset: Math.round(off * 10) / 10, duration: Math.round(duration * 10) / 10, ...(param ? { param } : {}) };
    off += duration + 1; // 相邻指令 1s 间隔
    return cmd;
  };
  const commands = [
    mk('姿态机动', slewTime, { rollDeg: Math.round(slewDeg * 10) / 10 }),
    mk('姿态稳定', stabilizeSec),
    mk('相机开机', warmupSec),
    mk('成像', imagingSec),
    mk('相机关机', 2),
  ];
  commands.forEach((c, i) => { c.seq = i + 1; });
  // 成像中点对准 TCA：序列起点 T0 = TCA - (机动+稳定+开机+间隔+成像/2)
  const preSec = off - 1 - imagingSec / 2; // 去掉尾部间隔与后半成像
  return { commands, preSec };
}

/**
 * 上注约束校验（CCSDS/遥控作业规范口径）：
 * 单弧段上行 KB ≈ 上行速率(bps)×弧段时长(s)/8/1024；参数包 23~92B/指令（压缩上注）
 */
export function solveUplinkBudget({ arcDurationSec, uplinkBps = 2000, commandCount }) {
  const budgetKB = Math.round(arcDurationSec * uplinkBps / 8 / 1024 * 10) / 10;
  const perCmdB = 23; // CN102830951B 压缩上注 23B/指令
  const needKB = Math.round(commandCount * perCmdB / 1024 * 1000) / 1000;
  return { budgetKB, needKB, fits: needKB <= budgetKB, uplinkBps };
}
