// API キーがなくても画面の確認ができるように、サンプルデータを作る。
// 本番の収集は scripts/collect.mjs（YouTube Data API v3）で行う。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, log } from "./lib/util.mjs";
import { buildKeywords, buildStats, buildDigest, buildLongRunners, buildLive, buildChurn, buildTimeMachine, buildMoves, accelOf } from "./lib/derive.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = await readJson(join(ROOT, "config.json"));

const TITLES = [
  "【検証】1週間○○だけで生活したらどうなるのか",
  "新曲「夜明けのサイン」Official Music Video",
  "神アプデ後の最強構成でランクマ登ってみた",
  "大食い企画、限界まで食べたら記録更新しました",
  "密着24時、朝5時起きの一日ルーティン",
  "話題のスポットに行ってみたら想像以上だった",
  "初心者でも分かる解説、5分でまるっと理解",
  "生配信アーカイブ：みんなで振り返り雑談",
  "まさかの結末、最後まで見てほしい",
  "プロが本気でやってみた結果がすごいことに",
  "新商品を全種類食べ比べしてランキングにした",
  "ドッキリ大成功、リアクションが良すぎた",
];
const CHANNELS = ["ウォッチャーTV", "まとめTV", "あさひの実験室", "ミュージックレーベル公式", "ゲーム部", "旅するカメラ", "くらし手帖", "スポーツダイジェスト", "ニュースライブ", "サイエンスラボ"];
const COLORS = ["#ff5252", "#4c6ef5", "#12b886", "#f59f00", "#ae3ec9", "#1098ad", "#e8590c", "#5c7cfa"];

const cats = config.categories.filter((c) => c.id !== "all" && c.kind !== "live").map((c) => c.id);
const videos = [];
const now = Date.now();

for (let i = 0; i < 120; i++) {
  const color = COLORS[i % COLORS.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="${color}" opacity=".2"/><circle cx="160" cy="90" r="34" fill="${color}" opacity=".55"/><path d="M150 74l28 16-28 16z" fill="#fff"/></svg>`;
  const views = 12000 + ((i * 7919) % 900) * 3300;
  const likes = Math.round(views * (0.005 + ((i * 13) % 60) / 1000));
  const ageH = 1 + ((i * 7) % 90);
  const cat = cats[i % cats.length];
  const isNew = i % 9 === 0;
  const isLive = i % 11 === 0;
  videos.push({
    id: `sample${String(i).padStart(3, "0")}`,
    rank: (i % 50) + 1,
    overallRank: i < 50 ? i + 1 : 0,
    title: `${TITLES[i % TITLES.length]}${i % 3 === 0 ? "" : " #" + (i + 1)}`,
    channelId: `ch${i % CHANNELS.length}`,
    channel: CHANNELS[i % CHANNELS.length],
    publishedAt: new Date(now - ageH * 3600000).toISOString(),
    categoryId: "",
    categories: [...(i < 50 ? ["all", cat] : [cat]), ...(isLive ? ["live"] : [])],
    isLive,
    isUpcoming: false,
    concurrentViewers: isLive ? 800 + ((i * 331) % 300) * 120 : 0,
    liveStartedAt: isLive ? new Date(now - (1 + (i % 5)) * 3600000).toISOString() : "",
    liveScheduledAt: "",
    thumb: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    channelThumb: "",
    views,
    likes,
    comments: Math.round(likes * (0.02 + ((i * 17) % 40) / 400)),
    durationSec: isLive ? 0 : i % 5 === 0 ? 45 : 300 + ((i * 37) % 1500),
    isShort: !isLive && i % 5 === 0,
    subscribers: 50000 + ((i * 991) % 400) * 7300,
    appearances: 1 + (i % 6),
    firstSeen: new Date(now - ageH * 3600000).toISOString(),
    viewsGained: isNew ? 0 : ((i * 977) % 400) * 180,
    viewsPerHour: ((i * 577) % 500) * 90 + 800,
    rankDelta: isNew ? 0 : ((i * 7) % 13) - 6,
    overallDelta: isNew || i >= 50 ? 0 : ((i * 5) % 11) - 5,
    isNew,
    likeRate: Math.round((likes / views) * 1000) / 10,
    // 1 時間あたりの伸びの推移（グラフ表示の確認用）
    spark: Array.from({ length: 12 }, (_, k) => Math.max(0, Math.round((((i * 37 + k * 53) % 100) / 100) * 40000 + 2000 - k * 400))),
  });
}
for (const v of videos) v.accel = v.isNew ? 0 : accelOf(v.spark, v.viewsPerHour);

const byChannel = new Map();
for (const v of videos) {
  const c = byChannel.get(v.channelId) || { id: v.channelId, title: v.channel, thumb: "", subscribers: v.subscribers, count: 0, views: 0, viewsPerHour: 0, topVideo: null };
  c.count++;
  c.views += v.views;
  c.viewsPerHour += v.viewsPerHour;
  if (!c.topVideo || v.views > c.topVideo.views) c.topVideo = { id: v.id, title: v.title, views: v.views, thumb: v.thumb };
  byChannel.set(v.channelId, c);
}
const channels = [...byChannel.values()]
  .sort((a, b) => b.count - a.count || b.views - a.views)
  .map((c, i) => ({ ...c, rank: i + 1 }));

const catCounts = config.categories
  .map((c) => ({ id: c.id, label: c.label, count: videos.filter((v) => v.categories.includes(c.id)).length }))
  .filter((c) => c.count > 0);

await writeJson(join(ROOT, "docs", "data", "rankings.json"), {
  updatedAt: new Date().toISOString(),
  previousAt: new Date(now - 6 * 3600000).toISOString(),
  site: config.site,
  isSample: true,
  total: videos.length,
  categories: catCounts,
  rankings: config.rankings,
  likeRateMinViews: config.likeRateMinViews ?? 10000,
  channels,
  keywords: buildKeywords(videos),
  stats: buildStats(videos),
  digest: buildDigest(videos, catCounts),
  longRunners: buildLongRunners(videos),
  live: buildLive(videos),
  moves: buildMoves(videos),
  chartChangedAt: new Date(now - 3 * 3600000).toISOString(),
  churn: buildChurn(videos, new Set(videos.slice(0, 104).map((v) => v.id)), new Date(now - 3600000).toISOString()),
  timeMachine: videos
    .slice(20, 30)
    .map((v, k) => ({ id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, rank: k + 1, views: Math.round(v.views * 0.82), at: new Date(now - 24 * 3600000).toISOString() })),
  nextUpdateAt: new Date(now + 3600000).toISOString(),
  videos,
});
log(`サンプルデータを書き出しました: 動画 ${videos.length} 件 / チャンネル ${channels.length} 件`);
