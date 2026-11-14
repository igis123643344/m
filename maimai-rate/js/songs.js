// 曲データ（有志データベース otoge-db の譜面定数データを利用）
export const DEFAULT_SONG_URL =
  'https://raw.githubusercontent.com/zvuc/otoge-db/master/maimai/data/music-ex.json';

export const DIFFS = ['bas', 'adv', 'exp', 'mas', 'remas'];
export const DIFF_LABEL = { bas: 'BASIC', adv: 'ADVANCED', exp: 'EXPERT', mas: 'MASTER', remas: 'Re:MASTER' };
export const DIFF_SHORT = { bas: 'BAS', adv: 'ADV', exp: 'EXP', mas: 'MAS', remas: 'ReM' };
export const TYPE_LABEL = { std: 'STD', dx: 'DX' };

export const VERSION_NAMES = {
  '100': 'maimai', '110': 'maimai PLUS', '120': 'GreeN', '130': 'GreeN PLUS',
  '140': 'ORANGE', '150': 'ORANGE PLUS', '160': 'PiNK', '170': 'PiNK PLUS',
  '180': 'MURASAKi', '185': 'MURASAKi PLUS', '190': 'MiLK', '195': 'MiLK PLUS',
  '199': 'FiNALE', '200': 'でらっくす', '205': 'でらっくす PLUS', '210': 'Splash',
  '215': 'Splash PLUS', '220': 'UNiVERSE', '225': 'UNiVERSE PLUS', '230': 'FESTiVAL',
  '235': 'FESTiVAL PLUS', '240': 'BUDDiES', '245': 'BUDDiES PLUS', '250': 'PRiSM',
  '255': 'PRiSM PLUS', '260': 'CiRCLE', '265': 'CiRCLE PLUS', '270': 'MAGiCAL',
};

// 公式サイトのジャンル順
export const GENRES = ['POPS＆アニメ', 'niconico＆ボーカロイド', '東方Project', 'ゲーム＆バラエティ', 'maimai', 'オンゲキ＆CHUNITHM'];
export const GENRE_COLOR = {
  'POPS＆アニメ': '#ff8a3d', 'niconico＆ボーカロイド': '#2bb3c0', '東方Project': '#9b6bdc',
  'ゲーム＆バラエティ': '#4caf50', 'maimai': '#e8508c', 'オンゲキ＆CHUNITHM': '#3d7bff',
};
// ジャケット画像（公式サイトの画像を直接表示。読めないときは代わりの表示）
export const JACKET_BASE = 'https://maimai.sega.jp/storage/DX_jacket/';

// "13+" → 13.5（並べ替え用）
export function levelNum(lv) {
  const m = String(lv || '').match(/^(\d+)(\+?)/);
  return m ? Number(m[1]) + (m[2] ? 0.5 : 0) : 0;
}

export function versionName(vp) {
  return VERSION_NAMES[vp] || `Ver.${vp}`;
}

// 13 → 13.0, 13+ → 13.7（定数が未判明のときの推定値）
export function levelToConst(lv) {
  const m = String(lv || '').match(/^(\d+)(\+?)/);
  if (!m) return 0;
  return Number(m[1]) + (m[2] ? 0.7 : 0);
}

// 曲名照合・検索用の正規化
export function norm(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)) // ひらがな→カタカナ
    .replace(/[!-/:-@[-`{-~、。・「」『』（）【】〈〉《》〜～♪♡♥♦◆☆★！？…‥‐–—―ー一ｰ'"“”‘’‼∞→]/g, '');
}

export function bigrams(s) {
  const set = new Set();
  if (s.length === 1) set.add(s);
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

export function dice(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return (2 * n) / (a.size + b.size);
}

export class SongIndex {
  // typeVers: { '曲ID|dx': '255' } 古い曲に後から追加された譜面種別と、その追加バージョン
  constructor(raw, typeVers = {}) {
    const list = raw.filter((s) => s.catcode !== '宴会場' && !s.lev_utage);
    const count = {};
    for (const s of list) count[s.title] = (count[s.title] || 0) + 1;
    this.songs = [];
    this.byId = new Map();
    this.charts = new Map();
    let maxVp = '0';
    for (const s of list) {
      const id = count[s.title] > 1 ? `${s.title}|${s.artist}` : s.title;
      const vp = String(s.version || '').slice(0, 3);
      if (!s.deleted_date && vp > maxVp && vp in VERSION_NAMES) maxVp = vp;
      const song = {
        id, title: s.title, artist: s.artist, kana: s.title_kana || '', vp,
        cat: s.catcode, deleted: !!s.deleted_date, charts: [],
        img: s.image_url || '', sort: parseInt(s.sort, 10) || 99999,
      };
      for (const [type, p] of [['std', ''], ['dx', 'dx_']]) {
        for (const d of DIFFS) {
          const lv = s[`${p}lev_${d}`];
          if (!lv) continue;
          let c = parseFloat(s[`${p}lev_${d}_i`]);
          let est = false;
          if (!c) { c = levelToConst(lv); est = true; }
          const notes = parseInt(s[`${p}lev_${d}_notes`], 10) || 0;
          // 譜面のバージョン：後から追加された種別ならそのバージョン、それ以外は曲のバージョン
          const chart = { type, diff: d, lv, c, est, notes, vp: typeVers[`${id}|${type}`] || vp };
          song.charts.push(chart);
          this.charts.set(`${id}|${type}|${d}`, { song, chart });
        }
      }
      if (!song.charts.length) continue;
      song.n = norm(s.title);
      song.nk = norm(s.title_kana);
      song.bg = bigrams(song.n);
      this.songs.push(song);
      this.byId.set(id, song);
    }
    this.currentVp = maxVp;
    // 存在するバージョン接頭辞（新しい順）
    this.vps = [...new Set(this.songs.map((s) => s.vp))].filter((v) => v in VERSION_NAMES).sort().reverse();
  }

  chart(key) {
    return this.charts.get(key) || null;
  }

  search(q, limit = 30) {
    const n = norm(q);
    if (!n) return [];
    const out = [];
    for (const s of this.songs) {
      let score = 0;
      if (s.n === n) score = 3;
      else if (s.n.startsWith(n)) score = 2;
      else if (s.n.includes(n) || s.nk.includes(n) || norm(s.artist).includes(n)) score = 1;
      if (score) out.push([score, s]);
    }
    out.sort((a, b) => b[0] - a[0] || a[1].title.length - b[1].title.length);
    return out.slice(0, limit).map((x) => x[1]);
  }
}
