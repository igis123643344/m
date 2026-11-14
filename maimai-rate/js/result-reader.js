// リザルト写真を「画面の決まった位置」から読む方式
//  1. 写真から丸い画面を見つけて正方形に切り出す
//  2. 紺色のタイトルバーを目印に、各項目の位置を決める
//  3. 達成率はゲームの数字の形との照合（型合わせ）、DXスコアと曲名は位置を絞った文字認識、
//     難易度・譜面の種類・FC/AP は色で判定
// 位置の情報は LAYOUT にまとめてある（画面が変わったらここを直す）
import { getWorker } from './ocr.js';
import { norm, bigrams, dice } from './songs.js';

export const LAYOUT = {
  version: 'PRiSM-2024',
  // タイトルバー上端からの相対位置 [x0, dy0, x1, dy1]（画面の直径 = 1）
  ach: [0, 0.10, 0.64, 0.245],
  title: [0.24, -0.005, 0.9, 0.055],
  diffbar: [0.24, -0.06, 0.62, -0.01],
  badge: [0.62, -0.055, 0.77, -0.005],
  fc: [0.22, 0.45, 0.36, 0.62],
  dxSearch: [0.55, 0.38, 0.98, 0.74],
};

const N = 1600; // 切り出した画面の大きさ（px）

// ---------- 画像の小道具 ----------
function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}
function ctx2d(c) {
  const x = c.getContext('2d', { willReadFrequently: true });
  x.imageSmoothingEnabled = true;
  x.imageSmoothingQuality = 'high';
  return x;
}
function pixels(c) {
  return ctx2d(c).getImageData(0, 0, c.width, c.height).data;
}
function hsv(data, n) {
  const H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = data[p] / 255, g = data[p + 1] / 255, b = data[p + 2] / 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn + 1e-6;
    let h;
    if (mx === r) h = (((g - b) / d) % 6 + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    H[i] = h * 60; S[i] = (mx - mn) / (mx + 1e-6); V[i] = mx;
  }
  return { H, S, V };
}
function dilate(m, w, h, it = 1) {
  let a = m;
  for (let k = 0; k < it; k++) {
    const b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 0;
      for (let dy = -1; dy <= 1 && !v; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && a[yy * w + xx]) { v = 1; break; }
      }
      b[y * w + x] = v;
    }
    a = b;
  }
  return a;
}
function erode(m, w, h, it = 1) {
  let a = m;
  for (let k = 0; k < it; k++) {
    const b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = 1;
      for (let dy = -1; dy <= 1 && v; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy < 0 || yy >= h || xx < 0 || xx >= w || !a[yy * w + xx]) { v = 0; break; }
      }
      b[y * w + x] = v;
    }
    a = b;
  }
  return a;
}
// つながった塊を数える（4近傍）
function label(m, w, h) {
  const lab = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  let id = 0;
  for (let i = 0; i < w * h; i++) {
    if (!m[i] || lab[i]) continue;
    id++;
    let x0 = w, x1 = -1, y0 = h, y1 = -1, area = 0;
    stack.push(i); lab[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const x = p % w, y = (p / w) | 0;
      area++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = id; stack.push(p + w); }
    }
    comps.push({ id, x0, x1: x1 + 1, y0, y1: y1 + 1, area });
  }
  return { lab, comps };
}

