// VTuber の配信を集めて docs/data/vtuber.json を作る（急上昇の収集 collect.mjs のあとに走らせる）。
//
// 1. 名簿（data/vtuber-roster.json）が古ければ、各事務所の公式サイトから作り直す
// 2. 名簿のチャンネルの RSS を全部読む（API のユニットを使わない。直近 15 本と再生数が取れる）
// 3. 新しく見つけた動画と、配信中・配信予定の枠だけを videos.list で確かめる（50 本で 1 ユニット）
// 4. 急上昇の収集結果から、名簿にない VTuber の配信も拾う（個人勢・その他）
// 5. 登録者数は channels.list で 3 時間おきに取り直し、日本時間の日ごとに控えて伸びを出す
//
// 前回までの状態は data/vtuber-state.json に残す（配信の最大同時視聴者数・登録者数の推移など）。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readJson, writeJson, fetchText, pool, log } from "./lib/util.mjs";
import { apiKey, fetchVideosDetailed, fetchChannels, fetchUploads } from "./lib/youtube.mjs";
import { syncRoster } from "./lib/vtuber-roster.mjs";
import { parseYoutubeFeed, buildVtuberData, timelinePoint, updatePeaks, jstDay } from "./lib/vtuber.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROSTER = join(ROOT, "data", "vtuber-roster.json");
const STATE = join(ROOT, "data", "vtuber-state.json");
const OUT = join(ROOT, "docs", "data", "vtuber.json");
const TOP = join(ROOT, "docs", "data", "vtuber-top.json");
const RANKINGS = join(ROOT, "docs", "data", "rankings.json");

const H = 3600000;
const DAY = 24 * H;
const ts = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

const started = Date.now();
const config = await readJson(join(ROOT, "config.json"));
const vt = config.vtuber || {};
if (vt.enabled === false) {
  log("config.vtuber.enabled が false なので何もしません");
  process.exit(0);
}
const now = Date.now();
const nowIso = new Date(now).toISOString();
const hasKey = !!apiKey();
if (!hasKey) log("YOUTUBE_API_KEY がないので、RSS で分かる範囲（新着動画）だけを集めます。配信中・配信予定は前回のままです。");

setTimeout(() => {
  console.error("[watchdog] 12 分を超えたため中断します");
  process.exit(2);
}, 12 * 60 * 1000).unref();

async function writeCompact(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data), "utf8");
}

// ---------- 1. 名簿 ----------
let roster = await readJson(ROSTER, null);
const rosterAgeDays = roster?.syncedAt ? (now - ts(roster.syncedAt)) / DAY : Infinity;
if (!roster?.talents?.length || rosterAgeDays > (vt.rosterMaxAgeDays ?? 7)) {
  log(`名簿を作り直します（前回: ${roster?.syncedAt || "なし"}）`);
  try {
    roster = await syncRoster(config, roster);
    await writeJson(ROSTER, roster);
    log(`名簿: ${roster.talents.length} 人`);
  } catch (e) {
    log(`名簿を作り直せませんでした: ${e.message}`);
  }
}
if (!roster?.talents?.length) {
  console.error("名簿がありません。node scripts/sync-roster.mjs を実行してください。");
  process.exit(1);
}

const agencies = [...(vt.agencies || []).map(({ source, ...a }) => a), vt.other || { id: "other", label: "その他", color: "#4a3aa7" }];

// ---------- 2. 状態 ----------
const state = (await readJson(STATE, null)) || {};
for (const [k, v] of Object.entries({ videos: {}, known: {}, channels: {}, subs: {}, subDays: [], peaks: [], timeline: [], discovered: {}, runs: [] })) {
  if (!state[k]) state[k] = v;
}

const rosterIds = new Set([...roster.talents.map((t) => t.id), ...(roster.officials || []).map((o) => o.id)]);
const keywords = (vt.keywords || []).map((k) => k.normalize("NFKC").toLowerCase());
const excludes = (vt.excludeKeywords || []).map((k) => k.normalize("NFKC").toLowerCase());
const excluded = (text) => excludes.some((k) => (text || "").normalize("NFKC").toLowerCase().includes(k));
// 名簿にない VTuber（急上昇やライブ一覧で見つけたもの）は、最後に見かけてから一定期間だけ追いかける
for (const [id, d] of Object.entries(state.discovered)) {
  if (rosterIds.has(id) || excluded(d.t) || ts(d.seen) < now - (vt.discoverKeepDays ?? 14) * DAY) delete state.discovered[id];
}
const discoveredIds = Object.entries(state.discovered)
  .sort((a, b) => ts(b[1].seen) - ts(a[1].seen) || (b[1].hits || 0) - (a[1].hits || 0))
  .slice(0, vt.discoverMax ?? 120)
  .map(([id]) => id);
