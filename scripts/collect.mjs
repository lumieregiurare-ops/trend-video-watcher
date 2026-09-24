// 急上昇ランキングを集めて docs/data/rankings.json を作る。
// 前回の集計結果を data/history.json に残しておき、再生数の伸びと順位の変動を出す。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readJson, writeJson, log } from "./lib/util.mjs";
import { buildKeywords, buildStats, buildDigest, buildLongRunners, buildLive, buildChurn, buildTimeMachine, buildMoves, accelOf } from "./lib/derive.mjs";
import { fetchTrending, fetchChannels, fetchLive, apiKey } from "./lib/youtube.mjs";

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
  // ライブのタブは急上昇ではなく検索から作るので、ここでは飛ばす
  if (cat.kind === "live") {
    perCategory.push({ id: cat.id, label: cat.label, count: 0 });
    continue;
  }
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

// ---------- 1.5 いま配信中のライブを足す ----------
const liveCat = config.categories.find((c) => c.kind === "live");
if (liveCat && config.live?.enabled !== false) {
  const jobs = [
    ...(config.live?.queries || [""]).map((query) => ({ query })),
    ...(config.live?.categoryIds || []).map((categoryId) => ({ categoryId })),
  ];
  let found = 0;
  for (const job of jobs) {
    let list = [];
    try {
      list = await fetchLive({ regionCode: config.regionCode || "JP", maxResults: config.live?.maxResults || 50, ...job });
    } catch (e) {
      log(`[ライブ] 取得できませんでした: ${e.message}`);
      continue;
    }
    for (const v of list) {
      const prev = byVideo.get(v.id);
      if (prev) {
        // 急上昇にも出ているライブは、そこでの順位を保ったままライブのタブにも載せる
        if (!prev.categories.includes(liveCat.id)) prev.categories.push(liveCat.id);
        prev.isLive = true;
        prev.concurrentViewers = v.concurrentViewers;
        prev.liveStartedAt = v.liveStartedAt;
        continue;
      }
      byVideo.set(v.id, { ...v, categories: [liveCat.id], overallRank: 0 });
      found++;
    }
  }
  const liveCount = [...byVideo.values()].filter((v) => v.categories.includes(liveCat.id)).length;
  const row = perCategory.find((c) => c.id === liveCat.id);
  if (row) row.count = liveCount;
  log(`[ライブ配信中] ${liveCount} 件（うち新規 ${found} 件）`);
}

const videos = [...byVideo.values()];
log(`動画 ${videos.length} 件（重複を除いた実数）`);

// ---------- 2. 履歴と突き合わせて、伸び・順位変動・推移グラフを作る ----------
// history.videos[id].samples は [{ t: 時刻, v: 再生数, r: 順位, o: 総合の順位（圏外は 0） }] の配列。
// 直近 SAMPLE_KEEP 回分を残し、推移グラフと「24 時間前のランキング」に使う。
const SAMPLE_KEEP = config.samplePoints ?? 24;
const SPARK_POINTS = config.sparkPoints ?? 12;

const history = (await readJson(HISTORY, { videos: {}, ranAt: "", runs: [] })) || { videos: {}, ranAt: "", runs: [] };
history.videos = history.videos || {};
const prevRanAt = history.ranAt ? new Date(history.ranAt).getTime() : 0;

// 直近の収集に出ていた動画（NEW の判定と入れ替わりの本数に使う）。
// 前回 1 回だけで見ると、そのときに取れなかったカテゴリの動画がまとめて NEW になるので、直近 3 回分を見る。
const recentRuns = new Set([...(history.runs || []), history.ranAt].filter(Boolean).slice(-3));
const prevIds = new Set(
  Object.entries(history.videos)
    .filter(([, h]) => h.samples?.some((s) => recentRuns.has(s.t)))
    .map(([id]) => id)
);

