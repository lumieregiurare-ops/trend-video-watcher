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

export function buildStats(videos, categories) {
  const shorts = videos.filter((v) => v.isShort).length;
  const totalViews = videos.reduce((a, v) => a + v.views, 0);
  const top = [...videos].sort((a, b) => b.viewsPerHour - a.viewsPerHour)[0];
  const strength = categories
    .filter((c) => c.id !== "all")
    .map((c) => {
      const list = videos.filter((v) => v.categories.includes(c.id));
      return {
        id: c.id,
        label: c.label,
        count: list.length,
        viewsPerHour: list.reduce((a, v) => a + v.viewsPerHour, 0),
      };
    })
    .filter((c) => c.count > 0)
    .sort((a, b) => b.viewsPerHour - a.viewsPerHour);
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
    categoryStrength: strength,
  };
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
