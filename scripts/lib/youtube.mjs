// YouTube Data API v3 を叩く。API キーは環境変数 YOUTUBE_API_KEY から読む。
// 使うのは videos.list（急上昇）と channels.list（チャンネル情報）だけ。どちらも 1 回 1 ユニット。
import { fetchJson } from "./util.mjs";

const BASE = "https://www.googleapis.com/youtube/v3";

export function apiKey() {
  return (process.env.YOUTUBE_API_KEY || "").trim();
}

function url(path, params) {
  const u = new URLSearchParams({ key: apiKey() });
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") u.set(k, String(v));
  }
  return `${BASE}/${path}?${u}`;
}

// ISO8601 の再生時間（PT1H2M3S）を秒に直す
export function durationSec(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || "");
  if (!m) return 0;
  return Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0);
}

function normalizeVideo(v, rank) {
  const s = v.snippet || {};
  const st = v.statistics || {};
  const th = s.thumbnails || {};
  const sec = durationSec(v.contentDetails?.duration);
  return {
    id: v.id,
    rank,
    title: (s.title || "").trim(),
    channelId: s.channelId || "",
    channel: (s.channelTitle || "").trim(),
    publishedAt: s.publishedAt || "",
    categoryId: String(s.categoryId || ""),
    thumb: (th.medium || th.high || th.default || {}).url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    views: Number(st.viewCount) || 0,
    likes: Number(st.likeCount) || 0,
    comments: Number(st.commentCount) || 0,
    durationSec: sec,
    isShort: sec > 0 && sec <= 60,
  };
}

// 急上昇（chart=mostPopular）を取得する。カテゴリ ID が空なら総合。
export async function fetchTrending({ regionCode = "JP", categoryId = "", maxResults = 50 } = {}) {
  if (!apiKey()) return [];
  const json = await fetchJson(
    url("videos", {
      part: "snippet,statistics,contentDetails",
      chart: "mostPopular",
      regionCode,
      videoCategoryId: categoryId,
      maxResults,
    }),
    { timeoutMs: 25000 }
  );
  return (json.items || []).map((v, i) => normalizeVideo(v, i + 1));
}

// チャンネル情報をまとめて取得する（1 回 50 件まで）
export async function fetchChannels(ids) {
  if (!apiKey() || !ids.length) return new Map();
  const out = new Map();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    try {
      const json = await fetchJson(url("channels", { part: "snippet,statistics", id: chunk.join(",") }), { timeoutMs: 25000 });
      for (const c of json.items || []) {
        out.set(c.id, {
          id: c.id,
          title: (c.snippet?.title || "").trim(),
          thumb: (c.snippet?.thumbnails?.default || c.snippet?.thumbnails?.medium || {}).url || "",
          subscribers: c.statistics?.hiddenSubscriberCount ? 0 : Number(c.statistics?.subscriberCount) || 0,
          videoCount: Number(c.statistics?.videoCount) || 0,
        });
      }
    } catch (e) {
      console.error(`[youtube] channels.list: ${e.message}`);
    }
  }
  return out;
}
