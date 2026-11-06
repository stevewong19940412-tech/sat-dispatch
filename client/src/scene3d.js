// 三维地球场景：three.js 实现，迁移自原工作台 Orbit.tsx 三维主视图
// 地球贴图已本地化（client/public/textures/），无 CDN 依赖
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const EARTH_RADIUS_KM = 6371;
const GLOBE_R = 1.0;
const EARTH_DAY_URL = "/textures/earth_texture_39ccd4c2.jpg";
const EARTH_NIGHT_URL = "/textures/earth_night_3440cbe4.jpg";

export const ORBIT_RINGS = [
  { label: "低轨 400km (LEO)", altKm: 400, color: "#22d3ee", opacity: 0.16 },
  { label: "中轨 20200km (MEO)", altKm: 20200, color: "#f59e0b", opacity: 0.10 },
  { label: "同步 35786km (GEO)", altKm: 35786, color: "#a78bfa", opacity: 0.08 },
];

// 经纬度 → 三维球面坐标（卫星高度缩放到可视化半径）
function latLonAltToVec(lat, lon, altKm) {
  // 高度压缩：LEO 可视化突出，高轨压缩到有限半径
  const r = GLOBE_R * (1 + Math.min(altKm, 42000) / EARTH_RADIUS_KM * 0.24);
  const latR = lat * Math.PI / 180;
  // three.js: y 向上为北极
  const phi = (90 - lat) * Math.PI / 180;
  const theta = (lon + 180) * Math.PI / 180;
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta)
  );
}

export function createScene(container) {
  const w = container.clientWidth;
  const h = container.clientHeight;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050910);

  const camera = new THREE.PerspectiveCamera(45, w / h, 0.01, 200);
  camera.position.set(1.6, 1.0, 2.6);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 1.15;
  controls.maxDistance = 12;
  controls.rotateSpeed = 0.5;

  // ─── 星空 ───
  const starGeo = new THREE.BufferGeometry();
  const starCount = 2400;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    const r = 40 + Math.random() * 50;
    const phi = Math.random() * Math.PI * 2;
    const cos = Math.random() * 2 - 1;
    const sin = Math.sqrt(1 - cos * cos);
    starPos[i * 3] = r * sin * Math.cos(phi);
    starPos[i * 3 + 1] = r * cos;
    starPos[i * 3 + 2] = r * sin * Math.sin(phi);
  }
  starGeo.setAttribute("position", new THREE.BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.65 })));

  // ─── 地球 ───
  const loader = new THREE.TextureLoader();
  const earthGeo = new THREE.SphereGeometry(GLOBE_R, 96, 96);
  const earthMat = new THREE.MeshPhongMaterial({
    map: loader.load(EARTH_DAY_URL),
    specular: new THREE.Color(0x111820),
    shininess: 6,
  });
  const earth = new THREE.Mesh(earthGeo, earthMat);
  earth.name = "earth";
  scene.add(earth);

  // 大气辉光
  const atmGeo = new THREE.SphereGeometry(GLOBE_R * 1.02, 48, 48);
  const atmMat = new THREE.MeshPhongMaterial({
    color: 0x2266cc, transparent: true, opacity: 0.10, side: THREE.FrontSide,
  });
  scene.add(new THREE.Mesh(atmGeo, atmMat));

  // ─── 轨道参考环 ───
  const ringGroup = new THREE.Group();
  ORBIT_RINGS.forEach(ring => {
    const r = GLOBE_R * (1 + ring.altKm / EARTH_RADIUS_KM * 0.24);
    const pts = [];
    for (let i = 0; i <= 256; i++) {
      const a = (i / 256) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(ring.color), transparent: true, opacity: ring.opacity });
    ringGroup.add(new THREE.Line(geo, mat));
  });
  scene.add(ringGroup);

  // ─── 光照 ───
  scene.add(new THREE.AmbientLight(0xffffff, 0.55));
  const sun = new THREE.DirectionalLight(0xffffff, 1.4);
  sun.position.set(5, 3, 5);
  scene.add(sun);

  // ─── 分组容器 ───
  const satGroup = new THREE.Group();       // 卫星点
  const trackGroup = new THREE.Group();     // 选中星轨迹
  const aoiGroup = new THREE.Group();       // AOI 标记
  const layerGroup = new THREE.Group();     // 环境图层（火点/风场）
  scene.add(satGroup, trackGroup, aoiGroup, layerGroup);

  // ─── 渲染循环 ───
  let animFrame = 0;
  const clock = new THREE.Clock();
  const renderLoop = () => {
    animFrame = requestAnimationFrame(renderLoop);
    controls.update();
    renderer.render(scene, camera);
  };
  renderLoop();

  // ─── 交互拾取 ───
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points = { threshold: 0.035 };
  const pointer = new THREE.Vector2();

  function pick(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(satGroup.children, false);
    if (hits.length > 0) {
      const obj = hits[0].object;
      return obj.userData?.noradId ?? null;
    }
    return null;
  }

  // 地理坐标拾取（AOI 圈选用）：射线与单位球求交
  function pickGlobe(clientX, clientY) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObject(earth, false);
    if (hits.length === 0) return null;
    const p = hits[0].point.clone().normalize();
    const lat = 90 - Math.acos(p.y) * 180 / Math.PI;
    let lon = Math.atan2(p.z, -p.x) * 180 / Math.PI - 180;
    while (lon < -180) lon += 360;
    while (lon > 180) lon -= 360;
    return { lat, lon };
  }

  function resize() {
    const w2 = container.clientWidth, h2 = container.clientHeight;
    if (w2 === 0 || h2 === 0) return;
    camera.aspect = w2 / h2;
    camera.updateProjectionMatrix();
    renderer.setSize(w2, h2);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);

  function dispose() {
    cancelAnimationFrame(animFrame);
    resizeObserver.disconnect();
    controls.dispose();
    renderer.dispose();
    if (renderer.domElement.parentElement) {
      renderer.domElement.parentElement.removeChild(renderer.domElement);
    }
  }

  return {
    scene, camera, controls, renderer,
    satGroup, trackGroup, aoiGroup, layerGroup,
    pick, pickGlobe, resize, dispose,
    latLonAltToVec,
  };
}

