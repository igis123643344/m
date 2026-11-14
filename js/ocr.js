// リザルト写真の読み取り（スマホ内で動く Tesseract.js を使用）
import { norm, bigrams, dice } from './songs.js';

let workerPromise = null;
let progressHandler = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const el = document.createElement('script');
    el.src = src;
    el.onload = resolve;
    el.onerror = () => reject(new Error('OCRエンジンを読み込めませんでした'));
    document.head.appendChild(el);
  });
}

// Tesseract.js が使う保存場所（idb-keyval の既定：DB "keyval-store" / ストア "keyval"）
function tessDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keyval-store');
    req.onupgradeneeded = () => req.result.createObjectStore('keyval');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function tessCacheHas(key) {
  try {
    const db = await tessDb();
    return await new Promise((resolve) => {
      const r = db.transaction('keyval').objectStore('keyval').count(key);
      r.onsuccess = () => resolve(r.result > 0);
      r.onerror = () => resolve(false);
    });
  } catch { return false; }
}
async function tessCachePut(key, data) {
  const db = await tessDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction('keyval', 'readwrite');
    tx.objectStore('keyval').put(data, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export function getWorker(onProgress) {
  progressHandler = onProgress || null;
  if (!workerPromise) {
    workerPromise = (async () => {
      await loadScript('./vendor/tesseract.min.js');
      const base = new URL('./vendor/', location.href).href;
      // 文字データは、Tesseract が読みに行く保存場所（IndexedDB）に先に入れておく。
      // 一度入れれば次回からはダウンロード不要。
      progressHandler && progressHandler({ status: 'loading language traineddata', progress: 0 });
      await Promise.all(['jpn', 'eng'].map(async (code) => {
        const key = `./${code}.traineddata`;
        if (await tessCacheHas(key)) return;
        const res = await fetch(`${base}lang/${code}.traineddata.gz.wasm`);
        if (!res.ok) throw new Error(`文字データ(${code})を読み込めませんでした`);
        await tessCachePut(key, new Uint8Array(await res.arrayBuffer()));
      }));
      const worker = await window.Tesseract.createWorker(['jpn', 'eng'], 1, {
        workerPath: base + 'worker.min.js',
        corePath: base + 'core/',
        langPath: base + 'lang',
        logger: (m) => progressHandler && progressHandler(m),
      });
      await worker.setParameters({ preserve_interword_spaces: '1' });
      return worker;
    })().catch((e) => {
      workerPromise = null;
      throw e;
    });
  }
  return workerPromise;
}

// 写真を読み取りやすい形に（縮小・グレースケール・コントラスト強調、必要なら白黒反転）
// mode: 'lum' 明るさ / 'blue' 青成分（黄色・オレンジの文字が濃く出る） / 'sat' 色の濃さ
export async function prepareImage(file, { invert = false, mode = 'lum', maxSide = 1800 } = {}) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], gr = d[i + 1], b = d[i + 2];
    const g = mode === 'blue' ? b
      : mode === 'sat' ? 255 - (Math.max(r, gr, b) - Math.min(r, gr, b))
      : (r * 299 + gr * 587 + b * 114) / 1000;
    d[i] = g;
    hist[g | 0]++;
  }
  // 上下 2% を切ってコントラストを伸ばす
  const total = w * h;
  let lo = 0, hi = 255, acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > total * 0.02) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > total * 0.02) break; }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let v = ((d[i] - lo) * 255) / range;
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    if (invert) v = 255 - v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

export async function recognize(file, onProgress) {
  const worker = await getWorker(onProgress);
  const texts = [];
  // 達成率が読めるまで、画像の処理方法を変えて読み直す
  const passes = [
    { mode: 'lum' },
    { mode: 'blue' },
    { mode: 'sat' },
    { mode: 'lum', invert: true },
  ];
  let parsed = null;
  for (const opt of passes) {
    const cv = await prepareImage(file, opt);
    const r = await worker.recognize(cv);
    texts.push(r.data.text || '');
    parsed = parseResultText(texts.join('\n'));
    if (parsed.ach != null) break;
  }
  return { text: texts.join('\n'), ...parsed };
}

// ---- テキスト解析（純粋関数：テスト可能） ----

const DIGITLIKE = { O: '0', o: '0', D: '0', Q: '0', '〇': '0', '○': '0', l: '1', I: '1', '|': '1', i: '1', S: '5', s: '5', B: '8', Z: '2', z: '2', g: '9' };
const toDigits = (s) => s.replace(/[OoDQ〇○lI|iSsBZzg]/g, (c) => DIGITLIKE[c]);

