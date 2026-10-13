// API キーがなくても VTuber のページを確認できるように、サンプルデータを作る。
// 名簿（data/vtuber-roster.json）と、collect-vtuber.mjs が RSS で集めた新着のタイトルがあればそれを使い、
// 配信中・配信予定・同時視聴者数・登録者数などは架空の値で埋める（ページ上部に「サンプルデータです」と出る）。
// 本番の収集は scripts/collect-vtuber.mjs で行う。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readJson, log } from "./lib/util.mjs";
import { buildVtuberData, timelinePoint, updatePeaks, jstDay } from "./lib/vtuber.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = await readJson(join(ROOT, "config.json"));
const vt = config.vtuber || {};
const roster = await readJson(join(ROOT, "data", "vtuber-roster.json"), null);
if (!roster?.talents?.length) {
  console.error("名簿がありません。先に node scripts/sync-roster.mjs を実行してください。");
  process.exit(1);
}
const realState = (await readJson(join(ROOT, "data", "vtuber-state.json"), null)) || { videos: {} };
const rankings = await readJson(join(ROOT, "docs", "data", "rankings.json"), null);

const H = 3600000;
const DAY = 24 * H;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// 毎回同じ並びになるよう、乱数は種を固定する
let seed = 20261013;
const rnd = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a, b) => a + (b - a) * rnd();
const logBetween = (a, b) => Math.round(Math.exp(between(Math.log(a), Math.log(b))));
const sig3 = (n) => {
  const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(n)) - 2));
  return Math.round(n / p) * p;
};

const agencies = [...(vt.agencies || []).map(({ source, ...a }) => a), vt.other];
const chIds = [...new Set([...roster.talents.map((t) => t.id), ...(roster.officials || []).map((o) => o.id)])];

// ---------- チャンネル・登録者数 ----------
const state = { channels: {}, subs: {}, subDays: [], videos: {}, peaks: [], timeline: [], discovered: {} };
for (let d = 30; d >= 0; d--) state.subDays.push(jstDay(now - d * DAY));
for (const id of chIds) {
  const subs = logBetween(30000, 4000000);
  const perDay = subs * between(0.0002, 0.004);
  state.channels[id] = { t: realState.channels?.[id]?.t || "", th: "", s: sig3(subs), vc: Math.round(between(200, 3000)), v: subs * 400, h: "" };
  state.subs[id] = state.subDays.map((_, i) => sig3(Math.max(1000, subs - perDay * (30 - i))));
}
// 節目の表示を確認するため、何人かは大台の直前にしておく
for (const id of chIds.slice(3, 9)) {
  const target = [1e6, 5e5, 2e6, 3e5, 1e5, 1.5e6][chIds.indexOf(id) - 3];
  state.channels[id].s = sig3(target * 0.985);
  state.subs[id] = state.subDays.map((_, i) => sig3(target * (0.95 + 0.035 * (i / 30))));
}

// ---------- 動画 ----------
// RSS で集めた本物のタイトルを使う（なければ架空のタイトル）
const TITLES = [
  "【雑談】まったりおしゃべりしよ～【初見歓迎】",
  "【APEX】ランクマ行くぞ！【参加型ではありません】",
  "【歌枠】リクエストいっぱい歌う🎤【karaoke】",
  "【Minecraft】拠点づくりの続きをする",
  "【スト6】ランクマッチ修行",
  "【ASMR】耳かきとささやき雑談",
  "【朝活】おはよう！今日の予定を話す",
  "【#ホロ鯖ARK】まったりサバイバル",
  "【同時視聴】みんなで映画を見よう",
  "【3Dお披露目】ついに！【記念配信】",
];
const pool = Object.entries(realState.videos || {})
  .filter(([, v]) => chIds.includes(v.c) && v.t)
  .map(([id, v]) => ({ id, c: v.c, t: v.t, p: v.p }));
while (pool.length < 600) {
  const i = pool.length;
  pool.push({ id: `sample${String(i).padStart(4, "0")}`, c: chIds[i % chIds.length], t: TITLES[i % TITLES.length], p: iso(now - between(0, 40) * H) });
}