const pollIds = [...rosterIds, ...discoveredIds];

// ---------- 3. RSS ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchFeed(id) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
  for (let i = 0; ; i++) {
    try {
      return parseYoutubeFeed(await fetchText(url, { timeoutMs: 15000 }));
    } catch (e) {
      if (i >= 1) throw e;
      await sleep(1000);
    }
  }
}

const windowStart = now - (vt.checkWindowDays ?? 10) * DAY;
const fresh = new Set();
let feedOk = 0;
let apiUnits = 0;
const feeds = await pool(pollIds, vt.rssConcurrency ?? 8, fetchFeed);
const feedErrors = [];
feeds.forEach((feed, i) => {
  const chId = pollIds[i];
  if (!feed || feed.error) {
    feedErrors.push(chId);
    return;
  }
  feedOk++;
  if (feed.channelTitle) state.channels[chId] = { ...(state.channels[chId] || {}), t: state.channels[chId]?.t || feed.channelTitle };
  ingest(chId, feed.entries);
});
log(`RSS: ${feedOk}/${pollIds.length} チャンネル（新しく見つけた動画 ${fresh.size} 本）`);
if (feedErrors.length) log(`RSS を読めなかったチャンネル: ${feedErrors.length} 件`);

// RSS が読めなかったチャンネルは、API の uploads プレイリストで補う（1 チャンネル 1 ユニットなので本数を絞る）。
// 最近配信していたチャンネルを優先する
if (hasKey && feedErrors.length) {
  const recentAct = new Map();
  for (const v of Object.values(state.videos)) recentAct.set(v.c, Math.max(recentAct.get(v.c) || 0, ts(v.s) || ts(v.p)));
  const targets = [...feedErrors].sort((a, b) => (recentAct.get(b) || 0) - (recentAct.get(a) || 0)).slice(0, vt.rssFallbackMax ?? 60);
  let fixed = 0;
  for (const chId of targets) {
    try {
      ingest(chId, await fetchUploads(chId, 10));
      apiUnits++;
      fixed++;
    } catch (e) {
      log(`uploads プレイリストも読めませんでした（${chId}）: ${e.message}`);
      break;
    }
  }
  if (fixed) log(`RSS の代わりに API で ${fixed} チャンネルの新着を確かめました`);
}

function ingest(chId, entries) {
  for (const e of entries) {
    const rec = state.videos[e.id];
    if (rec) {
      if (e.title) rec.t = e.title;
      // 配信中・予約中の再生数は意味がないので、終わったもの・普通の動画だけ RSS の値で更新する
      if (e.views && rec.st !== "live" && rec.st !== "upcoming") rec.v = Math.max(rec.v || 0, e.views);
      continue;
    }
    if (state.known[e.id] || ts(e.publishedAt) < windowStart) continue;
    state.videos[e.id] = { c: e.channelId || chId, t: e.title, p: e.publishedAt, st: "", v: e.views };
    fresh.add(e.id);
  }
}

// ---------- 4. videos.list で配信の状態を確かめる ----------
// 確かめる間隔: 配信中は毎回。予約は開始が近いほど頻繁に。フリーチャットのような遠い予約は 1 日 1 回。
function checkPriority(v) {
  const age = now - ts(v.ck);
  if (v.st === "live") return 0;
  if (!v.st) return 2; // まだ一度も確かめていない
  if (v.st === "upcoming") {
    const until = ts(v.sc) - now;
    if (until < 3 * H) return 1;
    if (until < 2 * DAY) return age >= H ? 3 : -1;
    if (until < 30 * DAY) return age >= 6 * H ? 4 : -1;
    return age >= DAY ? 5 : -1;
  }
  return -1;
}