// ---------- 1. 丸い画面を見つける ----------
// 画面の縁（明るい画面 → 外側の黒い枠）を円で探す。画面の外の白い光や上のモニターに強い
export function detectScreenRing(bitmap) {
  const sc = 200 / Math.max(bitmap.width, bitmap.height);
  const w = Math.round(bitmap.width * sc), h = Math.round(bitmap.height * sc);
  const c = canvas(w, h);
  ctx2d(c).drawImage(bitmap, 0, 0, w, h);
  const d = pixels(c);
  const V = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) V[i] = Math.max(d[p], d[p + 1], d[p + 2]) / 255;
  const A = 72, cosT = new Float32Array(A), sinT = new Float32Array(A);
  for (let k = 0; k < A; k++) { cosT[k] = Math.cos((2 * Math.PI * k) / A); sinT[k] = Math.sin((2 * Math.PI * k) / A); }
  const at = (x, y) => { const xi = x | 0, yi = y | 0; return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : V[yi * w + xi]; };
  const score = (cx, cy, r, dr) => {
    let sum = 0, n = 0;
    for (let k = 0; k < A; k++) {
      const a = at(cx + (r - dr) * cosT[k], cy + (r - dr) * sinT[k]), b = at(cx + (r + dr) * cosT[k], cy + (r + dr) * sinT[k]);
      if (a < 0 || b < 0) continue;
      sum += Math.max(-0.3, Math.min(0.6, a - b)); n++;
    }
    return n < A * 0.35 ? -1 : (sum / n) * (0.85 + 0.15 * (n / A));
  };
  let best = null;
  const minR = Math.min(w, h) * 0.25, maxR = Math.max(w, h) * 0.75;
  for (let r = minR; r <= maxR; r += 3) for (let cy = 0; cy < h; cy += 3) for (let cx = 0; cx < w; cx += 3) {
    const v = score(cx, cy, r, 2.5);
    if (!best || v > best.v) best = { v, cx, cy, r };
  }
  if (!best || best.v < 0.15) return null;
  // 細かく合わせ直す
  for (const st of [1.5, 0.75, 0.4]) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dx, dy, dr] of [[st, 0, 0], [-st, 0, 0], [0, st, 0], [0, -st, 0], [0, 0, st], [0, 0, -st]]) {
        const v = score(best.cx + dx, best.cy + dy, best.r + dr, 1.5);
        if (v > best.v) { best = { v, cx: best.cx + dx, cy: best.cy + dy, r: best.r + dr }; improved = true; }
      }
    }
  }
  if (debug.on) debug.ring = { ...best, w, h };
  const R = best.r / sc, cx = best.cx / sc, cy = best.cy / sc;
  return { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R };
}
export function detectScreen(bitmap) {
  const ring = detectScreenRing(bitmap); // 黒い枠との境目で探す（だめなら色の塊から円を当てはめる）
  if (ring) return ring;
  const sc = Math.min(1, 400 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * sc), h = Math.round(bitmap.height * sc);
  const c = canvas(w, h);
  ctx2d(c).drawImage(bitmap, 0, 0, w, h);
  const { S, V } = hsv(pixels(c), w * h);
  let m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = S[i] > 0.25 && V[i] > 0.45 ? 1 : 0;
  m = erode(dilate(m, w, h, 4), w, h, 4);
  const { lab, comps } = label(m, w, h);
  if (!comps.length) return null;
  const big = comps.reduce((a, b) => (b.area > a.area ? b : a));
  if (big.area < w * h * 0.12) return null; // 画面らしい大きさがない
  // 画面は円なので、各行の左右の端から円を当てはめる（写真の端で切れた行やボタンの光は除く）
  const rowL = new Int32Array(h).fill(w), rowR = new Int32Array(h).fill(-1);
  for (let i = 0; i < w * h; i++) if (lab[i] === big.id) {
    const x = i % w, y = (i / w) | 0;
    if (x < rowL[y]) rowL[y] = x; if (x > rowR[y]) rowR[y] = x;
  }
  let rows = [];
  for (let y = 0; y < h; y++) if (rowR[y] >= 0 && rowL[y] > 1 && rowR[y] < w - 2 && rowR[y] - rowL[y] > w * 0.15) rows.push({ y, a: (rowR[y] - rowL[y] + 1) / 2, mid: (rowL[y] + rowR[y]) / 2 });
  if (rows.length < 20) return null;
  const fitRows = (rs) => {
    let sy = 0, sz = 0, syy = 0, syz = 0;
    for (const r of rs) { const z = r.a * r.a + r.y * r.y; sy += r.y; sz += z; syy += r.y * r.y; syz += r.y * z; }
    const n = rs.length, m = (n * syz - sy * sz) / (n * syy - sy * sy), bq = (sz - m * sy) / n;
    const cy = m / 2, R2 = bq + cy * cy;
    if (!(R2 > 0) || !isFinite(R2)) return null;
    const mids = rs.map((r) => r.mid).sort((p, q) => p - q);
    return { cy, R: Math.sqrt(R2), cx: mids[mids.length >> 1] };
  };
  const inl = (f, rs, tol) => rs.filter((r) => Math.abs(Math.sqrt(Math.max(0, f.R * f.R - (r.y - f.cy) ** 2)) - r.a) < f.R * tol);
  // いくつかの行の組で当てはめ、いちばん多くの行に合う円を採用（下のボタンの光に引っぱられないように）
  const ys = rows.map((r) => r.y), top = Math.min(...ys), bot = Math.max(...ys), span = bot - top;
  const subsets = [rows, rows.filter((r) => r.y < top + span * 0.6), rows.filter((r) => r.y < top + span * 0.75), rows.filter((r) => r.y > top + span * 0.2 && r.y < top + span * 0.7)];
  let fit = null, bestN = -1;
  for (const sub of subsets) {
    if (sub.length < 15) continue;
    let f = fitRows(sub);
    for (let it = 0; f && it < 3; it++) { const k = inl(f, rows, 0.05); if (k.length < 15) break; f = fitRows(k) || f; }
    if (!f) continue;
    const n = inl(f, rows, 0.03).length;
    if (n > bestN) { bestN = n; fit = f; }
  }
  if (!fit) return null;
  const { cx, cy, R } = fit;
  if (R < Math.min(w, h) * 0.2) return null;
  return { x: (cx - R) / sc, y: (cy - R) / sc, w: (2 * R) / sc, h: (2 * R) / sc };
}

// ---------- 2. タイトルバー（目印）を探す ----------
function findTitleBar(screen, withRight = false) {
  const c = canvas(400, 400);
  ctx2d(c).drawImage(screen, 0, 0, 400, 400);
  const d = pixels(c);
  const isNavy = (x, y) => { const p = (y * 400 + x) * 4, r = d[p], g = d[p + 1], b = d[p + 2]; return b > 55 && b > r + 30 && b > g + 22 && r < 110 && g >= r - 12; }; // 暗めの写真でも拾う・紫の難易度バーは除く
  const rows = new Int32Array(200);
  for (let y = 0; y < 200; y++) for (let x = 0; x < 400; x++) if (isNavy(x, y)) rows[y]++;
  let best = null, cur = null, gap = 0;
  for (let y = 0; y < 200; y++) {
    if (rows[y] > 400 * 0.38) {
      if (cur && gap <= 2) cur.y1 = y; else cur = { y0: y, y1: y };
      gap = 0;
      if (!best || cur.y1 - cur.y0 > best.y1 - best.y0) best = { ...cur };
    } else if (cur) { gap++; if (gap > 2) cur = null; }
  }
  if (!best || best.y1 - best.y0 < 6) return null;
  if (!withRight) return best.y0 / 400;
  // バーの右端：各行で、文字のすき間（25px未満）をつないだ一番長い紺色の帯の右端
  const ends = [];
  for (let y = best.y0 + 2; y < best.y1 - 1; y++) {
    let runS = -1, prev = -100, bestRun = null;
    for (let x = 0; x < 400; x++) if (isNavy(x, y)) {
      if (x - prev > 25) { if (runS >= 0 && (!bestRun || prev - runS > bestRun[1] - bestRun[0])) bestRun = [runS, prev]; runS = x; }
      prev = x;
    }
    if (runS >= 0 && (!bestRun || prev - runS > bestRun[1] - bestRun[0])) bestRun = [runS, prev];
    if (bestRun && bestRun[1] - bestRun[0] > 150) ends.push(bestRun[1]);
  }
  if (!ends.length) return null;
  ends.sort((a, b) => a - b);
  const starts = [];
  for (let y = best.y0 + 2; y < best.y1 - 1; y++) { for (let x = 0; x < 400; x++) if (isNavy(x, y)) { starts.push(x); break; } }
  starts.sort((a, b) => a - b);
  return { y0: best.y0 / 400, y1: best.y1 / 400, x0: starts[starts.length >> 1] / 400, x1: ends[ends.length >> 1] / 400 };
}

