import * as db from './db.js';
import { SongIndex, DEFAULT_SONG_URL, DIFFS, DIFF_LABEL, DIFF_SHORT, TYPE_LABEL, versionName, GENRES, GENRE_COLOR, JACKET_BASE, levelNum, norm } from './songs.js';
import { computeBest, songRating, rankOf, chartKey, nextTargets } from './rating.js';
import { recognize, matchSongs, guessChart } from './ocr.js';
import { recognizeResult } from './result-reader.js';

const APP_VERSION = '1.6.0';
const SONG_SCHEMA = 2;
const SONG_REFRESH_MS = 24 * 60 * 60 * 1000;
const BACKUP_REMIND_DAYS = 14;
const HISTORY_COUNT = 30;

const state = {
  index: null,
  songsMeta: null,
  plays: [],
  snapshots: [],
  settings: { newVps: null, songUrl: DEFAULT_SONG_URL },
  lastBackup: null,
  persisted: null,
  best: null,
  tab: 'best',
  bestVp: null, // ベ枠で表示中の過去バージョン（null = 現在）
  songsView: { genre: 'all', ver: 'all', level: null, cst: null, q: '', limit: 60, showLow: false, showAllVer: false,
    sort: 'official', order: 'asc', sortDiff: 'mas', plate: null },
  plateSel: 'kiwami', // プレート確認で選んでいる目標
  lampOpen: new Set(), // 「FC/APだけ記録」を開いている譜面
  lamps: {},       // 譜面ごとの FC/AP 記録 { chartKey: 'fc'|'fcp'|'ap'|'app' }
  constHist: null, // 直近3バージョンからの定数変更
  typeVers: {},    // 古い曲に後から追加された譜面種別 → 追加バージョン
  queue: [],   // 読み取り待ちの写真
  qi: 0,
  form: null,  // 入力中の記録
  loadingSongs: false,
};

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n).toLocaleString('ja-JP');
const fmtAch = (a) => (a == null ? '-' : `${Number(a).toFixed(4)}%`);
const fmtDate = (t) => {
  if (!t) return '-';
  const d = new Date(t);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
};
const fmtDateTime = (t) => {
  const d = new Date(t);
  return `${fmtDate(t)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const toLocalInput = (t) => {
  const d = new Date(t);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), ms);
}

// maimai のレート帯の色（目安）
function bandColor(r) {
  const bands = [
    [15000, 'linear-gradient(90deg,#ff5c5c,#ffc93c,#4fd18b,#4aa8ff,#b06bff)'],
    [14500, '#d9e7f2'], [14000, '#f2c94c'], [13000, '#c0c6cf'], [12000, '#c48a52'],
    [10000, '#a35bd6'], [7000, '#e5484d'], [4000, '#e2b100'], [2000, '#3fae2a'], [1000, '#4a8cff'], [0, '#bbb'],
  ];
  for (const [min, c] of bands) if (r >= min) return c;
  return '#bbb';
}

const newVps = () =>
  state.settings.newVps && state.settings.newVps.length ? state.settings.newVps : state.index ? [state.index.currentVp] : [];

// ---------------- データ読み込み ----------------

function slimSongs(raw) {
  const keep = /^(sort|title|title_kana|artist|catcode|version|image_url|deleted_date|lev_utage|(dx_)?lev_(bas|adv|exp|mas|remas)(_i|_notes)?)$/;
  return raw.map((s) => {
    const o = {};
    for (const k in s) if (keep.test(k)) o[k] = s[k];
    return o;
  });
}

async function fetchSongs({ silent = false } = {}) {
  if (state.loadingSongs) return;
  state.loadingSongs = true;
  if (!silent) render();
  try {
    let raw, source = 'otoge-db', dataDate = Date.now();
    try {
      const res = await fetch(state.settings.songUrl || DEFAULT_SONG_URL, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
      if (!Array.isArray(raw) || raw.length < 100) throw new Error('曲データの形式が想定と違います');
    } catch (e) {
      // ネットから取れないとき：アプリ同梱の曲データを使う（まだ何も無いか、同梱版の方が新しい場合のみ）
      const res = await fetch('./data/songs.json');
      if (!res.ok) throw e;
      const bundled = await res.json();
      const curDate = state.songsMeta?.schema === SONG_SCHEMA ? state.songsMeta?.dataDate || 0 : 0;
      if (state.index && bundled.generatedAt <= curDate) throw e;
      raw = bundled.songs;
      source = 'bundled';
      dataDate = bundled.generatedAt;
    }
    // 前回のデータにあって今回なくなった曲（削除曲）は、ジャケットなどの情報を残したまま「削除曲」として持ち続ける
    const slim = keepDeleted(slimSongs(raw), (await db.kvGet('songsRaw')) || []);
    let index = new SongIndex(slim, state.typeVers);
    // 前回のデータに無かった譜面種別（古い曲のでらっくす譜面など）は、今のバージョンで追加されたものとして記録
    if (state.index) {
      let added = 0;
      for (const song of index.songs) {
        const prev = state.index.byId.get(song.id);
        if (!prev || song.vp >= index.currentVp) continue;
        for (const t of new Set(song.charts.map((c) => c.type))) {
          const key = `${song.id}|${t}`;
          if (!prev.charts.some((c) => c.type === t) && !state.typeVers[key]) { state.typeVers[key] = index.currentVp; added++; }
        }
      }
      if (added) {
        const mine = (await db.kvGet('typeVers')) || {};
        for (const [k, v] of Object.entries(state.typeVers)) if (!(k in (state.bundledTypeVers || {}))) mine[k] = v;
        await db.kvSet('typeVers', mine);
        index = new SongIndex(slim, state.typeVers);
      }
    }
    const prevVp = state.songsMeta?.currentVp;
    await db.kvSet('songsRaw', slim);
    state.songsMeta = { schema: SONG_SCHEMA, fetchedAt: Date.now(), dataDate, source, count: index.songs.length, currentVp: index.currentVp };
    await db.kvSet('songsMeta', state.songsMeta);
    state.index = index;
    if (prevVp && prevVp !== index.currentVp) {
      // バージョンが変わった：前バージョンのベ枠はそのまま保存され、新曲枠の設定は自動に戻す
      state.settings.newVps = null;
      await db.kvSet('settings', state.settings);
      toast(`新バージョン「${versionName(index.currentVp)}」を検出しました。${versionName(prevVp)}のベ枠は保存済みです`, 5000);
    } else if (!silent) {
      toast(source === 'bundled'
        ? `アプリ同梱の曲データを使います（${fmtDate(dataDate)}時点・${index.songs.length}曲）`
        : `曲データを更新しました（${index.songs.length}曲）`, 3500);
    }
    await recompute();
  } catch (e) {
    console.error(e);
    if (!silent || !state.index) toast(`曲データを取得できませんでした：${e.message}`, 4000);
  } finally {
    state.loadingSongs = false;
    render();
  }
}

// 削除曲の情報を残す：prev にあって list に無い曲を、削除曲として list に加える（アプリ同梱の削除曲も）
function keepDeleted(list, prev) {
  const key = (s) => `${s.title}|${s.artist}`;
  const have = new Set(list.map(key));
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const out = [...list];
  for (const s of [...prev, ...(state.extraDeleted || [])]) {
    if (have.has(key(s)) || s.catcode === '宴会場' || s.lev_utage) continue;
    have.add(key(s));
    out.push({ ...s, deleted_date: s.deleted_date || today });
  }
  return out;
}

async function loadAll() {
  const [raw, meta, settings, plays, snaps, lastBackup, lamps] = await Promise.all([
    db.kvGet('songsRaw'), db.kvGet('songsMeta'), db.kvGet('settings'),
    db.getAll('plays'), db.getAll('snapshots'), db.kvGet('lastBackup'), db.kvGet('lamps'),
  ]);
  if (settings) state.settings = { ...state.settings, ...settings };
  // 古い曲に後から追加された譜面種別（アプリ同梱分＋このアプリが見つけた分）
  try {
    const res = await fetch('./data/chart-versions.json');
    if (res.ok) state.bundledTypeVers = (await res.json()).types || {};
  } catch { state.bundledTypeVers = {}; }
  state.typeVers = { ...(state.bundledTypeVers || {}), ...((await db.kvGet('typeVers')) || {}) };
  try {
    const res = await fetch('./data/deleted-songs.json');
    if (res.ok) state.extraDeleted = (await res.json()).songs || [];
  } catch { state.extraDeleted = []; }
  if (raw) state.index = new SongIndex(keepDeleted(raw, []), state.typeVers);
  state.songsMeta = meta;
  state.plays = plays;
  state.snapshots = snaps;
  state.lastBackup = lastBackup;
  state.lamps = {};
  for (const [k, v] of Object.entries(lamps || {})) state.lamps[k] = typeof v === 'string' ? { c: v } : v; // 旧形式を変換
  if (!lamps) { for (const p of plays) raiseLamp(p.chartKey, p.fc); if (plays.length) await db.kvSet('lamps', state.lamps); }
  state.persisted = await db.isPersisted();
  try {
    const res = await fetch('./data/const-history.json');
    if (res.ok) state.constHist = await res.json();
  } catch { state.constHist = null; }
}

// ---- FC / AP ----
// 譜面ごとの記録 { c: コンボ(fc/fcp/ap/app), s: SSS達成(true), y: シンク(fdx/fdxp) }
const LAMP_ORDER = ['', 'fc', 'fcp', 'ap', 'app'];
const SYNC_ORDER = ['', 'fdx', 'fdxp'];
const LAMP_LABEL = { fc: 'FC', fcp: 'FC+', ap: 'AP', app: 'AP+', fdx: 'FDX', fdxp: 'FDX+', sss: 'SSS' };
const lampRec = (key) => { const r = state.lamps[key]; return typeof r === 'string' ? { c: r } : r || {}; };
const lampOf = (key) => lampRec(key).c || '';
const syncOf = (key) => lampRec(key).y || '';
const sssByScore = (key) => (state.best?.bestMap?.get(key)?.ach ?? 0) >= 100;
const sssOf = (key) => !!lampRec(key).s || sssByScore(key);
function setLamp(key, patch) {
  const r = { ...lampRec(key), ...patch };
  for (const k of Object.keys(r)) if (!r[k]) delete r[k];
  if (Object.keys(r).length) state.lamps[key] = r; else delete state.lamps[key];
}
function raiseLamp(key, fc) {
  if (fc && LAMP_ORDER.indexOf(fc) > LAMP_ORDER.indexOf(lampOf(key))) setLamp(key, { c: fc });
}
function mergeLamp(key, v) {
  const r = typeof v === 'string' ? { c: v } : v || {};
  raiseLamp(key, r.c);
  if (r.s) setLamp(key, { s: true });
  if (r.y && SYNC_ORDER.indexOf(r.y) > SYNC_ORDER.indexOf(syncOf(key))) setLamp(key, { y: r.y });
}
const lampClass = (l) => (l.startsWith('ap') ? 'ap' : l.startsWith('fdx') ? 'sync' : l === 'sss' ? 'sss' : 'fc');
// 難易度の右に出す FC/AP・SSS・FDX の表示
function lampChips(key, { withSss = true } = {}) {
  const out = [];
  const c = lampOf(key), y = syncOf(key);
  if (c) out.push(`<span class="chip ${lampClass(c)}">${LAMP_LABEL[c]}</span>`);
  if (withSss && sssOf(key)) out.push('<span class="chip sss">SSS</span>');
  if (y) out.push(`<span class="chip sync">${LAMP_LABEL[y]}</span>`);
  return out.join('');
}

// ---- 定数の変更（直近3バージョン） ----
// 例：定数 13.8（CiRCLE PLUS: 13.6）
function constChange(key) {
  const h = state.constHist?.changes?.[key];
  if (!h) return null;
  return { name: state.constHist.names[h[0]] || versionName(h[0]), value: h[1] };
}
function constText(key, chart) {
  const ch = constChange(key);
  return `${chart.c.toFixed(1)}${chart.est ? '?' : ''}${ch ? `<span class="cchg">（${esc(ch.name)}: ${ch.value.toFixed(1)}）</span>` : ''}`;
}

function slimEntry(e) {
  return { chartKey: e.chartKey, title: e.title, type: e.type, diff: e.diff, lv: e.lv, c: e.c, ach: e.ach, fc: e.fc, rating: e.rating };
}

async function recompute() {
  if (!state.index) { state.best = null; return; }
  state.best = computeBest(state.plays, state.index, newVps());
  // 現行バージョンのベ枠を記録（前のバージョンの記録は固定のまま残る）
  const vp = state.index.currentVp;
  const b = state.best;
  const snap = {
    vp, name: versionName(vp), rating: b.total, newTotal: b.newTotal, oldTotal: b.oldTotal,
    newList: b.newList.map(slimEntry), oldList: b.oldList.map(slimEntry), newVps: newVps(),
  };
  const prev = state.snapshots.find((s) => s.vp === vp);
  const sig = (s) => JSON.stringify([s.rating, s.newList, s.oldList]);
  if (state.plays.length && (!prev || sig(prev) !== sig(snap))) {
    snap.updatedAt = Date.now();
    snap.firstAt = prev?.firstAt || snap.updatedAt;
    await db.put('snapshots', snap);
    state.snapshots = [...state.snapshots.filter((s) => s.vp !== vp), snap];
  }
}

// ---------------- 描画 ----------------

function render() {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  // 過去のバージョンを表示中は、右に当時のレート
  const past = state.tab === 'best' && state.bestVp && state.index && state.bestVp !== state.index.currentVp
    ? state.snapshots.find((x) => x.vp === state.bestVp) : null;
  // 上部中央には常にバージョン名（ふだんは今のバージョン、過去のベ枠を開いている間は当時のバージョン）
  const hc = $('#hdrCenter');
  hc.textContent = past ? past.name : state.index ? versionName(state.index.currentVp) : '';
  hc.classList.toggle('past', !!past);
  const r = past ? past.rating : state.best?.total;
  $('#hdrRating').innerHTML = past || (state.best && state.plays.length)
    ? `<span class="band" style="background:${bandColor(r)}"></span>${fmt(r)}` : '';
  renderBanner();
  const fn = { best: renderBest, add: renderAdd, history: renderHistory, songs: renderSongs, settings: renderSettings }[state.tab];
  view.innerHTML = fn();
  if (state.tab === 'add' && state.form) afterFormRender();
}

function renderBanner() {
  const el = $('#banner');
  const days = state.lastBackup ? (Date.now() - state.lastBackup) / 864e5 : Infinity;
  if (state.plays.length >= 5 && days > BACKUP_REMIND_DAYS) {
    el.innerHTML = `<div class="banner"><span>${state.lastBackup ? `最後のバックアップから${Math.floor(days)}日経ちました` : 'まだバックアップがありません'}</span>
      <button class="btn" data-action="backupShare">バックアップ</button></div>`;
  } else el.innerHTML = '';
}

function noSongsCard() {
  if (state.loadingSongs) return `<div class="card empty">曲データを読み込んでいます…</div>`;
  return `<div class="card empty">曲データがまだありません。<br>
    <button class="btn primary" data-action="fetchSongs">曲データを取得</button></div>`;
}

function chipsFor(e) {
  const lamp = lampOf(e.chartKey) || e.fc;
  const sync = syncOf(e.chartKey);
  const fc = (lamp ? `<span class="chip ${lampClass(lamp)}">${LAMP_LABEL[lamp]}</span>` : '') + (sync ? `<span class="chip sync">${LAMP_LABEL[sync]}</span>` : '');
  return `<span class="chip ${e.type}">${TYPE_LABEL[e.type]}</span>
    <span class="chip diff d-${e.diff}">${DIFF_SHORT[e.diff]} ${esc(e.lv)}</span>
    <span class="${e.est ? 'est' : ''}" title="${e.est ? '定数未判明のため推定値' : ''}">${Number(e.c).toFixed(1)}${e.est ? '?' : ''}${pastConstNote(e)}</span>
    <span>${fmtAch(e.ach)}</span><span class="rank">${rankOf(e.ach)}</span>${fc}`;
}

// 過去のベ枠：当時の定数の横に、今の定数が違えば（現在: ○○）
function pastConstNote(e) {
  if (!e.past) return '';
  if (e.cNow === null) return '<span class="cchg">（現在: 削除曲）</span>';
  return Math.abs(e.cNow - e.c) > 1e-6 ? `<span class="cchg">（現在: ${e.cNow.toFixed(1)}）</span>` : '';
}

// 譜面の行に付ける小さなジャケット（削除曲などで曲データに無いときは頭文字）
function rowJacket(key, title) {
  const song = state.index?.chart(key)?.song || { title: title || '?', cat: '', img: '' };
  return jacket(song, 's');
}

function rowHtml(e, i, { dim = false } = {}) {
  return `<button class="row jrow d-${e.diff} ${dim ? 'dim' : ''}" data-action="chart" data-key="${esc(e.chartKey)}">
    <div class="no">${i}</div>
    ${rowJacket(e.chartKey, e.title)}
    <div class="main"><div class="ttl">${esc(e.title)}</div><div class="sub">${chipsFor(e)}</div></div>
    <div class="rt">${e.rating}</div></button>`;
}

function frameSection(title, list, total, count, next, { readonly = false } = {}) {
  const min = list.length ? list[list.length - 1].rating : 0;
  const avg = list.length ? (total / list.length).toFixed(1) : '0';
  const rows = list.length ? list.map((e, i) => rowHtml(e, i + 1)).join('') : `<div class="empty small">まだ記録がありません</div>`;
  const nextHtml = !readonly && next && next.length
    ? `<details class="next"><summary>次点（あと少しで枠入り）${next.length}曲</summary><div class="list">${next.map((e, i) => rowHtml(e, list.length + i + 1, { dim: true })).join('')}</div></details>` : '';
  return `<div class="sec-head"><h2>${title} <span class="muted small">${list.length}/${count}</span></h2>
    <div class="meta">合計 <b class="num">${fmt(total)}</b> ・ 平均 ${avg} ・ 最低 ${min}</div></div>
    <div class="list">${rows}</div>${nextHtml}`;
}

const VER_BTN = `<button class="btn block ver-btn" data-action="versions">
  <svg viewBox="0 0 24 24"><path d="M12 3 2 8l10 5 10-5-10-5zM2 16l10 5 10-5M2 12l10 5 10-5"/></svg>今までのバージョンを確認する</button>`;

function renderBest() {
  if (!state.index) return noSongsCard();
  if (state.bestVp && state.bestVp !== state.index.currentVp) return renderPastBest(state.bestVp);
  const b = state.best;
  const vpNames = newVps().map(versionName).join('・');
  const hero = `${VER_BTN}<div class="card hero">
    <div class="label">現在のレート（${esc(versionName(state.index.currentVp))}）</div>
    <div class="big"><span class="band" style="width:14px;height:14px;background:${bandColor(b.total)}"></span>${fmt(b.total)}</div>
    <div class="split"><span>新曲枠 <b class="num">${fmt(b.newTotal)}</b></span><span>旧曲枠 <b class="num">${fmt(b.oldTotal)}</b></span></div>
  </div>`;
  if (!state.plays.length) {
    return hero + `<div class="card empty">まだ記録がありません。<br>リザルト画面の写真から記録しましょう。<br>
      <button class="btn primary" data-tab-go="add">記録する</button></div>`;
  }
  return hero +
    frameSection(`新曲枠 <span class="muted small">(${esc(vpNames)})</span>`, b.newList, b.newTotal, 15, b.newNext) +
    frameSection('旧曲枠', b.oldList, b.oldTotal, 35, b.oldNext);
}

// 過去バージョンのベ枠（保存された当時の状態）
function renderPastBest(vp) {
  const s = state.snapshots.find((x) => x.vp === vp);
  if (!s) { state.bestVp = null; return renderBest(); }
  // 当時の定数・スコアで表示し、今の定数も添える
  const withNow = (l) => l.map((e) => ({ ...e, est: false, past: true, cNow: state.index.chart(e.chartKey)?.chart.c ?? null }));
  return `${VER_BTN}<div class="past-bar"><span>${esc(s.name)} のベ枠を表示中</span>
      <button class="btn" data-action="bestCurrent">現在に戻る</button></div>
    <div class="card hero">
      <div class="label">${esc(s.name)} の最終レート</div>
      <div class="big"><span class="band" style="width:14px;height:14px;background:${bandColor(s.rating)}"></span>${fmt(s.rating)}</div>
      <div class="split"><span>新曲枠 <b class="num">${fmt(s.newTotal)}</b></span><span>旧曲枠 <b class="num">${fmt(s.oldTotal)}</b></span></div>
      <div class="small muted" style="margin-top:6px">${fmtDate(s.firstAt)} 〜 ${fmtDate(s.updatedAt)} の記録</div>
    </div>
    ${frameSection('新曲枠', withNow(s.newList), s.newTotal, 15, null, { readonly: true })}
    ${frameSection('旧曲枠', withNow(s.oldList), s.oldTotal, 35, null, { readonly: true })}
    <p class="muted small">当時の譜面定数とスコアで計算した値です。（現在: ○○）は今の譜面定数です。</p>`;
}

function openVersionList() {
  const snaps = [...state.snapshots].sort((a, b) => b.vp.localeCompare(a.vp));
  const cur = state.index?.currentVp;
  const shown = state.bestVp || cur;
  const rows = snaps.map((s) => `<button class="row" style="grid-template-columns:1fr auto" data-action="pickVersion" data-vp="${s.vp}">
      <div class="main"><div class="ttl">${esc(s.name)} ${s.vp === cur ? '<span class="chip ap">現在</span>' : ''}${s.vp === shown ? ' <span class="chip">表示中</span>' : ''}</div>
      <div class="sub">新曲 ${fmt(s.newTotal)} ・ 旧曲 ${fmt(s.oldTotal)} ・ ${fmtDate(s.firstAt)}〜${fmtDate(s.updatedAt)}</div></div>
      <div class="rt"><span class="band" style="background:${bandColor(s.rating)}"></span>${fmt(s.rating)}</div></button>`).join('');
  openSheet(`<h3>バージョンごとのベ枠</h3>
    <p class="muted small" style="margin:2px 0 10px">今のバージョンのベ枠は記録のたびに自動で更新されます。バージョンが切り替わると、前のバージョンの最後の状態がここに残ります。</p>
    <div class="list">${rows || '<div class="empty small">まだ記録がありません</div>'}</div>
    ${snaps.length <= 1 ? '<p class="muted small">過去のバージョンは、次のバージョンが始まるとここに追加されます。</p>' : ''}`);
}

// ---- 記録する ----

function renderAdd() {
  if (!state.index) return noSongsCard();
  if (state.form) return renderForm();
  return `<div class="card">
      <h2>リザルト画面から記録</h2>
      <p class="muted small" style="margin-top:0">写真から曲名・難易度・達成率を読み取ります。読み取り結果は保存前に確認・修正できます。</p>
      <div class="big-actions">
        <button class="btn primary" data-action="pickCamera">
          <svg viewBox="0 0 24 24"><path d="M3 8a2 2 0 0 1 2-2h2l2-2h6l2 2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="4"/></svg>カメラで撮影</button>
        <button class="btn" data-action="pickGallery">
          <svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/></svg>撮った写真を選ぶ（複数可）</button>
        <button class="btn" data-action="manual">手入力で記録</button>
      </div>
    </div>
    <div class="card small muted">
      <b style="color:var(--text)">うまく読み取るコツ</b><br>
      ・画面の正面から、画面全体が入るように撮る<br>
      ・照明の映り込み・反射を避ける<br>
      ・ブレないように（連続撮影より1枚ずつ）<br>
      ・初回はOCRデータ（約12MB）を読み込むので少し時間がかかります
    </div>`;
}

function newForm(extra = {}) {
  return {
    id: null, songId: null, type: null, diff: null, ach: '', dx: '', dxMax: null, fc: '',
    playedAt: Date.now(), cands: [], status: 'ready', progress: 0, msg: '', text: '', photoUrl: null,
    need: {}, src: 'manual', searchQ: '', ...extra,
  };
}

function renderForm() {
  const f = state.form;
  const q = state.queue;
  const qnav = q.length > 1 ? `<div class="qnav"><span>写真 ${state.qi + 1} / ${q.length}</span><button class="btn" style="min-height:32px;padding:2px 10px" data-action="qSkip">この写真をスキップ</button></div>` : '';
  const photo = f.photoUrl ? `<img class="photo" src="${f.photoUrl}" alt="リザルト写真" data-action="zoom">` : '';
  if (f.status === 'reading') {
    return `<div class="card">${qnav}${photo}
      <p style="margin:12px 0 0;font-weight:700">読み取り中…</p>
      <div class="progress"><div style="width:${Math.round(f.progress * 100)}%"></div></div>
      <p class="muted small" style="margin:0">${esc(f.msg)}</p></div>`;
  }
  const song = f.songId ? state.index.byId.get(f.songId) : null;
  const hasChart = (t, d) => song && song.charts.some((c) => c.type === t && c.diff === d);
  const types = song ? [...new Set(song.charts.map((c) => c.type))] : ['std', 'dx'];
  const cands = f.cands.length
    ? `<div class="cand">${f.cands.map((c) => `<button data-action="pickSong" data-id="${esc(c.song.id)}" class="${c.song.id === f.songId ? 'on' : ''}">${esc(c.song.title)}</button>`).join('')}</div>` : '';
  return `<div class="card">${qnav}${photo}
    ${f.src === 'ocr' && !f.cands.length ? `<p class="small" style="color:var(--warn)">曲名を読み取れませんでした。下の検索で選んでください。</p>` : ''}
    <label class="f ${f.need.song ? 'need-label' : ''}">曲名</label>
    <div style="font-weight:800;font-size:16px">${song ? esc(song.title) : '<span class="muted">未選択</span>'}</div>
    ${song ? `<div class="muted small">${esc(song.artist)} ・ ${esc(versionName(song.vp))}</div>` : ''}
    ${cands}
    <input class="input" id="songSearch" placeholder="曲名で検索（ひらがな・英字・アーティスト）" value="${esc(f.searchQ)}" autocomplete="off" style="margin-top:8px">
    <div class="search-results" id="searchResults"></div>

    <label class="f ${f.need.type ? 'need-label' : ''}">譜面</label>
    <div class="seg">${['std', 'dx'].map((t) => `<button data-action="setType" data-v="${t}" class="${f.type === t ? 'on' : ''}" ${song && !types.includes(t) ? 'disabled' : ''}>${t === 'std' ? 'スタンダード' : 'でらっくす'}</button>`).join('')}</div>

    <label class="f ${f.need.diff ? 'need-label' : ''}">難易度</label>
    <div class="seg">${DIFFS.map((d) => `<button data-action="setDiff" data-v="${d}" class="d-${d} ${f.diff === d ? 'on' : ''}" ${song && f.type && !hasChart(f.type, d) ? 'disabled' : ''}>${DIFF_SHORT[d]}${song && f.type && hasChart(f.type, d) ? `<br><small>${esc(song.charts.find((c) => c.type === f.type && c.diff === d).lv)}</small>` : ''}</button>`).join('')}</div>

    <label class="f ${f.need.ach ? 'need-label' : ''}">達成率（%）</label>
    <input class="input big ${f.need.ach ? 'need' : ''}" id="achInput" inputmode="decimal" placeholder="100.5000" value="${esc(f.ach)}">

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
      <div><label class="f">DXスコア（任意）</label><input class="input" id="dxInput" inputmode="numeric" value="${esc(f.dx)}" placeholder="-"></div>
      <div><label class="f">FC / AP</label><select class="input" id="fcInput">
        ${[['', 'なし'], ['fc', 'FC'], ['fcp', 'FC+'], ['ap', 'AP'], ['app', 'AP+']].map(([v, l]) => `<option value="${v}" ${f.fc === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select></div>
    </div>
    <label class="f">プレイ日時</label>
    <input class="input" type="datetime-local" id="dateInput" value="${toLocalInput(f.playedAt)}">

    <div class="preview" id="preview"></div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn" data-action="cancelForm">${q.length > 1 ? 'すべて中止' : 'キャンセル'}</button>
      <button class="btn primary" data-action="saveForm" id="saveBtn">${f.id ? '更新する' : q.length > 1 && state.qi < q.length - 1 ? '保存して次へ' : '保存する'}</button>
    </div>
    ${f.text ? `<details style="margin-top:12px"><summary class="small muted">読み取った文字を見る</summary><pre class="raw">${esc(f.text)}</pre></details>` : ''}
  </div>`;
}

function afterFormRender() {
  const f = state.form;
  if (f.status === 'reading') return;
  const s = $('#songSearch');
  const doSearch = () => {
    f.searchQ = s.value;
    const res = state.index.search(s.value, 30);
    $('#searchResults').innerHTML = res.map((song) =>
      `<button data-action="pickSong" data-id="${esc(song.id)}">${esc(song.title)}<small>${esc(song.artist)} ・ ${esc(versionName(song.vp))}</small></button>`).join('');
  };
  s.addEventListener('input', doSearch);
  if (f.searchQ) doSearch();
  const bind = (id, key) => $(id).addEventListener('input', (e) => { f[key] = e.target.value; if (key === 'ach') f.need.ach = false; updatePreview(); });
  bind('#achInput', 'ach');
  bind('#dxInput', 'dx');
  $('#fcInput').addEventListener('change', (e) => { f.fc = e.target.value; updatePreview(); });
  $('#dateInput').addEventListener('change', (e) => { const t = new Date(e.target.value).getTime(); if (t) f.playedAt = t; });
  updatePreview();
}

function formChart() {
  const f = state.form;
  if (!f.songId || !f.type || !f.diff) return null;
  return state.index.chart(chartKey(f.songId, f.type, f.diff));
}

function parseAchInput(v) {
  const n = parseFloat(String(v).normalize('NFKC').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) && n >= 0 && n <= 101 ? n : null;
}

function updatePreview() {
  const f = state.form;
  const el = $('#preview');
  if (!el) return;
  const found = formChart();
  const ach = parseAchInput(f.ach);
  const ok = !!found && ach != null;
  $('#saveBtn').disabled = !ok;
  if (!found) { el.innerHTML = `<span class="muted small">曲・譜面・難易度を選ぶとレートを計算します</span>`; return; }
  const c = found.chart.c;
  if (ach == null) { el.innerHTML = `<span class="muted small">譜面定数 ${c.toFixed(1)}${found.chart.est ? '（推定）' : ''} ・ 達成率を入力してください</span>`; return; }
  const r = songRating(c, ach);
  const others = f.id ? state.plays.filter((p) => p.id !== f.id) : state.plays;
  const before = computeBest(others, state.index, newVps()).total;
  const after = computeBest([...others, { chartKey: chartKey(f.songId, f.type, f.diff), ach, playedAt: f.playedAt }], state.index, newVps()).total;
  const prevBest = others.filter((p) => p.chartKey === chartKey(f.songId, f.type, f.diff)).reduce((m, p) => Math.max(m, p.ach), -1);
  el.innerHTML = `<div><div class="small muted">定数 ${c.toFixed(1)}${found.chart.est ? '?' : ''} ・ ${rankOf(ach)}</div><div class="v">${r}</div></div>
    <div style="text-align:right" class="small">${after > before ? `<div class="gain">レート +${after - before}</div><div class="muted">${fmt(before)} → ${fmt(after)}</div>` : `<div class="muted">レート変化なし</div>`}
    ${prevBest >= 0 ? `<div class="muted">自己ベスト ${fmtAch(prevBest)}</div>` : '<div class="muted">初記録</div>'}</div>`;
}

// 写真の読み取り
async function startQueue(files) {
  if (!files.length) return;
  state.queue = files.map((file) => ({ file, url: URL.createObjectURL(file) }));
  state.qi = 0;
  state.tab = 'add';
  await processCurrent();
}

async function processCurrent() {
  const item = state.queue[state.qi];
  if (!item) { endQueue(); return; }
  const form = newForm({ status: 'reading', photoUrl: item.url, src: 'ocr', playedAt: item.file.lastModified || Date.now(), msg: '準備中…' });
  state.form = form;
  render();
  try {
    const onProg = (m) => {
      if (state.form !== form) return;
      const label = {
        'loading tesseract core': 'OCRエンジンを読み込み中', 'initializing tesseract': '初期化中',
        'loading language traineddata': '文字データを読み込み中（初回のみ時間がかかります）',
        'initializing api': '初期化中', 'recognizing text': '文字を読み取り中',
      }[m.status] || m.status;
      form.msg = label;
      form.progress = m.progress || 0;
      const bar = $('.progress > div');
      if (bar) bar.style.width = `${Math.round(form.progress * 100)}%`;
      const p = $('.progress + p');
      if (p) p.textContent = label;
    };
    // まず画面の位置から項目ごとに読む方法。画面が見つからないときは従来の全体読み取りに切り替える
    let rr = null;
    if (state.settings.ocrMode !== 'legacy') try { rr = await recognizeResult(item.file, state.index, onProg); } catch (e) { console.warn('result-reader', e); }
    if (state.form !== form) return;
    if (rr) {
      const top = rr.song;
      let type = rr.type, diff = rr.diff;
      if (top && !top.charts.some((c) => c.type === type && c.diff === diff)) {
        const g = guessChart(top, { diff, dxMax: rr.dxMax });
        type = g.type; diff = g.diff;
      }
      Object.assign(form, {
        status: 'ready', text: rr.text, cands: rr.cands.filter((c, i) => i === 0 || c.score >= rr.cands[0].score * 0.6).map((c) => ({ song: c.song, score: c.score })), songId: top?.id || null,
        type, diff, ach: rr.ach != null ? rr.ach.toFixed(4) : '', dx: rr.dx ?? '', dxMax: rr.dxMax, fc: rr.fc,
        need: {
          song: !top || !rr.sure.song,
          type: !type, diff: !diff,
          ach: rr.ach == null || rr.ach > 101 || rr.ach < 0,
        },
      });
    } else {
      const res = await recognize(item.file, onProg);
      if (state.form !== form) return;
      const cands = matchSongs(res.text, state.index, { dxMax: res.dxMax });
      const top = cands[0] && (cands[0].score >= 0.5 || (cands.length === 1)) ? cands[0].song : null;
      const g = guessChart(top, res);
      Object.assign(form, {
        status: 'ready', text: res.text, cands, songId: top?.id || null,
        type: g.type, diff: g.diff, ach: res.ach != null ? res.ach.toFixed(4) : '', dx: res.dx ?? '', dxMax: res.dxMax, fc: res.fc,
        need: { song: !top || (cands[1] && cands[1].score > cands[0].score - 0.1), type: !g.type, diff: !g.diff, ach: res.ach == null },
      });
    }
  } catch (e) {
    console.error(e);
    if (state.form !== form) return;
    Object.assign(form, { status: 'ready', need: { song: true, type: true, diff: true, ach: true } });
    toast(`読み取りに失敗しました（${e.message}）。手入力で記録できます`, 4000);
  }
  render();
}

function endQueue() {
  state.queue.forEach((q) => URL.revokeObjectURL(q.url));
  state.queue = [];
  state.qi = 0;
  state.form = null;
}

async function saveForm() {
  const f = state.form;
  const found = formChart();
  const ach = parseAchInput(f.ach);
  if (!found || ach == null) return;
  const before = state.best?.total ?? 0;
  const play = {
    chartKey: chartKey(f.songId, f.type, f.diff), songId: f.songId, title: found.song.title,
    type: f.type, diff: f.diff, ach, dx: f.dx === '' ? null : parseInt(f.dx, 10) || null, dxMax: f.dxMax || null,
    fc: f.fc || '', playedAt: f.playedAt, recordedAt: Date.now(), vp: state.index.currentVp, src: f.src,
  };
  if (f.id) play.id = f.id;
  const id = await db.put('plays', play);
  play.id = id;
  state.plays = [...state.plays.filter((p) => p.id !== id), play];
  if (play.fc) { raiseLamp(play.chartKey, play.fc); await db.kvSet('lamps', state.lamps); }
  await recompute();
  if (state.persisted !== true) state.persisted = await db.requestPersist();
  const after = state.best.total;
  toast(after !== before ? `保存しました（レート ${fmt(before)} → ${fmt(after)}）` : '保存しました');
  if (f.id) { state.form = null; state.tab = state.returnTab || 'history'; render(); return; }
  if (state.queue.length && state.qi < state.queue.length - 1) {
    state.qi++;
    await processCurrent();
  } else {
    endQueue();
    render();
  }
}

// ---- 履歴 ----

function renderHistory() {
  if (!state.index) return noSongsCard();
  if (!state.plays.length) return `<div class="card empty">まだ記録がありません。</div>`;
  const plays = [...state.plays].sort((a, b) => b.playedAt - a.playedAt || b.id - a.id).slice(0, HISTORY_COUNT);
  const bestMap = state.best?.bestMap || new Map();
  const rows = plays.map((p) => {
    const f = state.index.chart(p.chartKey);
    const c = f ? f.chart.c : 0;
    const e = { chartKey: p.chartKey, title: f ? f.song.title : p.title, type: p.type, diff: p.diff, lv: f ? f.chart.lv : '?', c, est: f?.chart.est, ach: p.ach, fc: p.fc };
    const isBest = bestMap.get(p.chartKey)?.id === p.id;
    return `<button class="row jrow d-${p.diff}" data-action="chart" data-key="${esc(p.chartKey)}">
      <div class="no" style="font-size:10px;line-height:1.2">${fmtDate(p.playedAt).slice(5)}</div>
      ${rowJacket(p.chartKey, e.title)}
      <div class="main"><div class="ttl">${esc(e.title)}</div><div class="sub">${chipsFor(e)}${isBest ? '<span class="chip ap">BEST</span>' : ''}</div></div>
      <div class="rt">${songRating(c, p.ach)}</div></button>`;
  }).join('');
  return `<div class="sec-head" style="margin-top:4px"><h2>直近${HISTORY_COUNT}件の記録</h2><span class="meta">新しい順</span></div>
    <div class="list">${rows}</div>
    <p class="muted small" style="margin:10px 2px 0">それより前の記録も保存されています。曲ごとの記録は「楽曲リスト」から見られます。</p>`;
}

// ---- 楽曲リスト ----

// 並び替えの種類（[名前, 昇順の表示, 降順の表示]）
const SORTS = {
  official: ['公式順（ジャンル）', '通常', '逆順'],
  version: ['バージョン順', '古い順', '新しい順'],
  level: ['レベル順', '低い順', '高い順'],
  title: ['曲名順', 'あ→ん', 'ん→あ'],
  artist: ['アーティスト順', 'あ→ん', 'ん→あ'],
  score: ['スコア順', '低い順', '高い順'],
  lamp: ['FC/AP順', '低い順', '高い順'],
};
const SORT_NEEDS_DIFF = ['level', 'score', 'lamp'];

// 条件を変えたら：一覧を描き直し、開いているシートも更新
function afterFilter(sheet = openSortSheet) {
  state.songsView.limit = 60;
  render();
  sheet();
}

function jacket(song, size = 'm') {
  const color = GENRE_COLOR[song.cat] || 'var(--muted)';
  const initial = esc([...song.title.normalize('NFKC').replace(/\s/g, '')][0] || '?');
  const img = song.img ? `<img class="jk" src="${JACKET_BASE}${esc(song.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
  return `<span class="jkw jk-${size}" style="--gc:${color}" data-i="${initial}">${img}</span>`;
}

function bestOf(key) {
  return state.best?.bestMap?.get(key) || null;
}

function songMatchesQuery(song, n) {
  return !n || song.n.includes(n) || song.nk.includes(n) || norm(song.artist).includes(n);
}

const cstMatch = (c, cst) => !cst || cst === 'all' || (cst === 'est' ? c.est : !c.est && c.c.toFixed(1) === cst);

// ---- プレート ----
// 対象：そのバージョンの曲の BASIC〜MASTER（Re:MASTER は含まない）
const PLATES = {
  kiwami: { name: '極', desc: 'すべての譜面で FC 以上', ok: (k) => LAMP_ORDER.indexOf(lampOf(k)) >= 1 },
  shou: { name: '将', desc: 'すべての譜面で SSS 以上', ok: (k) => sssOf(k) },
  kami: { name: '神', desc: 'すべての譜面で AP 以上', ok: (k) => LAMP_ORDER.indexOf(lampOf(k)) >= 3 },
  maimai: { name: '舞舞', desc: 'すべての譜面で FDX 以上', ok: (k) => SYNC_ORDER.indexOf(syncOf(k)) >= 1 },
};
const PLATE_DIFFS = ['bas', 'adv', 'exp', 'mas'];
function plateCharts(song, ver = state.songsView.ver) {
  // 古い曲に後から追加された譜面は、追加されたバージョンの対象
  if (song.vp !== ver) return song.charts.filter((c) => c.vp === ver && PLATE_DIFFS.includes(c.diff));
  // でらっくす以前の曲はスタンダード譜面、それ以降はでらっくす譜面（無ければスタンダード）
  const own = song.charts.filter((c) => c.vp === song.vp);
  const type = song.vp < '200' || !own.some((c) => c.type === 'dx') ? 'std' : 'dx';
  return own.filter((c) => c.type === type && PLATE_DIFFS.includes(c.diff));
}
function plateMissing(song, plateId, diff = null) {
  const ok = PLATES[plateId].ok;
  return plateCharts(song).filter((c) => (!diff || c.diff === diff) && !ok(chartKey(song.id, c.type, c.diff)));
}

function openPlateSheet() {
  const v = state.songsView;
  state.sheetCtx = { type: 'plate' };
  const songs = state.index.songs.filter((s) => !s.deleted && plateCharts(s, v.ver).length);
  const pid = state.plateSel;
  const rows = PLATE_DIFFS.map((d) => {
    let total = 0, miss = 0;
    for (const s of songs) for (const c of plateCharts(s)) if (c.diff === d) { total++; if (plateMissing(s, pid, d).some((x) => x === c)) miss++; }
    return `<div class="prow d-${d}"><span class="chip diff d-${d}">${DIFF_LABEL[d]}</span>
      <span class="pnum">${miss ? `未達成 <b>${miss}</b>` : '<b class="ok">達成</b>'}<small> / ${total}譜面</small></span>
      ${miss ? `<button class="btn" data-action="plateShow" data-d="${d}">表示</button>` : '<span></span>'}</div>`;
  }).join('');
  const missSongs = songs.filter((s) => plateMissing(s, pid).length).length;
  keepSheetScroll(() => openSheet(`<h3>プレートを確認</h3>
    <p class="muted small" style="margin:2px 0 8px">${esc(versionName(v.ver))} の${songs.length}曲（BASIC〜MASTER）で数えます。Re:MASTER は含みません。</p>
    <div class="step">目標のプレート</div>
    <div class="plate-grid">${Object.entries(PLATES).map(([id, p]) =>
      `<button class="pbtn ${pid === id ? 'on' : ''}" data-action="plateSel" data-v="${id}"><b>${p.name}</b><small>${p.desc}</small></button>`).join('')}</div>
    <div class="step">${PLATES[pid].name}の未達成</div>
    <div class="list">${rows}</div>
    ${missSongs ? `<button class="btn primary block" style="margin-top:12px" data-action="plateShow">未達成の曲をすべて表示（${missSongs}曲）</button>`
      : `<div class="card empty small" style="margin-top:12px">${esc(versionName(v.ver))}の${PLATES[pid].name}は達成済みです</div>`}
    <p class="muted small">FC/AP・SSS・FDX は「FC/APだけ記録」とスコアの記録から判定します。公式の対象曲と違う場合があります。</p>`));
}

// FC等を記録した後、開いていた画面を描き直す
function reopenAfterLamp() {
  render();
  const ctx = state.sheetCtx;
  if (ctx?.type === 'song') openSong(ctx.id); else if (ctx?.type === 'chart') keepSheetScroll(() => openChart(ctx.key));
}

// 並び替え・表示に使う譜面（プレート確認中は未達成の譜面、レベル指定中はその譜面、なければ並び替えで選んだ難易度）
function targetCharts(song) {
  const v = state.songsView;
  if (v.plate) return plateMissing(song, v.plate.id, v.plate.diff);
  if (v.level) return song.charts.filter((c) => c.lv === v.level && cstMatch(c, v.cst));
  return song.charts.filter((c) => c.diff === v.sortDiff);
}

function sortValue(song) {
  const v = state.songsView;
  const cs = targetCharts(song);
  if (!cs.length) return null; // その難易度が無い曲は最後に
  if (v.sort === 'level') return Math.max(...cs.map((c) => c.c));
  if (v.sort === 'score') return Math.max(...cs.map((c) => bestOf(chartKey(song.id, c.type, c.diff))?.ach ?? -1));
  if (v.sort === 'lamp') return Math.max(...cs.map((c) => LAMP_ORDER.indexOf(lampOf(chartKey(song.id, c.type, c.diff)))));
  return 0;
}

const officialCmp = (a, b) => GENRES.indexOf(a.cat) - GENRES.indexOf(b.cat) || a.sort - b.sort;

// 条件に合う曲（skipCst：定数の件数を数えるとき用）
function baseSongs({ skipCst = false } = {}) {
  const v = state.songsView;
  const n = norm(v.q);
  return state.index.songs.filter((s) => !s.deleted
    && (v.genre === 'all' || s.cat === v.genre)
    && (v.ver === 'all' || s.vp === v.ver || s.charts.some((c) => c.vp === v.ver))
    && songMatchesQuery(s, n)
    && (!v.plate || plateMissing(s, v.plate.id, v.plate.diff).length)
    && (!v.level || s.charts.some((c) => c.lv === v.level && (skipCst || cstMatch(c, v.cst)))));
}

function songListResult() {
  const v = state.songsView;
  const items = baseSongs();
  const dir = v.order === 'desc' ? -1 : 1;
  let cmp;
  if (v.sort === 'version') cmp = (a, b) => dir * a.vp.localeCompare(b.vp) || officialCmp(a, b);
  else if (v.sort === 'title') cmp = (a, b) => dir * (a.kana || a.title).localeCompare(b.kana || b.title, 'ja');
  else if (v.sort === 'artist') cmp = (a, b) => dir * a.artist.localeCompare(b.artist, 'ja') || officialCmp(a, b);
  else if (SORT_NEEDS_DIFF.includes(v.sort)) {
    const val = new Map(items.map((s) => [s, sortValue(s)]));
    cmp = (a, b) => {
      const x = val.get(a), y = val.get(b);
      if (x === null || y === null) return (x === null) - (y === null);
      return dir * (x - y) || officialCmp(a, b);
    };
  } else cmp = (a, b) => dir * officialCmp(a, b);
  return items.sort(cmp);
}

function chartLine(song, c, { showBest = true } = {}) {
  const key = chartKey(song.id, c.type, c.diff);
  const b = bestOf(key);
  return `<span class="cl"><span class="chip ${c.type}">${TYPE_LABEL[c.type]}</span><span class="chip diff d-${c.diff}">${DIFF_SHORT[c.diff]} ${esc(c.lv)}</span>
    <span class="${c.est ? 'est' : ''}">${constText(key, c)}</span>
    ${showBest ? (b ? `<span>${fmtAch(b.ach)}</span>` : '<span class="muted">未プレイ</span>') : ''}${lampChips(key, { withSss: false })}</span>`;
}

function songRowSub(song) {
  const v = state.songsView;
  if (v.plate || v.level || SORT_NEEDS_DIFF.includes(v.sort)) {
    const cs = targetCharts(song);
    return cs.length ? cs.map((c) => chartLine(song, c)).join('') : `<span class="muted">${DIFF_LABEL[v.sortDiff]}なし</span>`;
  }
  // 通常は MASTER / Re:MASTER のレベル
  const out = [];
  for (const t of ['dx', 'std']) {
    const cs = song.charts.filter((c) => c.type === t && (c.diff === 'mas' || c.diff === 'remas'));
    if (!cs.length) continue;
    out.push(`<span class="chip ${t}">${TYPE_LABEL[t]}</span>` + cs.map((c) => `<span class="chip diff d-${c.diff}">${esc(c.lv)}</span>`).join(''));
  }
  const played = song.charts.filter((c) => bestOf(chartKey(song.id, c.type, c.diff))).length;
  return out.join('<span class="sp"></span>') + (played ? `<span class="played">${played}譜面プレイ済</span>` : '');
}

function groupLabel(song) {
  const v = state.songsView;
  if (v.sort === 'official' && v.genre === 'all') return [song.cat, GENRE_COLOR[song.cat]];
  if (v.sort === 'version' && v.ver === 'all') return [versionName(song.vp), null];
  return null;
}

function renderSongs() {
  if (!state.index) return noSongsCard();
  const v = state.songsView;
  const nFilters = (v.genre !== 'all') + (v.ver !== 'all') + !!v.level;
  const toolbar = `<div class="song-tools">
      <input class="input" id="songListSearch" placeholder="曲名・アーティスト" value="${esc(v.q)}" autocomplete="off">
      <button class="btn tool-btn ${v.sort !== 'official' || v.order !== 'asc' ? 'active' : ''}" data-action="songOrder">
        <svg viewBox="0 0 24 24"><path d="M7 4v16M3 16l4 4 4-4M17 20V4M13 8l4-4 4 4"/></svg>並び替え</button>
      <button class="btn tool-btn ${nFilters ? 'active' : ''}" data-action="songSort">
        <svg viewBox="0 0 24 24"><path d="M3 6h18M7 12h10M10 18h4"/></svg>ソート${nFilters ? `<span class="badge">${nFilters}</span>` : ''}</button>
    </div>`;
  // 検索欄は描き直さず、下の結果だけを更新する（日本語入力が途切れないように）
  return `${toolbar}<div id="songResults">${songResultsHtml()}</div>`;
}

function songResultsHtml() {
  const v = state.songsView;
  const items = songListResult();
  const sortName = SORTS[v.sort][0].replace('（ジャンル）', '');
  const active = [];
  if (v.genre !== 'all') active.push(`<button class="achip" data-action="clearFilter" data-v="genre" style="--gc:${GENRE_COLOR[v.genre]}">${esc(v.genre)}<span>×</span></button>`);
  if (v.ver !== 'all') active.push(`<button class="achip" data-action="clearFilter" data-v="ver">${esc(versionName(v.ver))}<span>×</span></button>`);
  if (v.level) active.push(`<button class="achip" data-action="clearFilter" data-v="level">Lv ${esc(v.level)}<span>×</span></button>`);
  if (v.plate) active.push(`<button class="achip plate" data-action="clearFilter" data-v="plate">未達成：${PLATES[v.plate.id].name}${v.plate.diff ? `（${DIFF_LABEL[v.plate.diff]}）` : ''}<span>×</span></button>`);
  // レベル表示中は、さらに譜面定数で絞り込める
  let cstRow = '';
  if (v.level) {
    const charts = baseSongs({ skipCst: true }).flatMap((s) => s.charts.filter((c) => c.lv === v.level));
    const csts = [...new Set(charts.filter((c) => !c.est).map((c) => c.c.toFixed(1)))].sort((a, b) => b - a);
    const opts = [['all', 'すべて'], ...csts.map((c) => [c, c]), ...(charts.some((c) => c.est) ? [['est', '不明']] : [])];
    cstRow = `<div class="cst-bar"><span class="cst-label">定数</span><div class="chips-scroll">${opts.map(([c, l]) =>
      `<button class="fchip ${(v.cst || 'all') === c ? 'on' : ''}" data-action="listCst" data-v="${c}">${l}<small>${charts.filter((x) => cstMatch(x, c)).length}</small></button>`).join('')}</div></div>`;
  }
  const plateBtn = v.ver !== 'all'
    ? `<button class="btn block plate-btn" data-action="plate"><svg viewBox="0 0 24 24"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h6M7 14h10"/></svg>プレートを確認</button>` : '';
  const shown = items;
  let last = null;
  const rows = shown.map((s) => {
    const g = groupLabel(s);
    const head = g && g[0] !== last ? `<div class="list-head" ${g[1] ? `style="--gc:${g[1]}"` : ''}>${esc(g[0])}</div>` : '';
    if (g) last = g[0];
    return `${head}<button class="srow" data-action="song" data-id="${esc(s.id)}">
      ${jacket(s)}
      <div class="main"><div class="ttl">${esc(s.title)}</div>
        <div class="art">${esc(s.artist)}</div>
        <div class="sub">${songRowSub(s)}</div></div></button>`;
  }).join('');
  const diffNote = SORT_NEEDS_DIFF.includes(v.sort) && !v.level ? `（${DIFF_LABEL[v.sortDiff]}）` : '';
  return `${active.length ? `<div class="active-f">${active.join('')}</div>` : ''}${plateBtn}${cstRow}
    <div class="muted small count">${fmt(items.length)}曲 ・ ${esc(sortName)}${diffNote} ${esc(SORTS[v.sort][v.order === 'desc' ? 2 : 1])}</div>
    <div class="list">${rows || '<div class="empty small">該当する曲がありません</div>'}</div>`;
}

function keepSheetScroll(fn) {
  const wasOpen = !$('#sheetWrap').hidden;
  const top = $('#sheet').scrollTop;
  fn();
  if (wasOpen) $('#sheet').scrollTop = top;
}

// ソート（絞り込み）：ジャンル・バージョン・レベル（定数は一覧の画面で絞り込む）
function openSortSheet() {
  const v = state.songsView;
  state.sheetCtx = { type: 'sort' };
  const levels = [...new Set(state.index.songs.flatMap((s) => s.charts.map((c) => c.lv)))].sort((a, b) => levelNum(a) - levelNum(b));
  const mainLv = levels.filter((l) => levelNum(l) >= 12);
  const lowLv = levels.filter((l) => levelNum(l) < 12);
  const count = songListResult().length;
  const vps = state.index.vps; // 新しい順
  const verShown = v.showAllVer ? vps : vps.slice(0, 6);
  keepSheetScroll(() => openSheet(`<h3>ソート</h3>
    <div class="step">ジャンル</div>
    <div class="genre-grid">${[['all', 'すべて'], ...GENRES.map((g) => [g, g])].map(([g, l]) =>
      `<button class="fchip ${v.genre === g ? 'on' : ''}" data-action="songGenre" data-v="${esc(g)}" style="--gc:${GENRE_COLOR[g] || 'var(--accent)'}">${esc(l)}</button>`).join('')}</div>
    <div class="step">バージョン</div>
    <div class="genre-grid">${[['all', 'すべて'], ...verShown.map((vp) => [vp, versionName(vp)])].map(([vp, l]) =>
      `<button class="fchip ${v.ver === vp ? 'on' : ''}" data-action="songVer" data-v="${vp}">${esc(l)}</button>`).join('')}
      ${vps.length > 6 ? `<button class="fchip ghost" data-action="songAllVer">${v.showAllVer ? '古いバージョンを隠す' : `古いバージョン（${vps.length - 6}）`}</button>` : ''}</div>
    <div class="step">レベル</div>
    <div class="lv-grid">${(v.showLow ? [...lowLv, ...mainLv] : mainLv).map((l) =>
      `<button class="fchip lv ${v.level === l ? 'on' : ''}" data-action="songLevel" data-v="${esc(l)}">${esc(l)}</button>`).join('')}
      <button class="fchip lv ghost" data-action="songLow">${v.showLow ? 'その他を隠す' : 'その他'}</button></div>
    <div class="btn-row sort-foot">
      <button class="btn" data-action="sortClear">条件をクリア</button>
      <button class="btn primary" data-action="sortDone">${fmt(count)}曲を表示</button>
    </div>`));
}

// 並び替え
function openOrderSheet() {
  const v = state.songsView;
  state.sheetCtx = { type: 'order' };
  const needDiff = SORT_NEEDS_DIFF.includes(v.sort);
  keepSheetScroll(() => openSheet(`<h3>並び替え</h3>
    <div class="list sort-list">${Object.entries(SORTS).map(([k, [name]]) =>
      `<button class="opt ${v.sort === k ? 'on' : ''}" data-action="setSort" data-v="${k}"><span>${esc(name)}</span><span class="dot"></span></button>`).join('')}</div>
    <div class="step">順番</div>
    <div class="seg">${['asc', 'desc'].map((o, i) => `<button data-action="setOrder" data-v="${o}" class="${v.order === o ? 'on' : ''}">${esc(SORTS[v.sort][i + 1])}</button>`).join('')}</div>
    ${needDiff ? (v.level
      ? `<p class="muted small" style="margin:12px 2px 0">ソートでレベル（Lv ${esc(v.level)}）を選んでいるので、その譜面で並べます。</p>`
      : `<div class="step">基準にする難易度</div>
        <div class="seg">${DIFFS.map((d) => `<button data-action="setSortDiff" data-v="${d}" class="d-${d} ${v.sortDiff === d ? 'on' : ''}">${DIFF_SHORT[d]}</button>`).join('')}</div>`) : ''}
    <button class="btn primary block" style="margin-top:16px" data-action="sortDone">この順番で表示</button>`));
}

// FC / FC+ / AP / AP+ の記録ボタン
// 「FC/APだけ記録」を押したときだけ出す。スコアの入力は不要
function lampButtons(key) {
  if (!state.lampOpen.has(key)) return '';
  const c = lampOf(key), y = syncOf(key), r = lampRec(key);
  const btn = (g, v, on, label = LAMP_LABEL[v], dis = false) =>
    `<button class="lamp l-${v} ${on ? 'on' : ''}" data-action="lamp" data-key="${esc(key)}" data-g="${g}" data-v="${v}" ${dis ? 'disabled' : ''}>${label}</button>`;
  const byScore = sssByScore(key);
  return `<div class="lamp-panel">
    <div class="lp-label">コンボ</div>
    <div class="lamps">${['fc', 'fcp', 'ap', 'app'].map((l) => btn('c', l, c === l)).join('')}</div>
    <div class="lp-label">ランク・シンク</div>
    <div class="lamps">${btn('s', 'sss', r.s || byScore, 'SSS', byScore)}${['fdx', 'fdxp'].map((l) => btn('y', l, y === l)).join('')}<span></span></div>
    ${byScore ? '<div class="lp-note">SSSはスコアの記録で達成済みです</div>' : ''}
    ${Object.keys(r).length ? `<button class="lamp-clear" data-action="lampClear" data-key="${esc(key)}">この譜面の記録を消す</button>` : ''}</div>`;
}
function lampToggleBtn(key) {
  const open = state.lampOpen.has(key);
  return `<button class="lamp-toggle ${open ? 'open' : ''}" data-action="lampToggle" data-key="${esc(key)}">${open ? '閉じる' : 'FC/APだけ記録'}</button>`;
}

function openSong(id) {
  const s = state.index.byId.get(id);
  if (!s) return;
  state.sheetCtx = { type: 'song', id };
  const groups = ['dx', 'std'].map((t) => {
    const cs = s.charts.filter((c) => c.type === t);
    if (!cs.length) return '';
    const later = cs[0].vp !== s.vp ? cs[0].vp : null; // 後から追加された譜面種別
    return `<div class="sec-head"><h2>${t === 'dx' ? 'でらっくす譜面' : 'スタンダード譜面'}</h2>
      ${later ? `<span class="meta">${esc(versionName(later))} で追加${newVps().includes(later) ? '・新曲枠' : ''}</span>` : ''}</div>
      <div class="list">${cs.map((c) => {
        const key = chartKey(s.id, c.type, c.diff);
        const b = bestOf(key);
        return `<div class="cblock d-${c.diff}">
          <div class="chead"><span class="chip diff d-${c.diff}">${DIFF_LABEL[c.diff]} ${esc(c.lv)}</span>${lampChips(key)}${lampToggleBtn(key)}</div>
          <button class="cmain" data-action="chart" data-key="${esc(key)}">
            <div class="main">
              <div class="cinfo">定数 <b class="${c.est ? 'est' : ''}">${constText(key, c)}</b></div>
              <div class="cinfo">${b ? `<b>${fmtAch(b.ach)}</b> <span class="rank">${rankOf(b.ach)}</span>` : '<span class="muted">未プレイ</span>'}</div></div>
            <div class="rt">${b ? songRating(c.c, b.ach) : ''}<small>${b ? '単曲レート' : ''}</small></div>
          </button>
          ${lampButtons(key)}
        </div>`;
      }).join('')}</div>`;
  }).join('');
  keepSheetScroll(() => openSheet(`<div class="song-head">${jacket(s, 'l')}
      <div class="main"><h3>${esc(s.title)}</h3><div class="muted small">${esc(s.artist)}</div>
      <div class="muted small">${esc(s.cat)} ・ ${esc(versionName(s.vp))}</div></div></div>
    ${groups}`));
}

function openChart(key) {
  state.sheetCtx = { type: 'chart', key };
  const f = state.index.chart(key);
  const plays = state.plays.filter((p) => p.chartKey === key).sort((a, b) => b.ach - a.ach || b.playedAt - a.playedAt);
  if (!f) {
    openSheet(`<h3>${esc(plays[0]?.title || '不明な曲')}</h3><p class="muted">この譜面は現在の曲データに見つかりません（削除曲など）。</p>`);
    return;
  }
  const { song, chart } = f;
  const best = plays[0];
  const targets = nextTargets(chart.c, best ? best.ach : 0);
  const isNew = newVps().includes(chart.vp);
  const list = isNew ? state.best.newList : state.best.oldList;
  const full = list.length >= (isNew ? 15 : 35);
  const border = full ? list[list.length - 1].rating : 0;
  const curR = best ? songRating(chart.c, best.ach) : 0;
  const inFrame = list.some((e) => e.chartKey === key);
  openSheet(`
    <h3>${esc(song.title)}</h3>
    <div class="muted small">${esc(song.artist)} ・ ${esc(versionName(song.vp))}${chart.vp !== song.vp ? `（この譜面は ${esc(versionName(chart.vp))} で追加）` : ''}・${isNew ? '新曲枠' : '旧曲枠'}</div>
    <div style="margin:10px 0" class="sub"><span class="chip ${chart.type}">${TYPE_LABEL[chart.type]}</span>
      <span class="chip diff d-${chart.diff}">${DIFF_LABEL[chart.diff]} ${esc(chart.lv)}</span>${lampChips(key)}
      <span>譜面定数 <b>${constText(key, chart)}</b>${chart.est ? '（推定）' : ''}</span>${lampToggleBtn(key)}</div>
    ${lampButtons(key)}
    <div class="card">
      <dl class="kv"><dt>自己ベスト</dt><dd><b>${best ? fmtAch(best.ach) : '-'}</b> ${best ? rankOf(best.ach) : ''}</dd>
      <dt>単曲レート</dt><dd><b>${curR}</b></dd>
      <dt>${isNew ? '新曲' : '旧曲'}枠のボーダー</dt><dd>${border || '（枠に空きあり）'}</dd></dl>
    </div>
    ${targets.length ? `<div class="card"><h2>目標</h2><table class="targets"><tr><th>ランク</th><th>達成率</th><th>単曲</th><th>増加</th></tr>
      ${targets.map((t) => {
        const gain = inFrame ? t.rating - curR : full ? t.rating - border : t.rating;
        return `<tr><td>${t.rank}</td><td>${t.ach.toFixed(4)}%</td><td>${t.rating}</td><td>${gain > 0 ? `<span class="gain">+${gain}</span>` : '<span class="muted">枠外</span>'}</td></tr>`;
      }).join('')}</table><p class="muted small" style="margin:6px 0 0">「増加」は合計レートの増え方の目安です</p></div>` : ''}
    <div class="sec-head"><h2>この譜面の記録</h2><span class="meta">${plays.length}件</span></div>
    <div class="list">${plays.map((p) => `<div class="row d-${p.diff}" style="grid-template-columns:1fr auto">
      <div class="main"><div class="ttl num">${fmtAch(p.ach)} <span class="rank">${rankOf(p.ach)}</span></div>
      <div class="sub">${fmtDateTime(p.playedAt)}${p.dx ? ` ・ DX ${p.dx}${p.dxMax ? '/' + p.dxMax : ''}` : ''}${p.fc ? ` ・ ${{ fc: 'FC', fcp: 'FC+', ap: 'AP', app: 'AP+' }[p.fc]}` : ''}</div></div>
      <div class="btn-row"><button class="btn" style="min-height:36px;padding:4px 10px" data-action="editPlay" data-id="${p.id}">編集</button>
      <button class="btn danger" style="min-height:36px;padding:4px 10px" data-action="delPlay" data-id="${p.id}">削除</button></div></div>`).join('') || '<div class="empty small">記録なし</div>'}</div>
    <button class="btn primary block" style="margin-top:12px" data-action="addForChart" data-key="${esc(key)}">この譜面の記録を追加</button>
  `);
}

// ---- 設定 ----

function renderSettings() {
  const m = state.songsMeta;
  const idx = state.index;
  const vps = idx ? idx.vps.slice(0, 4) : [];
  const auto = !state.settings.newVps || !state.settings.newVps.length;
  return `<div class="card"><h2>曲データ</h2>
      <dl class="kv"><dt>収録曲数</dt><dd>${m ? fmt(m.count) + '曲' : '-'}</dd>
      <dt>現行バージョン</dt><dd>${idx ? esc(versionName(idx.currentVp)) : '-'}</dd>
      <dt>取得元</dt><dd>${m ? (m.source === 'bundled' ? `アプリ同梱（${fmtDate(m.dataDate)}時点）` : 'otoge-db（最新）') : '-'}</dd>
      <dt>最終確認</dt><dd>${m ? fmtDateTime(m.fetchedAt) : '-'}</dd></dl>
      <button class="btn block" style="margin-top:10px" data-action="fetchSongs" ${state.loadingSongs ? 'disabled' : ''}>${state.loadingSongs ? '更新中…' : '今すぐ更新'}</button>
      <p class="muted small" style="margin:8px 0 0">譜面定数は有志データベース「otoge-db」のデータを使っています。1日1回自動で確認します。</p>
    </div>
    <div class="card"><h2>新曲枠に入れるバージョン</h2>
      <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="newAuto" ${auto ? 'checked' : ''}> 自動（現行バージョンのみ）</label>
      <div id="newVpBox" style="margin-top:8px;${auto ? 'opacity:.4;pointer-events:none' : ''}">
        ${vps.map((v) => `<label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="checkbox" data-newvp="${v}" ${newVps().includes(v) ? 'checked' : ''}> ${esc(versionName(v))}</label>`).join('')}
      </div>
      <p class="muted small" style="margin:6px 0 0">公式のルール変更があったときだけ変えてください。</p>
    </div>
    <div class="card"><h2>写真の読み取り方式</h2>
      <label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="radio" name="ocrMode" value="auto" ${state.settings.ocrMode !== 'legacy' ? 'checked' : ''}> 項目ごとに読む（おすすめ）</label>
      <label style="display:flex;gap:8px;align-items:center;padding:4px 0"><input type="radio" name="ocrMode" value="legacy" ${state.settings.ocrMode === 'legacy' ? 'checked' : ''}> 画面全体の文字を読む（従来）</label>
      <p class="muted small" style="margin:6px 0 0">リザルト画面の位置と色で項目ごとに読みます。画面が見つからない写真は自動で従来の方式に切り替わります。新バージョンで画面のデザインが変わり読めなくなったときは「従来」を選んでください。</p>
    </div>
    <div class="card"><h2>データの保護</h2>
      <dl class="kv"><dt>記録件数</dt><dd>${fmt(state.plays.length)}件</dd>
      <dt>消去防止</dt><dd>${state.persisted === true ? '<span style="color:var(--ok)">有効</span>' : state.persisted === false ? '<span style="color:var(--warn)">未設定</span>' : '非対応'}</dd>
      <dt>最終バックアップ</dt><dd>${state.lastBackup ? fmtDateTime(state.lastBackup) : 'なし'}</dd></dl>
      ${state.persisted === false ? `<button class="btn block" style="margin-top:10px" data-action="persist">消去防止をリクエスト</button>
        <p class="muted small" style="margin:6px 0 0">ホーム画面に追加すると有効になりやすくなります。</p>` : ''}
      <div class="btn-row" style="margin-top:10px">
        <button class="btn" data-action="backupShare">共有して保存</button>
        <button class="btn" data-action="backupDownload">ファイルに保存</button>
      </div>
      <button class="btn block" style="margin-top:8px" data-action="importPick">バックアップから復元</button>
      <p class="muted small" style="margin:8px 0 0">「共有して保存」から Google ドライブを選ぶと、スマホが壊れても記録を戻せます。</p>
    </div>
    <div class="card"><h2>その他</h2>
      <button class="btn danger block" data-action="wipe">すべての記録を削除</button>
      <p class="muted small" style="margin:8px 0 0">maimaiレート計算 v${APP_VERSION} ・ 計算方式：旧曲ベスト35＋新曲ベスト15、単曲＝定数×係数×達成率（100.5%上限）。OCR：Tesseract.js</p>
    </div>`;
}

// ---- バックアップ ----

async function backupFile() {
  const data = {
    app: 'rate-note', format: 1, exportedAt: new Date().toISOString(),
    plays: state.plays, snapshots: state.snapshots, settings: state.settings, lamps: state.lamps,
  };
  const d = new Date();
  const name = `maimai-rate-backup-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  return new File([JSON.stringify(data)], name, { type: 'application/json' });
}

async function markBackup() {
  state.lastBackup = Date.now();
  await db.kvSet('lastBackup', state.lastBackup);
  render();
}

async function backupDownload() {
  const file = await backupFile();
  // 試作版（claude.ai 上）では、claude.ai の保存機能を使う
  let dl = null;
  try { dl = window.claude?.use ? await window.claude.use('downloads') : null; } catch { dl = null; }
  if (dl) {
    try {
      await dl.save({ filename: file.name, data: file });
      toast('保存しました');
      await markBackup();
    } catch (e) {
      if (e?.code !== 'declined') toast(`保存できませんでした（${e?.code || e?.message || e}）`);
    }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('ダウンロードフォルダに保存しました');
  await markBackup();
}

async function backupShare() {
  const file = await backupFile();
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'maimaiレート計算 バックアップ' });
      await markBackup();
    } catch (e) {
      if (e.name !== 'AbortError') toast('共有できませんでした。「ファイルに保存」を使ってください');
    }
  } else {
    await backupDownload();
  }
}

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'rate-note' || !Array.isArray(data.plays)) throw new Error('maimaiレート計算のバックアップではありません');
    const sig = (p) => `${p.chartKey}|${p.ach}`; // 同じ譜面・同じ達成率は同じ記録とみなす
    const have = new Set(state.plays.map(sig));
    const add = data.plays.filter((p) => !have.has(sig(p))).map(({ id, ...rest }) => rest);
    for (const p of add) await db.put('plays', p);
    for (const [k, v] of Object.entries(data.lamps || {})) mergeLamp(k, v);
    for (const p of add) raiseLamp(p.chartKey, p.fc);
    await db.kvSet('lamps', state.lamps);
    const snaps = (data.snapshots || []).filter((s) => {
      const mine = state.snapshots.find((x) => x.vp === s.vp);
      return !mine || (s.updatedAt || 0) > (mine.updatedAt || 0);
    });
    if (snaps.length) await db.bulkPut('snapshots', snaps);
    state.plays = await db.getAll('plays');
    state.snapshots = await db.getAll('snapshots');
    await recompute();
    toast(snaps.length ? `記録${add.length}件・バージョンのベ枠${snaps.length}件を読み込みました` : `${add.length}件の記録を読み込みました`);
    render();
  } catch (e) {
    toast(`復元できませんでした：${e.message}`, 4000);
  }
}

// ---------------- シート ----------------

function openSheet(html) {
  $('#sheet').innerHTML = `<div class="grab"></div>${html}`;
  $('#toast').hidden = true;
  const wrap = $('#sheetWrap');
  if (wrap.hidden) state.lampOpen.clear();
  if (wrap.hidden) { try { history.pushState({ sheet: true }, ''); } catch { /* 戻るボタン連動なしで続行 */ } }
  wrap.hidden = false;
  $('#sheet').scrollTop = 0;
}
// 確認ダイアログ（ブラウザ標準の confirm は使わない）
function askConfirm(messageHtml, okLabel = 'OK') {
  return new Promise((resolve) => {
    openSheet(`<p style="font-size:15px;margin:8px 0 16px">${messageHtml}</p>
      <div class="btn-row"><button class="btn" id="cfNo">キャンセル</button>
      <button class="btn primary danger-fill" id="cfYes">${esc(okLabel)}</button></div>`);
    // シートは閉じずに結果だけ返す（呼び出し側が次の表示を決める）
    const done = (v) => resolve(v);
    $('#cfYes').addEventListener('click', () => done(true), { once: true });
    $('#cfNo').addEventListener('click', () => done(false), { once: true });
    $('.sheet-bg').addEventListener('click', () => resolve(false), { once: true });
  });
}

function closeSheet(fromPop = false) {
  const wrap = $('#sheetWrap');
  if (wrap.hidden) return;
  wrap.hidden = true;
  if (!fromPop && history.state?.sheet) history.back();
}
window.addEventListener('popstate', () => closeSheet(true));

// ---------------- イベント ----------------

document.addEventListener('click', async (ev) => {
  const tabBtn = ev.target.closest('[data-tab]');
  if (tabBtn) {
    state.tab = tabBtn.dataset.tab;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const go = ev.target.closest('[data-tab-go]');
  if (go) { state.tab = go.dataset.tabGo; render(); return; }
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  const f = state.form;
  switch (a) {
    case 'closeSheet': closeSheet(); break;
    case 'fetchSongs': fetchSongs(); break;
    case 'pickCamera': $('#fileCamera').click(); break;
    case 'pickGallery': $('#fileGallery').click(); break;
    case 'manual': state.queue = []; state.form = newForm(); render(); break;
    case 'zoom': el.classList.toggle('zoom'); break;
    case 'pickSong': {
      const song = state.index.byId.get(el.dataset.id);
      f.songId = song.id;
      f.need.song = false;
      f.searchQ = '';
      const g = guessChart(song, { diff: f.diff, dxMax: f.dxMax });
      f.type = g.type || (song.charts.some((c) => c.type === f.type) ? f.type : null);
      if (f.diff && f.type && !song.charts.some((c) => c.type === f.type && c.diff === f.diff)) f.diff = null;
      render();
      break;
    }
    case 'setType': f.type = el.dataset.v; f.need.type = false; render(); break;
    case 'setDiff': f.diff = el.dataset.v; f.need.diff = false; render(); break;
    case 'saveForm': await saveForm(); break;
    case 'cancelForm': endQueue(); if (f?.id) state.tab = state.returnTab || 'history'; render(); break;
    case 'qSkip':
      if (state.qi < state.queue.length - 1) { state.qi++; await processCurrent(); } else { endQueue(); render(); }
      break;
    case 'chart': openChart(el.dataset.key); break;
    case 'versions': openVersionList(); break;
    case 'pickVersion':
      state.bestVp = el.dataset.vp === state.index.currentVp ? null : el.dataset.vp;
      closeSheet(); render(); window.scrollTo(0, 0); break;
    case 'bestCurrent': state.bestVp = null; render(); window.scrollTo(0, 0); break;
    case 'song': openSong(el.dataset.id); break;
    case 'songSort': openSortSheet(); break;
    case 'songOrder': openOrderSheet(); break;
    case 'songGenre': state.songsView.genre = el.dataset.v; afterFilter(); break;
    case 'songVer': state.songsView.ver = el.dataset.v; state.songsView.plate = null; afterFilter(); break;
    case 'songAllVer': state.songsView.showAllVer = !state.songsView.showAllVer; openSortSheet(); break;
    case 'songLevel': {
      const sv = state.songsView;
      sv.level = sv.level === el.dataset.v ? null : el.dataset.v; // もう一度押すと解除
      sv.cst = null;
      afterFilter();
      break;
    }
    case 'songCst': state.songsView.cst = el.dataset.v; afterFilter(); break;
    case 'songLow': state.songsView.showLow = !state.songsView.showLow; openSortSheet(); break;
    case 'sortClear': Object.assign(state.songsView, { genre: 'all', ver: 'all', level: null, cst: null, plate: null }); afterFilter(); break;
    case 'sortDone': closeSheet(); window.scrollTo(0, 0); break;
    case 'setSort': {
      const sv = state.songsView;
      if (sv.sort !== el.dataset.v) { sv.sort = el.dataset.v; sv.order = ['version', 'level', 'score', 'lamp'].includes(sv.sort) ? 'desc' : 'asc'; }
      afterFilter(openOrderSheet);
      break;
    }
    case 'setOrder': state.songsView.order = el.dataset.v; afterFilter(openOrderSheet); break;
    case 'setSortDiff': state.songsView.sortDiff = el.dataset.v; afterFilter(openOrderSheet); break;
    case 'lampToggle': {
      const key = el.dataset.key;
      if (state.lampOpen.has(key)) state.lampOpen.delete(key); else state.lampOpen.add(key);
      const ctx = state.sheetCtx;
      if (ctx?.type === 'song') openSong(ctx.id); else if (ctx?.type === 'chart') keepSheetScroll(() => openChart(ctx.key));
      break;
    }
    case 'lamp': {
      const key = el.dataset.key, g = el.dataset.g, val = el.dataset.v;
      let msg;
      if (g === 'c') { const on = lampOf(key) === val; setLamp(key, { c: on ? '' : val }); msg = on ? `${LAMP_LABEL[val]} を外しました` : `${LAMP_LABEL[val]} を記録しました`; }
      if (g === 'y') { const on = syncOf(key) === val; setLamp(key, { y: on ? '' : val }); msg = on ? `${LAMP_LABEL[val]} を外しました` : `${LAMP_LABEL[val]} を記録しました`; }
      if (g === 's') { const on = !!lampRec(key).s; setLamp(key, { s: !on }); msg = on ? 'SSS を外しました' : 'SSS を記録しました'; }
      await db.kvSet('lamps', state.lamps);
      reopenAfterLamp();
      toast(msg);
      break;
    }
    case 'lampClear': {
      delete state.lamps[el.dataset.key];
      await db.kvSet('lamps', state.lamps);
      state.lampOpen.delete(el.dataset.key);
      reopenAfterLamp();
      toast('この譜面の記録を消しました');
      break;
    }
    case 'plate': openPlateSheet(); break;
    case 'plateSel': state.plateSel = el.dataset.v; openPlateSheet(); break;
    case 'plateShow': {
      Object.assign(state.songsView, { plate: { id: state.plateSel, diff: el.dataset.d || null }, genre: 'all', level: null, cst: null });
      closeSheet(); render(); window.scrollTo(0, 0);
      break;
    }
    case 'listCst': state.songsView.cst = el.dataset.v; render(); break;
    case 'clearFilter': {
      const sv = state.songsView;
      if (el.dataset.v === 'genre') sv.genre = 'all';
      if (el.dataset.v === 'ver') { sv.ver = 'all'; sv.plate = null; }
      if (el.dataset.v === 'plate') sv.plate = null;
      if (el.dataset.v === 'level') { sv.level = null; sv.cst = null; }
      if (el.dataset.v === 'cst') sv.cst = null;
      sv.limit = 60;
      render();
      break;
    }
    case 'editPlay': {
      const p = state.plays.find((x) => x.id === Number(el.dataset.id));
      if (!p) break;
      closeSheet();
      state.returnTab = state.tab;
      state.queue = [];
      state.form = newForm({ id: p.id, songId: p.songId, type: p.type, diff: p.diff, ach: p.ach.toFixed(4), dx: p.dx ?? '', dxMax: p.dxMax, fc: p.fc || '', playedAt: p.playedAt, src: p.src || 'manual' });
      state.tab = 'add';
      render();
      break;
    }
    case 'delPlay': {
      const id = Number(el.dataset.id);
      const p = state.plays.find((x) => x.id === id);
      if (!p) break;
      if (!(await askConfirm(`${esc(p.title)}<br>${fmtAch(p.ach)}（${fmtDateTime(p.playedAt)}）の記録を削除しますか？`, '削除する'))) {
        if (!$('#sheetWrap').hidden) openChart(p.chartKey);
        break;
      }
      await db.del('plays', id);
      state.plays = state.plays.filter((x) => x.id !== id);
      await recompute();
      render();
      if (state.plays.some((x) => x.chartKey === p.chartKey)) openChart(p.chartKey); else closeSheet();
      toast('削除しました');
      break;
    }
    case 'addForChart': {
      const [songId, type, diff] = [el.dataset.key.split('|').slice(0, -2).join('|'), ...el.dataset.key.split('|').slice(-2)];
      closeSheet();
      state.queue = [];
      state.form = newForm({ songId, type, diff });
      state.tab = 'add';
      render();
      break;
    }
    case 'persist':
      state.persisted = await db.requestPersist();
      toast(state.persisted ? '消去防止を有効にしました' : 'ブラウザに許可されませんでした。ホーム画面に追加してから再度お試しください', 4000);
      render();
      break;
    case 'backupShare': await backupShare(); break;
    case 'backupDownload': await backupDownload(); break;
    case 'importPick': $('#fileImport').click(); break;
    case 'wipe':
      if (!(await askConfirm('すべての記録とバージョン別のベ枠を削除します。元に戻せません。', 'すべて削除する'))) { closeSheet(); break; }
      closeSheet();
      await db.clear('plays');
      await db.clear('snapshots');
      state.plays = [];
      state.snapshots = [];
      await recompute();
      render();
      toast('削除しました');
      break;
  }
});

// ジャケット画像が読めないときは代わりの表示（頭文字）にする
document.addEventListener('error', (ev) => {
  if (ev.target?.classList?.contains('jk')) ev.target.remove();
}, true);

// 楽曲リストの検索：入力中（変換中）は待ち、確定してから結果だけを更新
let searchTimer = null;
function updateSongSearch(value) {
  state.songsView.q = value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const box = $('#songResults');
    if (box) box.innerHTML = songResultsHtml();
  }, 150);
}
document.addEventListener('input', (ev) => {
  if (ev.target.id === 'songListSearch' && !ev.isComposing) updateSongSearch(ev.target.value);
});
document.addEventListener('compositionend', (ev) => {
  if (ev.target.id === 'songListSearch') updateSongSearch(ev.target.value);
});

document.addEventListener('change', async (ev) => {
  const t = ev.target;
  if (t.id === 'fileCamera' || t.id === 'fileGallery') {
    const files = [...t.files];
    t.value = '';
    await startQueue(files);
  } else if (t.id === 'fileImport') {
    const file = t.files[0];
    t.value = '';
    if (file) await importBackup(file);
  } else if (t.id === 'newAuto') {
    state.settings.newVps = t.checked ? null : [state.index.currentVp];
    await db.kvSet('settings', state.settings);
    await recompute();
    render();
  } else if (t.name === 'ocrMode') {
    state.settings.ocrMode = t.value;
    await db.kvSet('settings', state.settings);
    toast(t.value === 'legacy' ? '従来の方式で読み取ります' : '項目ごとに読む方式にしました');
  } else if (t.dataset.newvp) {
    const set = new Set(newVps());
    if (t.checked) set.add(t.dataset.newvp); else set.delete(t.dataset.newvp);
    state.settings.newVps = [...set];
    await db.kvSet('settings', state.settings);
    await recompute();
    render();
  }
});

// ---------------- 起動 ----------------

(async function init() {
  // 試作版（claude.ai 上）ではオフライン機能を使わない。manifest がある完成版のみ登録
  if ('serviceWorker' in navigator && location.protocol === 'https:' && document.querySelector('link[rel="manifest"]')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  try {
    await loadAll();
  } catch (e) {
    console.error(e);
    toast('データを読み込めませんでした');
  }
  await recompute();
  render();
  const oldSchema = state.songsMeta && state.songsMeta.schema !== SONG_SCHEMA;
  const stale = !state.songsMeta || Date.now() - state.songsMeta.fetchedAt > SONG_REFRESH_MS;
  if (!state.index || oldSchema) await fetchSongs({ silent: !!state.index });
  else if (stale && navigator.onLine) fetchSongs({ silent: true });
})();