let checked = 0;
let removed = 0;
if (hasKey) {
  const queue = Object.entries(state.videos)
    .map(([id, v]) => [id, checkPriority(v), ts(v.p)])
    .filter(([, p]) => p >= 0)
    .sort((a, b) => a[1] - b[1] || b[2] - a[2])
    .slice(0, vt.maxCheckPerRun ?? 1500)
    .map(([id]) => id);
  for (let i = 0; i < queue.length; i += 50) {
    const chunk = queue.slice(i, i + 50);
    let details;
    try {
      details = await fetchVideosDetailed(chunk);
      apiUnits++;
    } catch (e) {
      // クォータ切れなど。残りは次回に回す
      log(`videos.list に失敗したので、残り ${queue.length - i} 本は次回に回します: ${e.message}`);
      break;
    }
    const got = new Map(details.map((d) => [d.id, d]));
    for (const id of chunk) {
      const rec = state.videos[id];
      const d = got.get(id);
      if (!d) {
        // 削除・非公開になった動画
        state.known[id] = Math.floor(ts(rec.p || nowIso) / DAY);
        delete state.videos[id];
        removed++;
        continue;
      }
      applyDetail(rec, d);
      checked++;
    }
  }
}

function applyDetail(rec, d) {
  rec.t = d.title || rec.t;
  rec.c = d.channelId || rec.c;
  rec.p = d.publishedAt || rec.p;
  rec.v = d.views;
  rec.d = d.durationSec;
  rec.ck = nowIso;
  if (d.isPremiere) rec.pr = 1;
  if (d.isLive) {
    rec.st = "live";
    rec.cv = d.concurrentViewers;
    rec.pk = Math.max(rec.pk || 0, d.concurrentViewers || 0);
    rec.s = d.liveStartedAt || rec.s || nowIso;
    if (d.liveScheduledAt) rec.sc = d.liveScheduledAt;
  } else if (d.isUpcoming) {
    rec.st = "upcoming";
    rec.sc = d.liveScheduledAt || rec.sc;
    delete rec.cv;
  } else if (d.hasLiveDetails) {
    rec.st = "done";
    rec.s = d.liveStartedAt || rec.s;
    rec.e = d.liveEndedAt || rec.e;
    delete rec.cv;
  } else {
    rec.st = "video";
  }
}

// ---------- 5. 急上昇の収集結果から拾う ----------
// rankings.json はこの直前に collect.mjs が書いたもの。古い（手元で動かしたときなど）ならライブの数字は使わない
const rankings = await readJson(RANKINGS, null);
const rankingsAge = rankings?.updatedAt ? now - ts(rankings.updatedAt) : Infinity;
const trending = rankingsAge < 3 * H ? rankings.videos || [] : [];
// 切り抜きチャンネルや VTuber を紹介するだけのチャンネルは、タイトルに「VTuber」と入っていても拾わない
const looksVtuber = (v) => {
  const text = `${v.title} ${v.channel}`.normalize("NFKC").toLowerCase();
  return keywords.some((k) => text.includes(k)) && !excludes.some((k) => text.includes(k));
};
let discoveredNow = 0;
for (const v of trending) {
  if (!v.channelId) continue;
  const known = rosterIds.has(v.channelId) || state.discovered[v.channelId];
  if (!known && !looksVtuber(v)) continue;
  if (!rosterIds.has(v.channelId)) {
    const d = state.discovered[v.channelId] || { t: v.channel, hits: 0 };
    if (!state.discovered[v.channelId]) discoveredNow++;
    d.t = v.channel;
    d.seen = nowIso;
    d.hits = (d.hits || 0) + 1;
    state.discovered[v.channelId] = d;
  }
  if (!v.isLive || rankingsAge > 40 * 60000) continue;
  const rec = state.videos[v.id] || (state.videos[v.id] = { c: v.channelId, t: v.title, p: v.publishedAt });
  if (rec.ck === nowIso) continue;
  // RSS の更新が遅れて見つけられなかった配信も、ここで配信中として拾える
  rec.st = "live";
  rec.t = v.title;
  rec.cv = v.concurrentViewers || 0;
  rec.pk = Math.max(rec.pk || 0, rec.cv);
  rec.s = v.liveStartedAt || rec.s || nowIso;
  rec.v = v.views;
  rec.ck = nowIso;
}
if (discoveredNow) log(`名簿にない VTuber のチャンネルを ${discoveredNow} 件見つけました`);

// API で確かめられないまま何時間もたった「配信中」は、終わったものとして扱う
for (const rec of Object.values(state.videos)) {
  if (rec.st === "live" && now - ts(rec.ck) > 6 * H) {
    rec.st = "done";
    rec.e = rec.e || rec.ck;
    delete rec.cv;
  }
}

