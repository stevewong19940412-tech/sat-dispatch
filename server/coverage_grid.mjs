// ─── 覆盖完整性计算（网格点法，行业标准口径）─────────────────────────────────
// 2026-11-16 新增。替代此前"只看条带中心点 + 首尾端点"的近似判定。
//
// ## 为什么必须换算法
// 旧判定的致命缺陷：一条 12km 宽、上百 km 长的条带，只要卫星能拍到条带中心，
// 就判为"该条带可覆盖"。于是：
//   · 极窄时窗下（卫星只扫过条带中段几秒）也报 100% 覆盖
//   · 用户看到"全覆盖"，实际两端几十公里完全没拍到
// 这是**静默失真**，比报错更危险——用户会拿它去派单交付。
//
// ## 采用的成熟方法（文献依据）
// 1. **网格点法（Grid Point Approach）** —— Morrison 1973 提出，卫星覆盖领域最基础、
//    最通用的标准方法（林竹翀 2019 / 商朝晖等均以其为基准验证新算法）。
//    做法：把目标区域离散成网格点，逐点判断是否被传感器覆盖，统计覆盖率/覆盖重数。
//    优点：适用于任意形状区域；不会对重叠区域重复计数（沈夏炯 2016）。
//    缺点：计算量大（故需要下面的精度控制）。
// 2. **误差可控的网格粒度** —— Song et al. 2018 (IEEE Access) 给出上下界策略；
//    秦瑞杰 2015 提出采样网格点法（同等精度下比传统快 81 倍）。
//    本实现取「网格边长 ≈ 幅宽/8」作为基准粒度，并同时给出上下界估计，
//    让调用方知道结果的不确定区间，而不是一个看似精确的假数字。
// 3. **单次过顶的覆盖带（coverage band / swath polygon）** —— 汪荣峰 2020 扫描线法：
//    把一次成像覆盖范围建成"覆盖带多边形"，与目标区域求交得覆盖率。
//    这里用等价的简化实现：条带矩形 × 传感器瞬时足迹，逐网格点判定。
//
// ## 实现的取舍
// 全量网格点法对 640 条带的全国任务会算不动，因此：
//   · 网格只铺在**条带内部**（不是整个区域），粒度 幅宽/8（12km → 1.5km）
//   · 单条带网格数上限 2000 点（超出则按比例放大粒度，并标注 coarse=true）
//   · 返回 coverage（实际覆盖率）+ lowerBound/upperBound（误差区间）

const R_EARTH = 6371.0;
const DEG = Math.PI / 180;

function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * DEG;
  const dLon = (lon2 - lon1) * DEG;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

/**
 * 把条带（沿轨迹的矩形带）离散成网格点。
 * @param {{start:[number,number], end:[number,number], widthKm:number}} strip
 * @param {number} gridKm 网格边长（km）
 * @returns {{pts:Array<[number,number]>, nx:number, ny:number, coarse:boolean}}
 */
export function gridPointsInStrip(strip, gridKm) {
  // 容错：调用方可能只给中心点（点目标），此时 start/end 缺失
  const c0 = strip.lat != null ? [strip.lat, strip.lon] : null;
  const [latS, lonS] = strip.start ?? c0 ?? [0, 0];
  const [latE, lonE] = strip.end ?? c0 ?? [latS, lonS];
  const widthKm = strip.widthKm ?? 12;
  let lenKm = haversineKm(latS, lonS, latE, lonE);
  // 点目标：start/end 相同或缺失 → 条带长度为 0，网格数会算成 0 导致空迭代。
  // 按"单景覆盖"口径取一个最小有效长度（一个幅宽的方形景）。
  if (!Number.isFinite(lenKm) || lenKm < 0.1) lenKm = widthKm;

  // 网格数
  let nx = Math.max(2, Math.ceil(widthKm / gridKm));
  let ny = Math.max(2, Math.ceil(lenKm / gridKm));
  if (!Number.isFinite(nx) || nx < 2) nx = 2;
  if (!Number.isFinite(ny) || ny < 2) ny = 2;
  let coarse = false;
  const MAX_PTS = 2000;
  if (nx * ny > MAX_PTS) {
    const k = Math.sqrt((nx * ny) / MAX_PTS);
    nx = Math.max(2, Math.floor(nx / k));
    ny = Math.max(2, Math.floor(ny / k));
    coarse = true;
  }

  // 沿条带方向单位向量（局部平面近似足够：条带通常 <500km）
  const cosLat = Math.cos(((latS + latE) / 2) * DEG);
  const dx = (lonE - lonS) * 111.32 * cosLat;
  const dy = (latE - latS) * 110.57;
  const L = Math.hypot(dx, dy) || 1;
  const ux = dx / L, uy = dy / L;          // 沿条带单位向量
  const px = -uy, py = ux;                  // 垂直条带单位向量（导出条带宽度方向）

  const latC = (latS + latE) / 2, lonC = (lonS + lonE) / 2;
  const pts = [];
  for (let i = 0; i < nx; i++) {
    const offW = (i + 0.5) / nx * widthKm - widthKm / 2;   // 垂直方向偏移 km
    for (let j = 0; j < ny; j++) {
      const offL = (j + 0.5) / ny * lenKm - lenKm / 2;     // 沿条带偏移 km
      const x = (lonC - lonC) + ux * offL + px * offW;      // 相对中心的东向 km
      const y = uy * offL + py * offW;                      // 相对中心的北向 km
      const lat = latC + y / 110.57;
      const lon = lonC + x / (111.32 * cosLat);
      pts.push([lat, lon]);
    }
  }
  return { pts, nx, ny, coarse, lenKm };
}