function cropRel(screen, by, r, outW = null) {
  const [x0, dy0, x1, dy1] = r;
  const sx = x0 * N, sy = (by + dy0) * N, sw = (x1 - x0) * N, sh = (dy1 - dy0) * N;
  const w = outW || sw, h = outW ? (sh * outW) / sw : sh;
  const c = canvas(w, h);
  ctx2d(c).drawImage(screen, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return c;
}

// ---------- 3a. 色で判定（難易度・譜面の種類・FC/AP） ----------
function colorStats(c, fn) {
  const n = c.width * c.height;
  const { H, S, V } = hsv(pixels(c), n);
  return fn(H, S, V, n);
}
function readDifficulty(c) {
  // バーの右下（文字・ジャケット・上の枠を避けた模様の部分）の色で判定
  const w = c.width, h = c.height;
  const sub = canvas(Math.round(w * 0.45), Math.round(h * 0.5));
  ctx2d(sub).drawImage(c, w * 0.45, h * 0.45, w * 0.45, h * 0.5, 0, 0, sub.width, sub.height);
  return colorStats(sub, (H, S, V, n) => {
    const hist = new Float32Array(36);
    let ms = 0;
    for (let i = 0; i < n; i++) { ms += S[i]; if (S[i] > 0.35 && V[i] > 0.35) hist[Math.min(35, (H[i] / 10) | 0)]++; }
    ms /= n;
    if (debug.on) debug.lowsat = ms;
    if (ms < 0.46) return 'remas'; // 白っぽい（淡い紫）バー
    let pk = 0;
    for (let i = 1; i < 36; i++) if (hist[i] > hist[pk]) pk = i;
    const hue = pk * 10 + 5;
    if (hue >= 330 || hue < 15) return 'exp';
    if (hue >= 15 && hue < 65) return 'adv';
    if (hue >= 65 && hue < 170) return 'bas';
    if (hue >= 230 && hue < 330) return 'mas';
    return null;
  });
}
function readType(c) {
  return colorStats(c, (H, S, V, n) => {
    let blue = 0;
    for (let i = 0; i < n; i++) if (H[i] > 180 && H[i] < 215 && S[i] > 0.45 && V[i] > 0.6) blue++;
    return blue / n > 0.1 ? 'std' : 'dx';
  });
}
function readLamp(c) {
  return colorStats(c, (H, S, V, n) => {
    let green = 0, red = 0;
    for (let i = 0; i < n; i++) {
      if (H[i] > 80 && H[i] < 160 && S[i] > 0.4 && V[i] > 0.4) green++;
      if ((H[i] < 25 || H[i] > 340) && S[i] > 0.45 && V[i] > 0.5) red++;
    }
    if (red / n > 0.06) return 'ap';
    if (green / n > 0.08) return 'fc';
    return '';
  });
}

// ---------- 3b. 達成率（数字の形と照合） ----------
const GW = 20, GH = 30;
function achMasks(c, vMax = 0.7) {
  const w = c.width, h = c.height, n = w * h;
  const { H, S, V } = hsv(pixels(c), n);
  const out = new Uint8Array(n), face = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (H[i] >= 340 || H[i] <= 25) && S[i] > 0.55 && V[i] < vMax ? 1 : 0; // 濃い赤の縁取り
    face[i] = H[i] >= 25 && H[i] <= 62 && S[i] > 0.45 && V[i] > 0.68 ? 1 : 0; // 明るい黄〜橙の面
  }
  return { out, face, w, h };
}
// 小数4桁：小数点の右にある数字の塊を左から4つ（くっついた塊は幅で分ける）
const ADV = 47;
function fracBoxes(mk, dot) {
  const { out, w, h } = mk;
  const u = dilate(out, w, h, 1);
  const { comps } = label(u, w, h);
  const right = comps.filter((c) => c.x0 >= dot.x0 + 4 && c.x1 > dot.x1 + 10 && c.area > 60 && c.y1 > dot.y0 && c.y0 < dot.y1);
  if (debug.on) debug.rightComps = right.map((c) => [c.x0, c.x1, c.y0, c.y1, c.area]);
  if (!right.length) return null;
  const hmax = Math.max(...right.map((c) => c.y1 - c.y0));
  const tall = right.filter((c) => c.y1 - c.y0 > hmax * 0.7).sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of tall) {
    const p = merged[merged.length - 1];
    if (p && c.x0 < p.x1 - 3) { p.x0 = Math.min(p.x0, c.x0); p.x1 = Math.max(p.x1, c.x1); p.y0 = Math.min(p.y0, c.y0); p.y1 = Math.max(p.y1, c.y1); }
    else merged.push({ ...c });
  }
  const boxes = [];
  const fh = Math.max(...merged.map((c) => c.y1 - c.y0));
  const adv = Math.max(ADV, fh * 0.72); // 大きく写っている写真では数字の幅も広い
  for (const c of merged) {
    const n = Math.max(1, Math.round((c.x1 - c.x0) / adv));
    for (let i = 0; i < n; i++) boxes.push([c.x0 + ((c.x1 - c.x0) * i) / n, c.x0 + ((c.x1 - c.x0) * (i + 1)) / n, c.y0, c.y1].map(Math.round));
  }
  return boxes.length >= 4 ? boxes.slice(0, 4) : null;
}
function fracGlyphs(mk, dot) {
  const boxes = fracBoxes(mk, dot);
  if (boxes) return boxes.map((b) => glyphAt(mk, b));
  return [0, 1, 2, 3].map((k) => glyphAt(mk, [dot.x1 + 4 + k * ADV, dot.x1 + 4 + k * ADV + 44, dot.y1 - 66, dot.y1 + 6]));
}
function faceRing(face, w, h, c) {
  let n = 0, f = 0;
  const x0 = Math.max(0, c.x0 - 5), x1 = Math.min(w, c.x1 + 5), y0 = Math.max(0, c.y0 - 5), y1 = Math.min(h, c.y1 + 5);
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    if (x >= c.x0 - 1 && x < c.x1 + 1 && y >= c.y0 - 1 && y < c.y1 + 1) continue;
    n++; f += face[y * w + x];
  }
  return n ? f / n : 0;
}
function findDot({ out, face, w, h }, L) {
  const cands = [];
  for (const dil of [1, 0]) {
    const m = dil ? dilate(out, w, h, 1) : out;
    const { comps } = label(m, w, h);
    for (const c of comps) {
      const cw = c.x1 - c.x0, ch = c.y1 - c.y0;
      if (cw >= 11 && cw <= 32 && ch >= 11 && ch <= 32 && cw / ch > 0.7 && cw / ch < 1.45 && c.area > 80
        && (c.y0 + c.y1) / 2 > h * 0.5 && c.x0 > 120 && c.x0 < 290 && c.area / (cw * ch) > 0.4) {
        // 小数点は数字の下端にそろう。数字の穴（0 や 6 の内側）は周りが黄色い面なので除く
        if (L && (c.y1 < L.base - L.H * 0.2 || (c.y0 + c.y1) / 2 < L.top + L.H * 0.6)) continue;
        if (faceRing(face, w, h, c) > 0.8) continue;
        cands.push(c);
      }
    }
  }
  return cands.sort((p, q) => q.area - p.area)[0] || null;
}
function resizeMask(m, w, x0, y0, x1, y1) {
  // 指定範囲を GW×GH に面積平均で縮小
  const outv = new Float32Array(GW * GH);
  const bw = x1 - x0, bh = y1 - y0;
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const sx0 = x0 + (gx * bw) / GW, sx1 = x0 + ((gx + 1) * bw) / GW;
    const sy0 = y0 + (gy * bh) / GH, sy1 = y0 + ((gy + 1) * bh) / GH;
    let sum = 0, cnt = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      sum += m[y * w + x]; cnt++;
    }
    outv[gy * GW + gx] = cnt ? sum / cnt : 0;
  }
  return outv;
}
function resizeMaskPad(m, w, h, x0, y0, x1, y1) {
  const outv = new Float32Array(GW * GH);
  const bw = x1 - x0, bh = y1 - y0;
  for (let gy = 0; gy < GH; gy++) for (let gx = 0; gx < GW; gx++) {
    const sx0 = x0 + (gx * bw) / GW, sx1 = x0 + ((gx + 1) * bw) / GW;
    const sy0 = y0 + (gy * bh) / GH, sy1 = y0 + ((gy + 1) * bh) / GH;
    let sum = 0, cnt = 0;
    for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
      cnt++; if (x >= 0 && y >= 0 && x < w && y < h) sum += m[y * w + x];
    }
    outv[gy * GW + gx] = cnt ? sum / cnt : 0;
  }
  return outv;
}
function glyphAt(mk, box) {
  const { out, face, w, h } = mk;
  let [x0, x1, y0, y1] = box;
  x0 = Math.max(0, x0 - 8); x1 = Math.min(w, x1 + 8); y0 = Math.max(0, y0); y1 = Math.min(h, y1);
  const sw = x1 - x0, sh = y1 - y0;
  if (sw <= 2 || sh <= 2) return null;
  const o = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) o[y * sw + x] = out[(y + y0) * w + x + x0];
  const u = dilate(o, sw, sh, 1);
  const { lab, comps } = label(u, sw, sh);
  if (!comps.length) return null;
  const maxA = Math.max(...comps.map((c) => c.area));
  const keepIds = new Set(comps.filter((c) => c.area > maxA * 0.25).map((c) => c.id));
  let bx0 = sw, bx1 = 0, by0 = sh, by1 = 0, cnt = 0;
  const ok = new Uint8Array(sw * sh);
  for (let i = 0; i < sw * sh; i++) if (keepIds.has(lab[i])) {
    const x = i % sw, y = (i / sw) | 0;
    if (x < bx0) bx0 = x; if (x + 1 > bx1) bx1 = x + 1; if (y < by0) by0 = y; if (y + 1 > by1) by1 = y + 1;
    cnt++;
    ok[i] = o[i];
  }
  if (cnt < 40) return null;
  const f = new Uint8Array(sw * sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) f[y * sw + x] = face[(y + y0) * w + x + x0];
  // 縦横比を保つ（高さでそろえて横は中央に置く）：1 が細いことも手がかりになる
  const bh = by1 - by0, cxm = (bx0 + bx1) / 2, half = (bh * GW) / GH / 2;
  const a = resizeMaskPad(ok, sw, sh, cxm - half, by0, cxm + half, by1), b = resizeMaskPad(f, sw, sh, cxm - half, by0, cxm + half, by1);
  const v = new Float32Array(GW * GH * 2);
  v.set(a, 0); v.set(b, GW * GH);
  return v;
}
// 整数部：小数点より左の大きな塊（右から最大3つ）
function intBoxes(mk, dot) {
  const { out, w, h } = mk;
  const u = dilate(out, w, h, 1);
  const { comps } = label(u, w, h);
  const left = comps.filter((c) => c.x1 <= dot.x0 + 2 && c.area > 60);
  if (!left.length) return [];
  const hmax = Math.max(...left.map((c) => c.y1 - c.y0));
  const tall = left.filter((c) => c.y1 - c.y0 > hmax * 0.85 && c.x1 - c.x0 > 25).sort((a, b) => a.x0 - b.x0);
  const merged = [];
  for (const c of tall) {
    const p = merged[merged.length - 1];
    if (p && c.x0 < p.x1 - 3) { p.x0 = Math.min(p.x0, c.x0); p.x1 = Math.max(p.x1, c.x1); p.y0 = Math.min(p.y0, c.y0); p.y1 = Math.max(p.y1, c.y1); }
    else merged.push({ ...c });
  }
  return merged.slice(-3).map((c) => [c.x0, c.x1, c.y0, c.y1]);
}
// 数字の高さ（縁取りの塊の高さの大きい方から）＝写真ごとの大きさの目安
export function digitHeight(achCanvas) {
  const mk = achMasks(achCanvas, 0.76);
  const u = dilate(mk.out, mk.w, mk.h, 1);
  const { comps } = label(u, mk.w, mk.h);
  const hs = comps.filter((c) => c.area > 150 && c.x1 - c.x0 > 15 && c.y1 - c.y0 < mk.h * 0.95).map((c) => c.y1 - c.y0).sort((a, b) => b - a);
  if (hs.length < 3) return null;
  return hs[1];
}
// 数字の並び（背の高い塊）の上端・下端
function digitLine(mk) {
  const { out, w, h } = mk;
  const u = dilate(out, w, h, 1);
  const { comps } = label(u, w, h);
  const big = comps.filter((c) => c.area > 60 && c.x1 - c.x0 > 12 && c.y1 - c.y0 < h * 0.98);
  if (!big.length) return null;
  const hmax = Math.max(...big.map((c) => c.y1 - c.y0));
  const tall = big.filter((c) => c.y1 - c.y0 >= hmax * 0.7);
  if (tall.length < 2) return null;
  const med = (arr) => { const v = [...arr].sort((p, q) => p - q); return v[v.length >> 1]; };
  const intC = tall.filter((c) => c.y1 - c.y0 >= hmax * 0.88 && c.x1 < w * 0.62);
  const base = med((intC.length ? intC : tall).map((c) => c.y1)), top = med((intC.length ? intC : tall).map((c) => c.y0)), H = base - top;
  const intRight = intC.length ? Math.max(...intC.map((c) => c.x1)) : null; // 整数部（大きい数字）の右端
  return { comps, tall, base, top, H, intRight };
}
export function achGlyphs(achCanvas) {
  for (const vMax of [0.7, 0.76, 0.82]) {
    const mk = achMasks(achCanvas, vMax);
    const dot = findDot(mk, digitLine(mk));
    if (!dot) continue;
    const fr = fracGlyphs(mk, dot);
    const itBoxes = intBoxes(mk, dot);
    const it = itBoxes.map((b) => glyphAt(mk, b));
    if (debug.on) debug.achBoxes = { dot, fb: fracBoxes(mk, dot), itBoxes, vMax };
    return { fr, it, itBoxes, dot };
  }
  return null;
}
function corr(a, b) {
  let ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { ma += a[i]; mb += b[i]; }
  ma /= a.length; mb /= b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / (Math.sqrt(da * db) + 1e-9);
}
let digitSamples = null;
export async function loadDigitSamples() {
  if (digitSamples) return digitSamples;
  const res = await fetch('./data/digits.json');
  const j = await res.json();
  digitSamples = j.samples.map(([ch, s]) => [ch, Float32Array.from(s, (c) => (c.charCodeAt(0) - 48) / 9)]);
  return digitSamples;
}
export function setDigitSamples(list) { digitSamples = list; }
function classify(v, samples, k = 5) {
  if (!v) return null;
  const top = samples.map(([ch, s]) => [corr(v, s), ch]).sort((a, b) => b[0] - a[0]).slice(0, k);
  const votes = {};
  for (const [c, ch] of top) votes[ch] = (votes[ch] || 0) + c;
  return Object.entries(votes).sort((a, b) => b[1] - a[1])[0][0];
}
// 小数点が見つからないとき：いつもの位置の近くで少しずつずらし、数字に一番よく合う位置を使う
function achGlyphsFallback(achCanvas, samples) {
  const mk = achMasks(achCanvas, 0.7);
  let best = null;
  for (let x0 = 176; x0 <= 226; x0 += 3) for (let y1 = 80; y1 <= 98; y1 += 3) {
    const dot = { x0, x1: x0 + 17, y0: y1 - 17, y1 };
    const fr = fracGlyphs(mk, dot);
    if (fr.some((v) => !v)) continue;
    const score = fr.reduce((sm, v) => sm + Math.max(...samples.map(([, t]) => corr(v, t))), 0);
    if (!best || score > best.score) best = { score, fr, dot };
  }
  if (!best || best.score / 4 < 0.6) return null;
  const itBoxes = intBoxes(mk, best.dot);
  return { fr: best.fr, it: itBoxes.map((b) => glyphAt(mk, b)), itBoxes, dot: best.dot };
}