// ---------- 6. 登録者数 ----------
function addDay(day) {
  return new Date(ts(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
}
function advanceDays(today) {
  const days = state.subDays;
  if (days.length && days[days.length - 1] < today && ts(today) - ts(days[days.length - 1]) > 40 * DAY) days.length = 0;
  if (!days.length) {
    days.push(today);
    for (const k of Object.keys(state.subs)) state.subs[k] = [null];
  }
  while (days[days.length - 1] < today) {
    days.push(addDay(days[days.length - 1]));
    for (const arr of Object.values(state.subs)) arr.push(null);
  }
  while (days.length > 35) {
    days.shift();
    for (const arr of Object.values(state.subs)) arr.shift();
  }
}

const statsDue = now - ts(state.channelsAt) >= (vt.channelStatsEveryMin ?? 180) * 60000 || pollIds.some((id) => state.channels[id]?.s === undefined);
if (hasKey && statsDue) {
  const map = await fetchChannels(pollIds);
  apiUnits += Math.ceil(pollIds.length / 50);
  advanceDays(jstDay(now));
  for (const [id, c] of map) {
    state.channels[id] = { t: c.title, th: c.thumb, s: c.subscribers, vc: c.videoCount, v: c.viewCount, h: c.handle };
    if (!state.subs[id]) state.subs[id] = new Array(state.subDays.length).fill(null);
    if (c.subscribers) state.subs[id][state.subDays.length - 1] = c.subscribers;
  }
  if (map.size) state.channelsAt = nowIso;
  log(`チャンネル情報: ${map.size}/${pollIds.length} 件`);
}

// ---------- 7. 推移・ピーク・掃除 ----------
const tracked = new Set(pollIds);
const agencyOf = new Map([...roster.talents, ...(roster.officials || [])].map((t) => [t.id, t.agency]));
const otherId = agencies[agencies.length - 1].id;
if (hasKey) {
  const liveNow = Object.values(state.videos).filter((v) => v.st === "live" && (tracked.has(v.c) || state.discovered[v.c]));
  state.timeline = [...state.timeline, timelinePoint(nowIso, liveNow, (c) => agencyOf.get(c) || otherId)].slice(-96);
}
state.peaks = updatePeaks(state.peaks, state.videos, now);

const keepFrom = now - (vt.keepDays ?? 3) * DAY;
for (const [id, v] of Object.entries(state.videos)) {
  const inScope = tracked.has(v.c) || state.discovered[v.c];
  const last = Math.max(ts(v.p), ts(v.s), ts(v.e));
  let drop = !inScope;
  if (v.st === "upcoming") drop ||= ts(v.sc) < now - 3 * DAY;
  else if (v.st !== "live") drop ||= last < keepFrom;
  if (!drop) continue;
  if (v.st) state.known[id] = Math.floor(ts(v.p || nowIso) / DAY);
  delete state.videos[id];
}
const knownFrom = Math.floor((now - ((vt.checkWindowDays ?? 10) + 2) * DAY) / DAY);
for (const [id, day] of Object.entries(state.known)) if (day < knownFrom) delete state.known[id];
for (const id of Object.keys(state.channels)) if (!tracked.has(id)) delete state.channels[id];
for (const id of Object.keys(state.subs)) if (!tracked.has(id)) delete state.subs[id];

// ---------- 8. 書き出し ----------
const data = buildVtuberData({
  now,
  site: config.site || {},
  agencies,
  roster,
  state,
  trending,
  upcomingDays: vt.upcomingDays ?? 7,
  previousAt: state.ranAt || "",
});
await writeCompact(OUT, data);

// 急上昇のページの横に出す小さな版（vtuber.json 全体を読ませないため）
const nameOf = new Map(data.channels.map((c) => [c.id, c]));
await writeCompact(TOP, {
  updatedAt: data.updatedAt,
  live: data.summary.live,
  viewers: data.summary.viewers,
  upcoming24: data.summary.upcoming24,
  top: data.live.slice(0, 5).map((v) => ({ id: v.id, t: v.t, n: nameOf.get(v.c)?.n || "", a: nameOf.get(v.c)?.a || "", cv: v.cv })),
  agencies: data.agencies.map((a) => ({ id: a.id, label: a.label, color: a.color })),
});

state.ranAt = nowIso;
state.runs = [...state.runs, nowIso].slice(-48);
await writeCompact(STATE, state);

log(
  `done in ${Math.round((Date.now() - started) / 1000)}s: 配信中 ${data.summary.live} 枠（${data.summary.viewers.toLocaleString()} 人）/ 予定 ${data.upcoming.length} 枠 / 新着 ${data.recent.length} 本 / ` +
    `確かめた動画 ${checked} 本（消えた ${removed} 本）/ API 約 ${apiUnits} ユニット / 追跡中 ${Object.keys(state.videos).length} 本`
);