export function parseAchievement(text) {
  const t = text.normalize('NFKC');
  const re = /([0-9OoDQ〇○lI|]{2,3})\s?[.,:·•]\s?([0-9OoDQ〇○lI|SsBZzg]{4})(\s?%)?/g;
  const cands = [];
  let m;
  while ((m = re.exec(t))) {
    const v = parseFloat(`${toDigits(m[1])}.${toDigits(m[2])}`);
    if (v >= 0 && v <= 101) cands.push({ v: Math.min(v, 101), pct: !!m[3] });
  }
  if (!cands.length) return null;
  const withPct = cands.filter((c) => c.pct);
  const pick = (withPct.length ? withPct : cands).reduce((a, b) => (b.v > a.v ? b : a));
  return pick.v;
}

export function parseDxScore(text) {
  const t = text.normalize('NFKC').replace(/(\d),(\d{3})/g, '$1$2');
  const re = /(\d{2,4})\s?\/\s?(\d{2,4})/g;
  let m;
  while ((m = re.exec(t))) {
    const a = +m[1], b = +m[2];
    if (a <= b && b % 3 === 0 && b >= 60) return { dx: a, dxMax: b };
  }
  return null;
}

export function parseDifficulty(text) {
  const u = text.normalize('NFKC').toUpperCase().replace(/[\s:：]/g, '');
  if (/RE.?MASTER|REMAS/.test(u)) return 'remas';
  if (/MASTER|MAST[EF]R|MA5TER/.test(u)) return 'mas';
  if (/EXPERT|EXPER[TI]/.test(u)) return 'exp';
  if (/ADVANCED|ADVANC/.test(u)) return 'adv';
  if (/BASIC|BAS[I1]C/.test(u)) return 'bas';
  return null;
}

export function parseFc(text) {
  const u = text.normalize('NFKC').toUpperCase().replace(/\s/g, '');
  if (/ALLPERFECT[+*✚]|AP[+*✚]/.test(u)) return 'app';
  if (/ALLPERFECT/.test(u)) return 'ap';
  if (/FULLCOMBO[+*✚]|FC[+*✚]/.test(u)) return 'fcp';
  if (/FULLCOMBO/.test(u)) return 'fc';
  return '';
}

export function parseResultText(text) {
  return {
    ach: parseAchievement(text),
    diff: parseDifficulty(text),
    fc: parseFc(text),
    ...(parseDxScore(text) || { dx: null, dxMax: null }),
  };
}

// OCR テキストの各行と曲名を照合して候補を返す
export function matchSongs(text, index, { dxMax = null, limit = 6 } = {}) {
  const lines = text
    .split(/\n+/)
    .map((l) => norm(l))
    .filter((l) => l.length >= 2 && !/^[0-9.]+$/.test(l));
  const cands = [...lines];
  for (let i = 0; i < lines.length - 1; i++) cands.push(lines[i] + lines[i + 1]);
  const cb = cands.map((c) => [c, bigrams(c)]);
  const notes = dxMax ? dxMax / 3 : null;
  const scored = [];
  for (const s of index.songs) {
    let best = 0;
    for (const [c, bg] of cb) {
      let sc;
      if (s.n.length <= 2) sc = c === s.n ? 0.9 : 0;
      else {
        sc = dice(s.bg, bg);
        if (s.n.length >= 4 && c.includes(s.n)) sc = Math.max(sc, 0.95);
      }
      if (sc > best) best = sc;
    }
    const noteHit = notes ? s.charts.some((ch) => ch.notes === notes) : false;
    const score = best + (noteHit ? 0.35 : 0);
    if (score >= 0.3) scored.push({ song: s, score, noteHit });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score || 0;
  return scored.filter((x) => x.score >= top * 0.5).slice(0, limit);
}

// 選ばれた曲・読み取り結果から、種別（STD/DX）と難易度を推定
export function guessChart(song, parsed) {
  if (!song) return { type: null, diff: parsed.diff, sure: false };
  if (parsed.dxMax) {
    const hit = song.charts.filter((c) => c.notes * 3 === parsed.dxMax);
    if (hit.length === 1) return { type: hit[0].type, diff: hit[0].diff, sure: true };
  }
  const types = [...new Set(song.charts.map((c) => c.type))];
  let diff = parsed.diff;
  let type = types.length === 1 ? types[0] : null;
  if (diff && !type) {
    const t = types.filter((ty) => song.charts.some((c) => c.type === ty && c.diff === diff));
    if (t.length === 1) type = t[0];
  }
  return { type, diff, sure: false };
}