export function readAchievement(achCanvas, samples, k = 5) {
  const g = achGlyphs(achCanvas) || achGlyphsFallback(achCanvas, samples);
  if (!g) return null;
  const fp = g.fr.map((v) => classify(v, samples, k));
  if (fp.some((d) => d === null)) return null;
  const frac = fp.join('');
  // 整数部：小数点の左の数字が3つなら 100（101.0000% は理論値）、2つなら読んだ値
  let ip;
  const span = g.itBoxes.length ? g.dot.x0 - g.itBoxes[0][0] : 0;
  if (g.itBoxes.length >= 3 || span > 165) {
    ip = '100';
    if (frac === '0000' && g.it.length && classify(g.it[g.it.length - 1], samples, k) === '1') ip = '101';
  } else ip = g.it.map((v) => classify(v, samples, k)).filter((d) => d !== null).slice(-2).join('');
  // あり得ない整数部（0〜49 や 3桁の読み違い）は 100 とみなす
  if (!ip || !/^\d+$/.test(ip) || +ip < 50 || +ip > 101) ip = '100';
  const val = parseFloat(`${ip}.${frac}`);
  return val >= 0 && val <= 101 ? val : null;
}

// ---------- 3c. 文字認識（DXスコア・曲名） ----------
async function ocrCanvas(c, params) {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: '', ...params });
  const r = await worker.recognize(c);
  await worker.setParameters({ tessedit_pageseg_mode: '3', tessedit_char_whitelist: '' });
  return r.data.text || '';
}
// 白文字だけを黒、それ以外を白にした画像（曲名）
function whiteTextCanvas(src, scale = 1, clean = true, targetH = 0) {
  const w = src.width, h = src.height, n = w * h;
  const d = pixels(src);
  let m = new Uint8Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const r = d[p], g = d[p + 1], b = d[p + 2], mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    m[i] = mn > 150 && mx - mn < 70 ? 1 : 0;
  }
  let bx0 = 0, bx1 = w, by0 = 0, by1 = h;
  if (clean) {
    // 端に触れている塊・離れた汚れを消して、曲名の1行だけを残す（Tesseract が余計な模様で崩れるため）
    const { lab, comps } = label(m, w, h);
    const inner = comps.filter((c) => c.x0 > 0 && c.y0 > 0 && c.x1 < w && c.y1 < h && c.area >= 4);
    const core = inner.filter((c) => c.y1 - c.y0 >= h * 0.12 && c.y1 - c.y0 <= h * 0.8 && c.x1 - c.x0 <= (c.y1 - c.y0) * 3);
    if (core.length) {
      const hs = core.map((c) => c.y1 - c.y0).sort((a, b) => a - b);
      const th = hs[Math.floor(hs.length * 0.75)];
      const cys = core.map((c) => (c.y0 + c.y1) / 2).sort((a, b) => a - b);
      const cy = cys[cys.length >> 1];
      const line = core.filter((c) => Math.abs((c.y0 + c.y1) / 2 - cy) < th * 0.6).sort((a, b) => a.x0 - b.x0);
      // 横に大きく離れた塊は別物（一番文字数の多いまとまりを使う）
      const groups = [];
      for (const c of line) {
        const g = groups[groups.length - 1];
        if (g && c.x0 - g.x1 < th * 3.5) { g.items.push(c); g.x1 = Math.max(g.x1, c.x1); } else groups.push({ items: [c], x0: c.x0, x1: c.x1 });
      }
      const best = groups.sort((a, b) => (b.x1 - b.x0) * b.items.length - (a.x1 - a.x0) * a.items.length)[0];
      // 文字が小さいと Tesseract が読めないので、文字の高さが targetH 程度になるよう拡大する
      if (targetH) scale = Math.min(3, Math.max(1, targetH / th));
      if (best) {
        const gx0 = best.x0 - th * 0.8, gx1 = best.x1 + th * 0.8, gy0 = cy - th * 0.9, gy1 = cy + th * 0.9;
        const keep = new Set(inner.filter((c) => c.x0 >= gx0 && c.x1 <= gx1 && c.y0 >= gy0 && c.y1 <= gy1).map((c) => c.id));
        const m2 = new Uint8Array(n);
        for (let i = 0; i < n; i++) if (m[i] && keep.has(lab[i])) m2[i] = 1;
        m = m2;
        bx0 = Math.max(0, Math.floor(gx0)); bx1 = Math.min(w, Math.ceil(gx1)); by0 = Math.max(0, Math.floor(gy0)); by1 = Math.min(h, Math.ceil(gy1));
      }
    }
  }
  const cw = bx1 - bx0, ch = by1 - by0;
  const c = canvas(cw * scale + 40, ch * scale + 40);
  const x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  const tmp = canvas(cw, ch), tx = ctx2d(tmp), img = tx.createImageData(cw, ch);
  for (let yy = 0; yy < ch; yy++) for (let xx = 0; xx < cw; xx++) {
    const v = m[(yy + by0) * w + xx + bx0] ? 0 : 255, p = (yy * cw + xx) * 4;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  tx.putImageData(img, 0, 0);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(tmp, 20, 20, cw * scale, ch * scale);
  return c;
}
// DXスコア：右下の「でらっくスコア」の紺色の見出しを探し、その下の白い枠の文字を読む
function findDxBox(screen, by, area = LAYOUT.dxSearch) {
  const [x0, dy0, x1, dy1] = area;
  const c = cropRel(screen, by, area, 400);
  const w = c.width, h = c.height, d = pixels(c);
  const rows = new Int32Array(h), colsAll = [];
  const navy = (p) => d[p + 2] > 55 && d[p + 2] > d[p] + 30 && d[p + 2] > d[p + 1] + 22 && d[p] < 110 && d[p + 1] >= d[p] - 12;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (navy((y * w + x) * 4)) rows[y]++;
  let band = null, cur = null;
  for (let y = 0; y < h; y++) {
    if (rows[y] > w * 0.3) { if (cur) cur.y1 = y; else cur = { y0: y, y1: y }; }
    else if (cur) { if (cur.y1 - cur.y0 >= 4) { band = cur; break; } cur = null; }
  }
  if (!band) return null;
  let bx0 = w, bx1 = 0;
  for (let y = band.y0; y <= band.y1; y++) for (let x = 0; x < w; x++) if (navy((y * w + x) * 4)) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; }
  const bh = band.y1 - band.y0 + 1;
  // 縮小前の座標に戻す
  const sx = x0 * N, sy = (by + dy0) * N, k = ((x1 - x0) * N) / w;
  return { x: sx + bx0 * k, y: sy + (band.y1 + 1) * k, w: (bx1 - bx0) * k, h: bh * 1.35 * k };
}
function grayTextCanvas(src) {
  const w = src.width, h = src.height, n = w * h, d = pixels(src);
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) lum[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000;
  const sorted = Float32Array.from(lum).sort();
  const lo = sorted[Math.floor(n * 0.03)], hi = sorted[Math.floor(n * 0.7)];
  const tmp = canvas(w, h), tx = ctx2d(tmp), img = tx.createImageData(w, h);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = Math.max(0, Math.min(255, ((lum[i] - lo) / Math.max(1, hi - lo)) * 255));
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  tx.putImageData(img, 0, 0);
  const c = canvas(w * 2 + 40, h * 2 + 40), x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
  x.drawImage(tmp, 20, 20, w * 2, h * 2);
  return c;
}
function darkTextCanvas(src, bias = 0) {
  const w = src.width, h = src.height, n = w * h, d = pixels(src);
  const c = canvas(w * 2 + 40, h * 2 + 40), x = ctx2d(c);
  x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  // 明るさのしきい値は写真ごとに決める（大津の方法）
  const lum = new Float32Array(n), hist = new Float64Array(256);
  for (let i = 0, p = 0; i < n; i++, p += 4) { lum[i] = (d[p] * 299 + d[p + 1] * 587 + d[p + 2] * 114) / 1000; hist[lum[i] | 0]++; }
  let sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
  let wB = 0, sB = 0, best = 0, th = 140;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue; const wF = n - wB; if (!wF) break;
    sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) ** 2;
    if (v > best) { best = v; th = t; }
  }
  th = Math.min(170, Math.max(90, th + bias));
  const tmp = canvas(w, h), tx = ctx2d(tmp), img = tx.createImageData(w, h);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const on = lum[i] < th && d[p + 2] >= d[p]; // 紺色の文字
    const v = on ? 0 : 255;
    img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
  }
  tx.putImageData(img, 0, 0);
  x.drawImage(tmp, 20, 20, w * 2, h * 2);
  return c;
}
export const debug = { on: false, images: {} };
// 「/」が「7」に読まれたり抜けたりするので、ノーツ数として実在する分母になる分け方を探す
function parseDx(text, notesSet, candMax) {
  const t = text.replace(/[^0-9/]/g, '');
  const ok = (a, b) => a.length >= 2 && a.length <= 4 && b.length >= 2 && b.length <= 4 && +a <= +b && +b % 3 === 0 && (!notesSet || notesSet.has(+b / 3));
  const dg = t.replace(/\//g, '');
  // 曲名から候補の譜面が分かっているときは、その上限に一番近い読み方を選ぶ（1桁までの読み違いは直す）
  if (candMax && candMax.size) {
    const ham = (a, b) => { if (a.length !== b.length) return 9; let k = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) k++; return k; };
    let best = null;
    const parts = [];
    const sl = t.match(/(\d+)\/+(\d+)/);
    if (sl) {
      // 「/」の前後で分ける。左が長すぎるときは「/」を 7 や 1 と読んだ分を落とす
      const L = sl[1], R = sl[2];
      const lefts = new Set([L, L.slice(-4)]);
      if (/[71]$/.test(L)) { lefts.add(L.slice(0, -1)); lefts.add(L.slice(0, -1).slice(-4)); }
      for (const a of lefts) parts.push([a, R.slice(0, 4), 0]);
    }
    for (let i = 2; i <= dg.length - 2; i++) { parts.push([dg.slice(0, i), dg.slice(i), 1]); if ('71'.includes(dg[i])) parts.push([dg.slice(0, i), dg.slice(i + 1), 0.5]); }
    for (const [a, b, pen] of parts) {
      if (a.length < 2 || a.length > 4) continue;
      for (const mx of candMax) {
        const e = ham(b, String(mx));
        if (e > 1 || +a > mx) continue;
        let A = +a;
        // 先頭の 1 や 2 が抜けた（DXスコアが上限の半分未満になる）ときは補う
        if (A < mx * 0.5) for (const pre of ['1', '2']) { const v = +(pre + a); if (v <= mx && v >= mx * 0.5) { A = v; break; } }
        const sc = e * 2 + pen + (A < mx * 0.5 ? 2 : 0) + Math.abs(String(A).length - b.length) * 0.5;
        if (!best || sc < best.sc) best = { dx: A, dxMax: mx, sc };
      }
    }
    if (best) return { dx: best.dx, dxMax: best.dxMax };
  }
  const m = t.match(/(\d{2,4})\/(\d{2,4})/);
  if (m && ok(m[1], m[2])) return { dx: +m[1], dxMax: +m[2] };
  const found = [];
  for (let i = 2; i <= dg.length - 2; i++) {
    if (dg[i] === '7' && ok(dg.slice(0, i), dg.slice(i + 1))) found.push({ dx: +dg.slice(0, i), dxMax: +dg.slice(i + 1) });
    if (ok(dg.slice(0, i), dg.slice(i))) found.push({ dx: +dg.slice(0, i), dxMax: +dg.slice(i) });
  }
  // 分母の桁数が分子と同じものを優先
  found.sort((p, q) => Math.abs(String(p.dx).length - String(p.dxMax).length) - Math.abs(String(q.dx).length - String(q.dxMax).length));
  return found[0] || null;
}