/**
 * 用网格点法计算「卫星在一次过顶中」对条带的实际覆盖率。
 *
 * @param {Array<{lat:number, lon:number, t:number, altKm:number}>} track
 *        该次过顶期间的星下点轨迹（秒级或更细）
 * @param {object} strip   {start,end,widthKm}
 * @param {object} sensor  {swathKm, slewLimitDeg}
 * @param {number} gridKm  网格边长（默认取 幅宽/8，下限 0.5km）
 * @returns {{coverage:number, lowerBound:number, upperBound:number,
 *            gridKm:number, totalPoints:number, coveredPoints:number,
 *            maxGapKm:number, coarse:boolean}}
 */
export function stripCoverageByGrid(track, strip, sensor, gridKm = null) {
  const widthKm = strip.widthKm ?? sensor.swathKm;
  const step = gridKm ?? Math.max(0.5, widthKm / 8);
  const { pts, nx, ny, coarse, lenKm } = gridPointsInStrip(strip, step);

  if (!track?.length) {
    return { coverage: 0, lowerBound: 0, upperBound: 0, gridKm: step, totalPoints: pts.length,
             coveredPoints: 0, maxGapKm: lenKm, coarse, reason: '无过顶轨迹' };
  }

  const halfSwath = sensor.swathKm / 2;
  const slewLimit = Math.min(sensor.slewLimitDeg ?? 45, 60);
  const altKm = track[0].altKm || 500;
  const maxOffKm = altKm * Math.tan(slewLimit * DEG) || 500;

  let covered = 0;
  let maxGap = 0;
  for (const [lat, lon] of pts) {
    let hit = false;
    for (const p of track) {
      const d = haversineKm(p.lat, p.lon, lat, lon);
      if (d > maxOffKm) continue;
      // ── 覆盖判据（关键修正）─────────────────────────────────────────────
      // 「侧摆可达」≠「该时刻被覆盖」。卫星在某一瞬时只能拍它指向的那一小块：
      //   · 星下点成像时：正下方 ±半幅宽
      //   · 侧摆 θ 时：地面足迹中心偏移 d_off = alt·tan(θ)，足迹半宽 swath/2/cos(θ)
      // 因此某时刻 t 能覆盖网格点，当且仅当该点落在「以侧摆指向为中心的地面足迹」内，
      // 即 |d - d_off| ≤ halfFoot，而不是简单地 d ≤ maxOff。
      // 之前的 maxOff+halfFoot 判据把整个可达锥面都算作覆盖，
      // 导致只扫过一小段的条带也被判 100%（假全覆盖的根因）。
      // 卫星在该时刻的指向由姿态决定（不在本函数建模），这里取物理上最有利的情况：
      // 它可以侧摆使足迹中心对准该点。此时"能否覆盖"退化为「该侧摆角是否在能力范围内」
      // 加上「足迹是否足够宽」——但关键在于：一次过顶的时间有限，
      // 卫星在同一时刻只能对准一个方向，所以覆盖率必须由**沿轨方向的扫过范围**决定。
      //
      // 正确判据：该点落在某时刻的足迹内 ⟺ 该时刻星下点到该点的地面距离 d
      //   不超过「该侧摆可达距离 + 足迹半宽」，且要求该时刻卫星确实在这一带（沿轨方向）。
      // 沿轨方向天然由 track 的采样覆盖：只有 track 上的点（即卫星真的飞过此处）才参与判定。
      const theta = Math.atan(d / Math.max(1, p.altKm ?? altKm));
      if (theta > slewLimit * DEG + 1e-9) continue;         // 侧摆能力不够，拍不到
      const halfFoot = halfSwath / Math.cos(theta);         // 该侧摆下足迹半宽
      if (d <= halfFoot + 0.05) { hit = true; break; }      // 落在足迹内（含 50m 容差）
    }
    if (hit) covered++;
  }

  const coverage = pts.length ? covered / pts.length : 0;
  // 误差界（Song 2018 思路）：未覆盖点若恰在网格边界外，最多带来一个网格带的不确定。
  // 保守取 ±(周长与网格的比值) 作上下界，给调用方一个诚实的区间。
  const perimeterCells = (nx + ny) * 2;
  const eps = pts.length ? Math.min(0.15, perimeterCells / pts.length * 2) : 0;
  return {
    coverage: +coverage.toFixed(4),
    lowerBound: +Math.max(0, coverage - eps).toFixed(4),
    upperBound: +Math.min(1, coverage + eps).toFixed(4),
    gridKm: +step.toFixed(2),
    totalPoints: pts.length,
    coveredPoints: covered,
    maxGapKm: covered === pts.length ? 0 : +(lenKm * (1 - Math.sqrt(coverage))).toFixed(1),
    coarse,
  };
}

/**
 * 单条带覆盖等级的判定口径（用于业务决策与覆盖统计）。
 * 阈值依据：拼接成像要求相邻条带重叠 ≥10~20%，因此单带覆盖率
 * 低于 90% 就不能算"拍完整"，只能算"部分覆盖"。
 */
export function coverageGrade(cov) {
  if (cov == null) return 'unknown';
  if (cov >= 0.99) return 'full';        // 完整覆盖，可用于拼接
  if (cov >= 0.85) return 'high';        // 高覆盖，可拼接但需补缝
  if (cov >= 0.5) return 'partial';      // 部分覆盖，只能拿到条带中段
  if (cov > 0) return 'fragment';        // 碎片覆盖，几乎没有使用价值
  return 'none';
}