const usedLive = new Set();
pool.forEach((v, i) => {
  const kind = i % 10;
  if (kind <= 1 && !usedLive.has(v.c) && usedLive.size < 70) {
    usedLive.add(v.c);
    const s = now - between(0.1, 5) * H;
    const cv = logBetween(300, 60000);
    state.videos[v.id] = { c: v.c, t: v.t, p: iso(s - 2 * H), st: "live", s: iso(s), cv, pk: Math.round(cv * between(1, 1.4)), v: cv * 3, ck: iso(now) };
  } else if (kind <= 4) {
    state.videos[v.id] = { c: v.c, t: v.t, p: iso(now - between(1, 30) * H), st: "upcoming", sc: iso(now + between(0.2, 6.5 * 24) * H), ck: iso(now), pr: kind === 4 && i % 3 === 0 ? 1 : undefined };
  } else if (kind <= 8) {
    const e = now - between(0.3, 47) * H;
    const s = e - between(1, 4) * H;
    const pk = logBetween(200, 50000);
    state.videos[v.id] = { c: v.c, t: v.t, p: iso(s - H), st: "done", s: iso(s), e: iso(e), pk, v: pk * Math.round(between(4, 12)), d: Math.round((e - s) / 1000), ck: iso(now) };
  } else {
    const short = i % 3 === 0;
    state.videos[v.id] = { c: v.c, t: v.t, p: iso(now - between(0.5, 40) * H), st: "video", v: logBetween(2000, 400000), d: short ? 45 : Math.round(between(180, 900)), ck: iso(now) };
  }
});
state.peaks = updatePeaks([], state.videos, now);

// 同時視聴者数の推移（48 時間、30 分おき。夜に山が来るように）
const agencyOf = new Map(roster.talents.map((t) => [t.id, t.agency]));
for (let k = 95; k >= 0; k--) {
  const t = now - k * 30 * 60000;
  const hourJst = (new Date(t).getUTCHours() + 9) % 24;
  const wave = 0.35 + 0.65 * Math.max(0, Math.cos(((hourJst - 22) / 24) * 2 * Math.PI));
  const n = Math.round(15 + 70 * wave * between(0.85, 1.1));
  const fake = Array.from({ length: n }, (_, j) => ({ c: chIds[(j * 7 + k) % chIds.length], cv: logBetween(300, 30000) }));
  state.timeline.push(timelinePoint(iso(t), fake, (c) => agencyOf.get(c) || "other"));
}

// 個人勢の確認用に 1 件だけ
state.discovered.UCsampleIndie000000000001 = { t: "サンプル個人勢ch", seen: iso(now), hits: 3 };
state.channels.UCsampleIndie000000000001 = { t: "サンプル個人勢ch", th: "", s: 82000, vc: 300, v: 1e7 };
state.videos.sampleIndie01 = { c: "UCsampleIndie000000000001", t: "【新人VTuber】はじめまして！初配信です【個人勢】", p: iso(now - 2 * H), st: "live", s: iso(now - 0.5 * H), cv: 2400, pk: 2600, ck: iso(now) };

const data = buildVtuberData({
  now,
  site: config.site || {},
  agencies,
  roster,
  state,
  trending: rankings?.videos || [],
  isSample: true,
  upcomingDays: vt.upcomingDays ?? 7,
  previousAt: iso(now - 30 * 60000),
});

async function writeCompact(path, obj) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(obj), "utf8");
}
await writeCompact(join(ROOT, "docs", "data", "vtuber.json"), data);
const nameOf = new Map(data.channels.map((c) => [c.id, c]));
await writeCompact(join(ROOT, "docs", "data", "vtuber-top.json"), {
  updatedAt: data.updatedAt,
  isSample: true,
  live: data.summary.live,
  viewers: data.summary.viewers,
  upcoming24: data.summary.upcoming24,
  top: data.live.slice(0, 5).map((v) => ({ id: v.id, t: v.t, n: nameOf.get(v.c)?.n || "", a: nameOf.get(v.c)?.a || "", cv: v.cv })),
  agencies: data.agencies.map((a) => ({ id: a.id, label: a.label, color: a.color })),
});
log(`VTuber のサンプルデータを書き出しました: 配信中 ${data.live.length} / 予定 ${data.upcoming.length} / 新着 ${data.recent.length} / チャンネル ${data.channels.length}`);