async function readDxScore(screen, by, notesSet, candMax) {
  const box = findDxBox(screen, by) || findDxBox(screen, by, [0.5, 0.3, 1.0, 0.9]);
  if (!box) { if (debug.on) debug.images.dx = null; return null; }
  // 右端の「+11」などの差分は除く（枠の左 72%）
  const c = canvas(box.w * 0.72, box.h);
  ctx2d(c).drawImage(screen, box.x, box.y, box.w * 0.72, box.h, 0, 0, c.width, c.height);
  let first = null;
  for (const bias of ['gray', 0, 20, -15]) {
    const pre = bias === 'gray' ? grayTextCanvas(c) : darkTextCanvas(c, bias);
    if (debug.on && bias === 'gray') { debug.images.dxRaw = c.toDataURL(); debug.images.dx = pre.toDataURL(); }
    const text = await ocrCanvas(pre, { tessedit_char_whitelist: '0123456789/' });
    if (debug.on) debug.dxText = (debug.dxText || '') + text;
    const r = parseDx(text, notesSet, candMax);
    if (r && (!candMax || candMax.has(r.dxMax))) return r;
    if (r && !first) first = r;
  }
  return first;
}

// ---------- 曲の特定 ----------
function titleScore(song, t) {
  if (!t) return 0;
  const n = song.n;
  if (!n) return 0;
  if (n.length <= 2) return t === n ? 1 : t.length <= n.length + 2 && t.includes(n) ? 0.7 : 0; // 「[X]」などの短い曲名は誤一致しやすい
  let sc = dice(song.bg, bigrams(t));
  // 曲名が長くて流れて表示される場合：読めた部分が曲名に含まれていれば加点
  if (t.length >= 4 && n.includes(t)) sc = Math.max(sc, 0.85);
  if (n.length >= 4 && t.includes(n)) sc = Math.max(sc, 0.95);
  return sc;
}
function identify(index, { titleText, dxMax, diff, type }) {
  const t = norm(titleText);
  const notes = dxMax ? dxMax / 3 : null;
  const cands = [];
  for (const s of index.songs) {
    if (s.deleted) continue;
    const ts = titleScore(s, t);
    let bestChart = null, bonus = 0;
    for (const c of s.charts) {
      let b = 0;
      if (notes && c.notes === notes) b += 0.6;
      if (diff && c.diff === diff) b += 0.15;
      if (type && c.type === type) b += 0.1;
      if (b > bonus) { bonus = b; bestChart = c; }
    }
    const score = ts + (notes && bestChart?.notes === notes ? bonus : bonus * 0.3);
    if (ts > 0.25 || (notes && bestChart?.notes === notes)) cands.push({ song: s, chart: bestChart, score, ts });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands.slice(0, 6);
}

// ---------- まとめ ----------
export async function recognizeResult(file, index, onProgress) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    onProgress && onProgress({ status: '画面を探しています', progress: 0.05 });
    const box = detectScreen(bitmap);
    if (debug.on) debug.stage = box ? 'screen-ok' : 'screen';
    if (!box) return null;
    const raw = canvas(N, N);
    ctx2d(raw).drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, N, N);
    const screen = raw;
    if (debug.on) { const t = canvas(400, 400); ctx2d(t).drawImage(screen, 0, 0, 400, 400); debug.images.screen = t.toDataURL(); debug.stage = 'bar'; }
    const by = findTitleBar(screen);
    if (by === null) return null;
    if (debug.on) debug.stage = 'ok';
    onProgress && onProgress({ status: '達成率を読んでいます', progress: 0.2 });
    const samples = await loadDigitSamples();
    const achCanvas = cropRel(screen, by, LAYOUT.ach, 512);
    if (debug.on) debug.images.ach = achCanvas.toDataURL();
    const ach = readAchievement(achCanvas, samples);
    const diffCanvas = cropRel(screen, by, LAYOUT.diffbar);
    if (debug.on) debug.images.diffbar = diffCanvas.toDataURL();
    const diff = readDifficulty(diffCanvas);
    const type = readType(cropRel(screen, by, LAYOUT.badge));
    const fc = readLamp(cropRel(screen, by, LAYOUT.fc));
    onProgress && onProgress({ status: '曲名を読んでいます', progress: 0.4 });
    const titleSrc = cropRel(screen, by, LAYOUT.title);
    if (debug.on) debug.images.titleRaw = titleSrc.toDataURL();
    const titleCanvas = whiteTextCanvas(titleSrc, 1, true, 40);
    if (debug.on) { debug.dxText = ''; debug.images.title = titleCanvas.toDataURL(); debug.images.screen = (() => { const t = canvas(400, 400); ctx2d(t).drawImage(screen, 0, 0, 400, 400); return t.toDataURL(); })(); debug.by = by; }
    let titleText = await ocrCanvas(titleCanvas, {});
    // 曲名で候補を絞ってから DX スコアを読む（上限が分かれば読み違いを直せる）
    let pre = identify(index, { titleText, diff, type });
    if (!pre[0] || pre[0].ts < 0.6) {
      // うまく読めないときは、拡大しない元の画像でも読んでみて、曲名によく合う方を使う
      const t2 = await ocrCanvas(whiteTextCanvas(titleSrc, 1, false), {});
      const p2 = identify(index, { titleText: t2, diff, type });
      if (p2[0] && (!pre[0] || p2[0].ts > pre[0].ts)) { titleText = t2; pre = p2; }
    }
    let candMax = null;
    if (pre[0] && pre[0].ts >= 0.6 && (!pre[1] || pre[0].ts - pre[1].ts > 0.1)) candMax = new Set(pre[0].song.charts.map((c) => c.notes * 3).filter(Boolean));
    onProgress && onProgress({ status: 'DXスコアを読んでいます', progress: 0.7 });
    if (!index.notesSet) index.notesSet = new Set(index.songs.flatMap((x) => x.charts.map((c) => c.notes)).filter(Boolean));
    const dxr = await readDxScore(screen, by, index.notesSet, candMax);
    const cands = identify(index, { titleText, dxMax: dxr?.dxMax, diff, type });
    const top = cands[0] || null;
    // 選ばれた曲の譜面：DXスコアの上限が合う譜面を優先し、なければ色で判定した難易度・種類
    let chart = null;
    if (top) {
      chart = (dxr && top.song.charts.find((c) => c.notes * 3 === dxr.dxMax))
        || top.song.charts.find((c) => c.diff === diff && c.type === type)
        || top.song.charts.find((c) => c.diff === diff) || null;
    }
    onProgress && onProgress({ status: '完了', progress: 1 });
    return {
      ach, diff: chart?.diff || diff, type: chart?.type || type, fc,
      dx: dxr?.dx ?? null, dxMax: dxr?.dxMax ?? null,
      song: top?.song || null, cands, titleText,
      sure: { song: !!top && top.ts >= 0.5 && (top.score >= 1 || (cands[1] ? top.score - cands[1].score > 0.3 : true)), ach: ach !== null },
      text: `［曲名］${titleText.trim()}\n［DXスコア］${dxr ? dxr.dx + '/' + dxr.dxMax : '-'}`,
    };
  } finally {
    bitmap.close?.();
  }
}

// 開発用：正解つきの写真から数字の見本を作る
export function trainingGlyphs(achCanvas, achValue) {
  const g = achGlyphs(achCanvas);
  if (!g) return [];
  const [ip, fp] = achValue.toFixed(4).split('.');
  const out = [];
  g.fr.forEach((v, i) => v && out.push([fp[i], v]));
  const ipr = [...ip].reverse();
  [...g.it].reverse().forEach((v, i) => v && ipr[i] && out.push([ipr[i], v]));
  return out;
}
export function screenAndBar(bitmap) {
  const box = detectScreen(bitmap);
  if (!box) return null;
  const raw = canvas(N, N);
  ctx2d(raw).drawImage(bitmap, box.x, box.y, box.w, box.h, 0, 0, N, N);
  const screen = raw;
  const by = findTitleBar(screen);
  return by === null ? null : { screen, by, achCanvas: cropRel(screen, by, LAYOUT.ach, 512) };
}
