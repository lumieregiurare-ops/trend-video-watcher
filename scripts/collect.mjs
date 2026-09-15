// 急上昇ランキングを集めて docs/data/rankings.json を作る。
// 前回の集計結果を data/history.json に残しておき、再生数の伸びと順位の変動を出す。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, log } from "./lib/util.mjs";
import { buildKeywords, buildStats, buildDigest, buildLongRunners } from "./lib/derive.mjs";
import { fetchTrending, fetchChannels, apiKey } from "./lib/youtube.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "data", "rankings.json");
const HISTORY = join(ROOT, "data", "history.json");
const RUN = join(ROOT, "data", "last-run.json");

const started = Date.now();
const config = await readJson(join(ROOT, "config.json"));
const now = Date.now();
const nowIso = new Date(now).toISOString();

if (!apiKey()) {
  console.error("YOUTUBE_API_KEY が設定されていません。");
  console.error("Google Cloud でプロジェクトを作り、YouTube Data API v3 を有効化して API キーを発行し、");
  console.error("環境変数 YOUTUBE_API_KEY に設定してから実行してください。");
  console.error("（画面の確認だけなら node scripts/sample.mjs でサンプルデータを作れます）");
  process.exit(1);
}

setTimeout(() => {
  console.error("[watchdog] 15 分を超えたため中断します");
  process.exit(2);
}, 15 * 60 * 1000).unref();

// ---------- 1. カテゴリごとに急上昇を取得 ----------
const byVideo = new Map();
const perCategory = [];

for (const cat of config.categories) {
  let list = [];
  try {
    list = await fetchTrending({
      regionCode: config.regionCode || "JP",
      categoryId: cat.youtubeCategoryId,
      maxResults: config.maxResults || 50,
    });
  } catch (e) {
    // 急上昇に対応していないカテゴリは 400 が返るので、そこだけ飛ばして続ける
    log(`[${cat.label}] 取得できませんでした: ${e.message}`);
  }
  perCategory.push({ id: cat.id, label: cat.label, count: list.length });
  for (const v of list) {
    const prev = byVideo.get(v.id);
    if (prev) {
      // 複数カテゴリに出る動画は、順位の良いほうを残しつつ所属カテゴリを足す
      prev.categories.push(cat.id);
      if (cat.id !== "all" && v.rank < prev.rank) prev.rank = v.rank;
      if (cat.id === "all") prev.overallRank = v.rank;
      continue;
    }
    byVideo.set(v.id, {
      ...v,
      categories: [cat.id],
      overallRank: cat.id === "all" ? v.rank : 0,
    });
  }
  log(`[${cat.label}] ${list.length} 件`);
  await new Promise((r) => setTimeout(r, 120));
}

const videos = [...byVideo.values()];
log(`動画 ${videos.length} 件（重複を除いた実数）`);

// ---------- 2. 前回との差分から「伸び」と順位変動を出す ----------
const history = (await readJson(HISTORY, { videos: {}, ranAt: "" })) || { videos: {}, ranAt: "" };
const prevRanAt = history.ranAt ? new Date(history.ranAt).getTime() : 0;
const elapsedH = prevRanAt ? Math.max(0.25, (now - prevRanAt) / 3600000) : 0;

for (const v of videos) {
  const h = history.videos[v.id];
  v.appearances = (h?.appearances || 0) + 1;
  v.firstSeen = h?.firstSeen || nowIso;
  if (h && elapsedH) {
    v.viewsGained = Math.max(0, v.views - (h.views || 0));
    v.viewsPerHour = Math.round(v.viewsGained / elapsedH);
    v.rankDelta = h.rank ? h.rank - v.rank : 0;
    v.isNew = false;
  } else {
    // 初めて見る動画は伸びが計算できないので、公開からの平均で代用する
    const ageH = Math.max(1, (now - new Date(v.publishedAt).getTime()) / 3600000);
    v.viewsGained = 0;
    v.viewsPerHour = Math.round(v.views / ageH);
    v.rankDelta = 0;
    v.isNew = true;
  }
  v.likeRate = v.views > 0 ? Math.round((v.likes / v.views) * 1000) / 10 : 0;
}

// ---------- 3. チャンネル情報を足す ----------
const channelIds = [...new Set(videos.map((v) => v.channelId).filter(Boolean))];
const channelMap = await fetchChannels(channelIds);
for (const v of videos) {
  const c = channelMap.get(v.channelId);
  if (c) {
    v.channelThumb = c.thumb;
    v.subscribers = c.subscribers;
  }
}

// チャンネルごとのランクイン本数・合計再生数でランキングを作る
const byChannel = new Map();
for (const v of videos) {
  if (!v.channelId) continue;
  const c = byChannel.get(v.channelId) || {
    id: v.channelId,
    title: v.channel,
    thumb: v.channelThumb || "",
    subscribers: v.subscribers || 0,
    count: 0,
    views: 0,
    viewsPerHour: 0,
    topVideo: null,
  };
  c.count++;
  c.views += v.views;
  c.viewsPerHour += v.viewsPerHour;
  if (!c.topVideo || v.views > c.topVideo.views) c.topVideo = { id: v.id, title: v.title, views: v.views, thumb: v.thumb };
  byChannel.set(v.channelId, c);
}
const channels = [...byChannel.values()]
  .sort((a, b) => b.count - a.count || b.views - a.views)
  .slice(0, config.channelRankingSize || 20)
  .map((c, i) => ({ ...c, rank: i + 1 }));

// ---------- 4. 一覧の外に出す集計 ----------
videos.sort((a, b) => (a.overallRank || 999) - (b.overallRank || 999) || b.views - a.views);

const cats = perCategory.filter((c) => c.count > 0);
const keywords = buildKeywords(videos);
const stats = buildStats(videos, cats);
const digest = buildDigest(videos, cats);
const longRunners = buildLongRunners(videos);

// ---------- 5. 保存 ----------
await writeJson(OUT, {
  updatedAt: nowIso,
  previousAt: history.ranAt || "",
  site: config.site || {},
  total: videos.length,
  categories: cats,
  rankings: config.rankings,
  likeRateMinViews: config.likeRateMinViews ?? 10000,
  channels,
  keywords,
  stats,
  digest,
  longRunners,
  videos,
});

// 履歴は次回の差分計算のためだけに持つ。古いものは捨てる。
const keepAfter = now - (config.historyDays || 14) * 86400000;
const nextVideos = {};
for (const [id, h] of Object.entries(history.videos)) {
  if (new Date(h.seenAt || 0).getTime() > keepAfter) nextVideos[id] = h;
}
for (const v of videos) {
  nextVideos[v.id] = { views: v.views, rank: v.rank, appearances: v.appearances, firstSeen: v.firstSeen, seenAt: nowIso };
}
await writeJson(HISTORY, { ranAt: nowIso, videos: nextVideos });

const summary = {
  ranAt: nowIso,
  durationSec: Math.round((Date.now() - started) / 1000),
  videos: videos.length,
  channels: channels.length,
  withGrowth: videos.filter((v) => !v.isNew).length,
};
await writeJson(RUN, summary);
log(`done in ${summary.durationSec}s: 動画 ${summary.videos} 件 / チャンネル ${summary.channels} 件（伸びを計算できた動画 ${summary.withGrowth} 件）`);
