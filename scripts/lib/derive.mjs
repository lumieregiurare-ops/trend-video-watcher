// 集めた動画から、一覧の外に出す集計（サマリー・急上昇ワード・カテゴリ別ダイジェストなど）を作る。
// collect.mjs とサンプル生成の両方から使うので、ここにまとめておく。

const STOP = new Set([
  "動画", "公式", "チャンネル", "最新", "今回", "今日", "本日", "紹介", "解説", "まとめ", "話題",
  "shorts", "short", "official", "video", "music", "mv", "full", "ver", "feat", "the", "and", "you",
  "ライブ", "アーカイブ", "ダイジェスト", "ハイライト", "エピソード", "オープニング",
]);

// タイトルからそれらしい語を取り出す（カタカナ・漢字・英数字のかたまり）
function tokens(title) {
  const t = title.replace(/[【】\[\]（）()「」『』|｜#＃]/g, " ");
  const out = new Set();
  for (const re of [/[ァ-ヴー]{3,}/g, /[一-龥]{2,}/g, /[A-Za-z][A-Za-z0-9'’]{2,}/g]) {
    for (const m of t.match(re) || []) {
      const w = m.toLowerCase();
      if (!STOP.has(w) && !STOP.has(m) && w.length <= 14) out.add(m);
    }
  }
  return [...out];
}

// いま急上昇でよく出ている言葉。押すと絞り込めるようにフロントで使う。
export function buildKeywords(videos, { limit = 18, minCount = 2 } = {}) {
  const count = new Map();
  const views = new Map();
  for (const v of videos) {
    for (const w of tokens(v.title)) {
      count.set(w, (count.get(w) || 0) + 1);
      views.set(w, (views.get(w) || 0) + v.viewsPerHour);
    }
  }
  return [...count.entries()]
    .filter(([, n]) => n >= minCount)
    .sort((a, b) => b[1] - a[1] || (views.get(b[0]) || 0) - (views.get(a[0]) || 0))
    .slice(0, limit)
    .map(([word, n]) => ({ word, count: n }));
}

export function buildStats(videos) {
  const shorts = videos.filter((v) => v.isShort).length;
  const totalViews = videos.reduce((a, v) => a + v.views, 0);
  const top = [...videos].sort((a, b) => b.viewsPerHour - a.viewsPerHour)[0];
  const lives = videos.filter((v) => v.isLive);
  return {
    videoCount: videos.length,
    totalViews,
    avgViews: videos.length ? Math.round(totalViews / videos.length) : 0,
    liveCount: lives.length,
    liveViewers: lives.reduce((a, v) => a + (v.concurrentViewers || 0), 0),
    shortCount: shorts,
    shortRatio: videos.length ? Math.round((shorts / videos.length) * 100) : 0,
    newCount: videos.filter((v) => v.isNew).length,
    topGrowth: top ? { id: top.id, title: top.title, viewsPerHour: top.viewsPerHour, thumb: top.thumb, channel: top.channel } : null,
  };
}

// 直近の伸びが、それまでのペース（直前 6 回の中央値）の何倍か。
// 急上昇の並びは数時間変わらないことが多いので、集計ごとに顔ぶれが変わる指標として使う。
export function accelOf(spark, viewsPerHour, { minViewsPerHour = 3000, floor = 500 } = {}) {
  if (!spark || spark.length < 4 || viewsPerHour < minViewsPerHour) return 0;
  const before = spark.slice(0, -1).slice(-6).sort((a, b) => a - b);
  const base = Math.max(floor, before[Math.floor(before.length / 2)] || 0);
  return Math.round((viewsPerHour / base) * 10) / 10;
}

// 前回の集計からの目立った動き。一覧の上に並べる。
export function buildMoves(videos, { limit = 5 } = {}) {
  const used = new Set();
  const moves = [];
  const pick = (list, make) => {
    const v = list.find((x) => !used.has(x.id));
    if (!v) return;
    used.add(v.id);
    moves.push({ id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, isShort: !!v.isShort, ...make(v) });
  };
  const by = (f) => [...videos].sort((a, b) => f(b) - f(a));

  const accelList = by((v) => v.accel || 0).filter((v) => v.accel >= 1.5);

  pick(by((v) => v.viewsPerHour), (v) => ({ kind: "growth", value: v.viewsPerHour }));
  pick(accelList, (v) => ({ kind: "accel", value: v.accel }));
  pick(
    videos.filter((v) => v.isNew && v.overallRank > 0).sort((a, b) => a.overallRank - b.overallRank),
    (v) => ({ kind: "entry", value: v.overallRank })
  );
  pick(
    videos.filter((v) => v.isLive && v.isNew).sort((a, b) => (b.concurrentViewers || 0) - (a.concurrentViewers || 0)),
    (v) => ({ kind: "live", value: v.concurrentViewers || 0 })
  );
  pick(by((v) => v.rankDelta).filter((v) => v.rankDelta >= 3), (v) => ({ kind: "up", value: v.rankDelta }));
  // 枠が余ったら加速の 2 番手以降で埋める
  for (const v of accelList) {
    if (moves.length >= limit) break;
    pick([v], (x) => ({ kind: "accel", value: x.accel }));
  }
  return moves.slice(0, limit);
}

// 前回の収集からどれだけ入れ替わったか
export function buildChurn(videos, prevIds, prevRanAt) {
  const nowIds = new Set(videos.map((v) => v.id));
  let stayed = 0;
  for (const id of prevIds) if (nowIds.has(id)) stayed++;
  return {
    previousAt: prevRanAt || "",
    previousCount: prevIds.size,
    newCount: videos.filter((v) => v.isNew).length,
    droppedCount: Math.max(0, prevIds.size - stayed),
    upCount: videos.filter((v) => v.rankDelta > 0).length,
    downCount: videos.filter((v) => v.rankDelta < 0).length,
  };
}

// 指定時刻ごろの総合の順位を履歴から復元する（タイムマシン用）。
// o（総合の順位）を控える前の記録は、カテゴリ内の順位 r で代わりにする
export function buildTimeMachine(historyVideos, targetMs, { limit = 10, toleranceH = 3 } = {}) {
  const rows = [];
  for (const [id, h] of Object.entries(historyVideos || {})) {
    if (!h.samples?.length || !h.title) continue;
    let best = null;
    let bestGap = Infinity;
    for (const s of h.samples) {
      if (!(s.o ?? s.r)) continue;
      const gap = Math.abs(new Date(s.t).getTime() - targetMs);
      if (gap < bestGap) {
        bestGap = gap;
        best = s;
      }
    }
    if (!best || bestGap > toleranceH * 3600000) continue;
    rows.push({ id, title: h.title, channel: h.channel || "", thumb: h.thumb || "", rank: best.o ?? best.r, views: best.v, at: best.t });
  }
  return rows.sort((a, b) => a.rank - b.rank || b.views - a.views).slice(0, limit);
}

// いま配信中のライブを、同時視聴者数の多い順に
export function buildLive(videos, { limit = 8 } = {}) {
  return videos
    .filter((v) => v.isLive)
    .sort((a, b) => (b.concurrentViewers || 0) - (a.concurrentViewers || 0))
    .slice(0, limit)
    .map((v) => ({
      id: v.id,
      title: v.title,
      channel: v.channel,
      thumb: v.thumb,
      concurrentViewers: v.concurrentViewers || 0,
      liveStartedAt: v.liveStartedAt || "",
    }));
}

// カテゴリごとの上位数件。ページ下部のダイジェストに使う。
export function buildDigest(videos, categories, { perCategory = 3 } = {}) {
  return categories
    .filter((c) => c.id !== "all")
    .map((c) => ({
      id: c.id,
      label: c.label,
      videos: videos
        .filter((v) => v.categories.includes(c.id))
        .sort((a, b) => (a.rank || 999) - (b.rank || 999) || b.views - a.views)
        .slice(0, perCategory)
        .map((v) => ({ id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, views: v.views, isShort: v.isShort })),
    }))
    .filter((c) => c.videos.length > 0);
}

// 何回も急上昇に出続けている動画（ランクインの回数が多い順）
export function buildLongRunners(videos, { limit = 10, minAppearances = 2 } = {}) {
  return videos
    .filter((v) => (v.appearances || 0) >= minAppearances)
    .sort((a, b) => b.appearances - a.appearances || b.views - a.views)
    .slice(0, limit)
    .map((v) => ({ id: v.id, title: v.title, channel: v.channel, thumb: v.thumb, views: v.views, appearances: v.appearances, firstSeen: v.firstSeen }));
}
