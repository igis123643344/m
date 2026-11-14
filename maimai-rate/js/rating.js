// レート計算ロジック（maimai でらっくす Splash PLUS 以降の方式）
// 単曲レート = floor(譜面定数 × 係数 × min(達成率, 100.5%))
// 合計 = 旧曲ベスト35 + 新曲ベスト15

// [達成率×10000 の下限, 係数×10]
export const COEF_TABLE = [
  [1005000, 224], // SSS+
  [1004999, 222],
  [1000000, 216], // SSS
  [999999, 214],
  [995000, 211],  // SS+
  [990000, 208],  // SS
  [989999, 206],
  [980000, 203],  // S+
  [970000, 200],  // S
  [969999, 176],
  [940000, 168],  // AAA
  [900000, 152],  // AA
  [800000, 136],  // A
  [799999, 128],
  [750000, 120],  // BBB
  [700000, 112],  // BB
  [600000, 96],   // B
  [500000, 80],   // C
  [400000, 64],
  [300000, 48],
  [200000, 32],
  [100000, 16],
  [0, 0],
];

export const RANKS = [
  [100.5, 'SSS+'], [100, 'SSS'], [99.5, 'SS+'], [99, 'SS'], [98, 'S+'], [97, 'S'],
  [94, 'AAA'], [90, 'AA'], [80, 'A'], [75, 'BBB'], [70, 'BB'], [60, 'B'], [50, 'C'], [0, 'D'],
];

export const NEW_COUNT = 15;
export const OLD_COUNT = 35;

export function toA4(ach) {
  return Math.round(Number(ach) * 10000);
}

export function coefOf(a4) {
  for (const [min, k] of COEF_TABLE) if (a4 >= min) return k;
  return 0;
}

export function songRating(constant, ach) {
  if (!constant || !(ach >= 0)) return 0;
  const a4 = Math.min(toA4(ach), 1005000);
  const c10 = Math.round(constant * 10);
  return Math.floor((c10 * coefOf(a4) * a4) / 1e8);
}

export function rankOf(ach) {
  for (const [min, r] of RANKS) if (ach >= min) return r;
  return 'D';
}

// 次のランクに必要な達成率と、そのときの単曲レート
export function nextTargets(constant, ach) {
  const out = [];
  for (const [min, r] of [...RANKS].reverse()) {
    if (min > ach && min >= 97) out.push({ rank: r, ach: min, rating: songRating(constant, min) });
  }
  return out;
}

export function chartKey(songId, type, diff) {
  return `${songId}|${type}|${diff}`;
}

// plays: 記録の配列, index: songs.js の SongIndex, newVps: 新曲扱いのバージョン接頭辞の配列
export function computeBest(plays, index, newVps) {
  const best = new Map();
  for (const p of plays) {
    const prev = best.get(p.chartKey);
    if (!prev || p.ach > prev.ach || (p.ach === prev.ach && (p.playedAt || 0) > (prev.playedAt || 0))) {
      best.set(p.chartKey, p);
    }
  }
  const entries = [];
  for (const p of best.values()) {
    const found = index ? index.chart(p.chartKey) : null;
    if (!found || found.song.deleted) continue; // 削除曲はベ枠に入らない
    const { song, chart } = found;
    entries.push({
      chartKey: p.chartKey,
      songId: song.id,
      title: song.title,
      vp: chart.vp || song.vp,
      type: chart.type,
      diff: chart.diff,
      lv: chart.lv,
      c: chart.c,
      est: chart.est,
      ach: p.ach,
      fc: p.fc || '',
      dx: p.dx ?? null,
      playedAt: p.playedAt,
      rating: songRating(chart.c, p.ach),
      isNew: newVps.includes(chart.vp || song.vp), // 新曲枠かどうかは譜面のバージョンで決める
    });
  }
  const sorter = (a, b) => b.rating - a.rating || b.ach - a.ach || b.c - a.c;
  const news = entries.filter((e) => e.isNew).sort(sorter);
  const olds = entries.filter((e) => !e.isNew).sort(sorter);
  const newList = news.slice(0, NEW_COUNT);
  const oldList = olds.slice(0, OLD_COUNT);
  const sum = (l) => l.reduce((s, e) => s + e.rating, 0);
  return {
    newList,
    oldList,
    newNext: news.slice(NEW_COUNT, NEW_COUNT + 5),
    oldNext: olds.slice(OLD_COUNT, OLD_COUNT + 5),
    newTotal: sum(newList),
    oldTotal: sum(oldList),
    total: sum(newList) + sum(oldList),
    bestMap: best,
  };
}