for (const v of videos) {
  const h = history.videos[v.id];
  const samples = (h?.samples || []).slice();
  v.appearances = (h?.appearances || 0) + 1;
  v.firstSeen = h?.firstSeen || nowIso;

  const last = samples[samples.length - 1];
  if (last) {
    const gapH = Math.max(0.25, (now - new Date(last.t).getTime()) / 3600000);
    v.viewsGained = Math.max(0, v.views - (last.v || 0));
    v.viewsPerHour = Math.round(v.viewsGained / gapH);
    v.rankDelta = last.r ? last.r - v.rank : 0;
    // 総合の順位はカテゴリ内の順位（rank）とは別に動くので、総合タブ用に分けて持つ
    v.overallDelta = last.o && v.overallRank ? last.o - v.overallRank : 0;
    v.isNew = !prevIds.has(v.id);
  } else {
    // 初めて見る動画は伸びが計算できないので、公開からの平均で代用する
    const ageH = Math.max(1, (now - new Date(v.publishedAt).getTime()) / 3600000);
    v.viewsGained = 0;
    v.viewsPerHour = Math.round(v.views / ageH);
    v.rankDelta = 0;
    v.overallDelta = 0;
    v.isNew = true;
  }
  v.likeRate = v.views > 0 ? Math.round((v.likes / v.views) * 1000) / 10 : 0;

  // 今回の値を足してから、1 時間あたりの伸びの推移を作る
  samples.push({ t: nowIso, v: v.views, r: v.rank, o: v.overallRank || 0 });
  v.samples = samples.slice(-SAMPLE_KEEP);
  const spark = [];
  for (let i = 1; i < v.samples.length; i++) {
    const a = v.samples[i - 1];
    const b = v.samples[i];
    const gapH = Math.max(0.25, (new Date(b.t).getTime() - new Date(a.t).getTime()) / 3600000);
    spark.push(Math.max(0, Math.round((b.v - a.v) / gapH)));
  }
  v.spark = spark.slice(-SPARK_POINTS);
  v.accel = last ? accelOf(v.spark, v.viewsPerHour) : 0;
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
const stats = buildStats(videos);
const digest = buildDigest(videos, cats);
const longRunners = buildLongRunners(videos);
const live = buildLive(videos);
const churn = buildChurn(videos, prevIds, history.ranAt || "");
const moves = buildMoves(videos);

// YouTube 側の急上昇の並びは数時間おきにしか変わらない。最後に変わった時刻を控えておき、画面で伝える。
// 総合が取れなかった回は並びが分からないので、前回の値をそのまま使う
const chartSig = videos.filter((v) => v.overallRank > 0).map((v) => v.id).join(",") || history.chartSig || "";
let chartChangedAt = history.chartChangedAt || "";
if (history.chartSig && history.chartSig !== chartSig) chartChangedAt = nowIso;
if (!history.chartSig) chartChangedAt = guessChartChangedAt(history) || nowIso;

// 並びを控え始める前の履歴から、顔ぶれが大きく入れ替わった回を探して代わりにする
function guessChartChangedAt(h) {
  const runs = (h.runs || []).slice();
  const idsAt = (t) => new Set(Object.entries(h.videos).filter(([, x]) => x.samples?.some((s) => s.t === t)).map(([id]) => id));
  // 1 回だけ取りこぼした回に引きずられないよう、直前 2 回のどちらにもいない動画を数える
  for (let i = runs.length - 1; i > 1; i--) {
    const before = new Set([...idsAt(runs[i - 1]), ...idsAt(runs[i - 2])]);
    const added = [...idsAt(runs[i])].filter((id) => !before.has(id)).length;
    if (added >= 15) return runs[i];
  }
  return "";
}
// 履歴の更新より前に、いまの history から 24 時間前のランキングを復元する
const timeMachine = buildTimeMachine(history.videos, now - 24 * 3600000);

// ---------- 5. 保存 ----------
// 次の更新の目安は、cron の設定値ではなく「実際に走った間隔の中央値」から出す。
// GitHub Actions のスケジュール実行は遅れたり飛んだりするため、設定どおりの時刻を書くと
// カウントダウンが 0 のまま何時間も止まり、更新が終わったように見えてしまう。
const RECENT_GAPS = 6; // 直近だけを見る。何時間も空いた過去の実績を引きずらないため
function medianGapMin(runList) {
  const ts = [...runList, nowIso].map((t) => new Date(t).getTime()).filter((n) => n > 0);
  ts.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) gaps.push((ts[i] - ts[i - 1]) / 60000);
  if (!gaps.length) return null;
  // 偶数個のときは短いほうを採る。長く見積もって待たせるより、
  // 目安を過ぎて「最終更新 ○分前」に切り替わるほうが実態に近いため
  const recent = gaps.slice(-RECENT_GAPS).sort((a, b) => a - b);
  return Math.round(recent[Math.floor((recent.length - 1) / 2)]);
}
const gapMin = medianGapMin(history.runs || []);

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
  live,
  churn,
  moves,
  chartChangedAt,
  timeMachine,
  // 直近の実績から見た更新間隔（分）と、次の収集のおおよその時刻
  updateGapMin: gapMin,
  nextUpdateAt: gapMin ? new Date(now + gapMin * 60000).toISOString() : "",
  // samples は履歴用なので公開ファイルには載せない（spark だけ渡す）
  videos: videos.map(({ samples, ...v }) => v),
});

// 履歴は次回の差分計算と「24 時間前のランキング」に使う。古いものは捨てる。
const keepAfter = now - (config.historyDays || 14) * 86400000;
const nextVideos = {};
for (const [id, h] of Object.entries(history.videos)) {
  const seen = h.samples?.length ? new Date(h.samples[h.samples.length - 1].t).getTime() : 0;
  if (seen > keepAfter) nextVideos[id] = h;
}
for (const v of videos) {
  nextVideos[v.id] = {
    firstSeen: v.firstSeen,
    appearances: v.appearances,
    // タイムマシンで昔の動画を並べるため、見出しとサムネイルも残しておく
    title: v.title,
    channel: v.channel,
    thumb: v.thumb,
    samples: v.samples,
  };
}
const runs = [...(history.runs || []), nowIso].slice(-SAMPLE_KEEP);
await writeJson(HISTORY, { ranAt: nowIso, runs, chartSig, chartChangedAt, videos: nextVideos });

const summary = {
  ranAt: nowIso,
  durationSec: Math.round((Date.now() - started) / 1000),
  videos: videos.length,
  channels: channels.length,
  withGrowth: videos.filter((v) => !v.isNew).length,
};
await writeJson(RUN, summary);
log(`done in ${summary.durationSec}s: 動画 ${summary.videos} 件 / チャンネル ${summary.channels} 件（伸びを計算できた動画 ${summary.withGrowth} 件）`);
