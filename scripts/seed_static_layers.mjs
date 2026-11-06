// 火点/风场静态示例数据（D-2 拍板：内置静态示例）
import { setStaticLayer } from "../server/db.mjs";

// 全球典型火点热区示例（反映真实分布模式：亚马逊/非洲/东南亚/澳洲/加州）
const firePoints = [];
const regions = [
  { lat: -5, lon: -65, n: 80, spread: [10, 20] },    // 亚马逊
  { lat: 0, lon: 20, n: 100, spread: [15, 25] },     // 非洲中南部
  { lat: 0, lon: 110, n: 60, spread: [20, 30] },     // 东南亚
  { lat: -30, lon: 115, n: 30, spread: [20, 15] },   // 澳洲西部
  { lat: 38, lon: -120, n: 30, spread: [15, 10] },   // 加州
];
for (const r of regions) {
  for (let i = 0; i < r.n; i++) {
    firePoints.push({
      lat: r.lat + (Math.random() - 0.5) * r.spread[0] * 2,
      lon: r.lon + (Math.random() - 0.5) * r.spread[1] * 2,
      brightness: Math.round(310 + Math.random() * 45),
      frp: Math.round(3 + Math.random() * 35),
    });
  }
}
setStaticLayer("fire", { points: firePoints, static: true, label: "全球火点热区（静态示例数据）" });

// 海面风场示例（信风带/西风带模式）
const windPoints = [];
for (let lat = -60; lat <= 60; lat += 8) {
  for (let lon = -180; lon < 180; lon += 10) {
    let speed, direction;
    if (Math.abs(lat) < 25) {        // 信风带
      speed = 6 + Math.random() * 3;
      direction = lat > 0 ? 90 + Math.random() * 25 : 75 + Math.random() * 25; // 偏东
    } else {                          // 西风带
      speed = 9 + Math.random() * 8;
      direction = 255 + Math.random() * 30; // 偏西
    }
    windPoints.push({ lat: lat + (Math.random() - 0.5) * 3, lon: lon + (Math.random() - 0.5) * 5, speed: Math.round(speed * 10) / 10, direction: Math.round(direction) });
  }
}
setStaticLayer("wind", { points: windPoints, static: true, label: "海面风场（静态示例数据）" });

console.log("静态图层种子完成: fire", firePoints.length, "wind", windPoints.length);