// ─── 卫星点管理 ───────────────────────────────────────────────────────────
export class SatelliteLayer {
  constructor(scene3d) {
    this.s3d = scene3d;
    this.meshes = new Map(); // noradId → mesh
    this.groupColors = {};
  }

  setGroupColors(colors) { this.groupColors = colors; }

  updatePositions(satellites) {
    const seen = new Set();
    for (const sat of satellites) {
      seen.add(sat.noradId);
      let mesh = this.meshes.get(sat.noradId);
      const color = new THREE.Color(this.groupColors[sat.category] ?? "#8fa3c8");
      if (!mesh) {
        const geo = new THREE.SphereGeometry(0.011, 8, 8);
        const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
        mesh = new THREE.Mesh(geo, mat);
        mesh.userData = { noradId: sat.noradId, name: sat.name };
        this.s3d.satGroup.add(mesh);
        this.meshes.set(sat.noradId, mesh);
      }
      const v = this.s3d.latLonAltToVec(sat.lat, sat.lon, sat.altKm);
      mesh.position.copy(v);
      mesh.visible = true;
    }
    // 隐藏不在此批次的
    for (const [nid, mesh] of this.meshes) {
      if (!seen.has(nid)) mesh.visible = false;
    }
  }

  setVisibleFilter(visibleSet) {
    for (const [nid, mesh] of this.meshes) {
      mesh.visible = visibleSet.has(nid);
    }
  }

  highlight(noradId) {
    for (const [nid, mesh] of this.meshes) {
      if (nid === noradId) {
        mesh.scale.setScalar(2.2);
        mesh.material.opacity = 1;
      } else {
        mesh.scale.setScalar(1);
      }
    }
  }

  clearHighlight() { this.highlight(null); }

  focusCamera(lat, lon, altKm) {
    const v = this.s3d.latLonAltToVec(lat, lon, altKm ?? 500);
    this.s3d.controls.target.copy(v.multiplyScalar(0.92));
  }

  clearAll() {
    for (const mesh of this.meshes.values()) {
      this.s3d.satGroup.remove(mesh);
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    this.meshes.clear();
  }
}

// ─── 地面轨迹线 ───────────────────────────────────────────────────────────
export class TrackLayer {
  constructor(scene3d) {
    this.s3d = scene3d;
    this.lines = [];
  }

  showTrack(track, color = "#2dd4a7") {
    this.clear();
    if (track.length < 2) return;
    const pts = track.map(p => this.s3d.latLonAltToVec(p.lat, p.lon, p.altKm));
    // 历史段（虚线）与未来段（实线）——简单起见一条渐变线
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.75 });
    const line = new THREE.Line(geo, mat);
    this.s3d.trackGroup.add(line);
    this.lines.push(line);
  }

  clear() {
    for (const line of this.lines) {
      this.s3d.trackGroup.remove(line);
      line.geometry.dispose();
      line.material.dispose();
    }
    this.lines = [];
  }
}

// ─── AOI 标记 ─────────────────────────────────────────────────────────────
export class AoiLayer {
  constructor(scene3d) {
    this.s3d = scene3d;
    this.markers = [];
  }

  // 圆形 AOI：近似画圆（球面）
  drawAoi(lat, lon, radiusKm, color = "#f5a524") {
    const group = new THREE.Group();
    // 中心点
    const centerV = this.s3d.latLonAltToVec(lat, lon, 10);
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.014, 10, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color) })
    );
    dot.position.copy(centerV);
    group.add(dot);

    // 圆环：以角半径近似
    const angRadius = radiusKm / EARTH_RADIUS_KM; // 弧度
    const pts = [];
    for (let i = 0; i <= 128; i++) {
      const brg = (i / 128) * Math.PI * 2;
      const latR = lat * Math.PI / 180, lonR = lon * Math.PI / 180;
      // 球面极坐标公式
      const pLat = Math.asin(Math.sin(latR) * Math.cos(angRadius) + Math.cos(latR) * Math.sin(angRadius) * Math.cos(brg));
      const pLon = lonR + Math.atan2(
        Math.sin(brg) * Math.sin(angRadius) * Math.cos(latR),
        Math.cos(angRadius) - Math.sin(latR) * Math.sin(pLat)
      );
      const pLatDeg = pLat * 180 / Math.PI;
      const pLonDeg = pLon * 180 / Math.PI;
      pts.push(this.s3d.latLonAltToVec(pLatDeg, pLonDeg, 10));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.85 });
    const ring = new THREE.Line(geo, mat);
    group.add(ring);

    // 半透明填充
    const fillGeo = new THREE.BufferGeometry().setFromPoints(
      pts.map(p => p.clone().multiplyScalar(0.995)).concat([centerV.clone().multiplyScalar(0.995)])
    );
    const fillMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(color), transparent: true, opacity: 0.07, side: THREE.DoubleSide,
    });
    const fan = new THREE.Mesh(fillGeo, fillMat);
    group.add(fan);

    this.s3d.aoiGroup.add(group);
    this.markers.push(group);
    return group;
  }

  // AOI 覆盖判定：卫星星下点是否在圆内
  static isInside(lat, lon, aoiLat, aoiLon, radiusKm) {
    const R = EARTH_RADIUS_KM;
    const dLat = (aoiLat - lat) * Math.PI / 180;
    const dLon = (aoiLon - lon) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * Math.PI / 180) * Math.cos(aoiLat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const d = 2 * R * Math.asin(Math.sqrt(a));
    return d <= radiusKm;
  }

  clear() {
    for (const g of this.markers) {
      this.s3d.aoiGroup.remove(g);
      g.traverse(obj => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) obj.material.dispose();
      });
    }
    this.markers = [];
  }
}

// ─── 环境图层（火点/风场静态示例） ─────────────────────────────────────────
export class EnvLayer {
  constructor(scene3d) {
    this.s3d = scene3d;
    this.objects = [];
  }

  showFireHotspots(points) {
    this.clearFire();
    const positions = new Float32Array(points.length * 3);
    points.forEach((p, i) => {
      const v = this.s3d.latLonAltToVec(p.lat, p.lon, 10);
      positions[i * 3] = v.x; positions[i * 3 + 1] = v.y; positions[i * 3 + 2] = v.z;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0xff6b3d, size: 0.02, transparent: true, opacity: 0.85,
      sizeAttenuation: true,
    });
    const dots = new THREE.Points(geo, mat);
    dots.name = "fire";
    this.s3d.layerGroup.add(dots);
    this.objects.push(dots);
  }

  showWindField(points) {
    this.clearWind();
    // 风场箭头：小线段指向风吹方向
    for (const p of points.slice(0, 400)) {
      const v = this.s3d.latLonAltToVec(p.lat, p.lon, 10);
      // 风向：direction 度（气象惯例：来向），转地表东/北分量
      const rad = (p.direction ?? 0) * Math.PI / 180;
      const len = 0.012 + (p.speed ?? 10) * 0.0012;
      const east = new THREE.Vector3(0, 0, 1);
      const north = new THREE.Vector3(0, 1, 0);
      // 简化：在切平面上近似
      const dir = new THREE.Vector3(
        Math.sin(rad) * east.x + Math.cos(rad) * north.x,
        Math.cos(rad) * north.y,
        Math.sin(rad) * east.z
      ).normalize().multiplyScalar(len);
      const geo = new THREE.BufferGeometry().setFromPoints([
        v.clone().multiplyScalar(1.002),
        v.clone().add(dir).multiplyScalar(1.002),
      ]);
      const mat = new THREE.LineBasicMaterial({ color: 0x7ec8ff, transparent: true, opacity: 0.4 });
      const line = new THREE.Line(geo, mat);
      line.name = "wind";
      this.s3d.layerGroup.add(line);
      this.objects.push(line);
    }
  }

  clearFire() {
    this.objects = this.objects.filter(o => {
      if (o.name === "fire") { this.s3d.layerGroup.remove(o); o.geometry.dispose(); o.material.dispose(); return false; }
      return true;
    });
  }
  clearWind() {
    this.objects = this.objects.filter(o => {
      if (o.name === "wind") { this.s3d.layerGroup.remove(o); o.geometry.dispose(); o.material.dispose(); return false; }
      return true;
    });
  }
  clearAll() {
    for (const o of this.objects) {
      this.s3d.layerGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    }
    this.objects = [];
  }
}
