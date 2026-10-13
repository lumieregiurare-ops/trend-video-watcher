// VTuber の配信データから、ページに出す集計（配信中・予定・同接ランキング・記念日・よく遊ばれているゲームなど）を作る。
// collect-vtuber.mjs とサンプル生成（sample-vtuber.mjs）の両方から使うので、入出力のない処理はここにまとめる。
import { decodeEntities } from "./xml.mjs";

const H = 3600000;
const DAY = 24 * H;

// ---------- 日本時間の日付 ----------
export function jstDay(ms) {
  return new Date(ms + 9 * H).toISOString().slice(0, 10);
}
// 日本時間のその日の 0 時（UTC のミリ秒）
export function jstMidnight(ms) {
  const d = new Date(ms + 9 * H);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * H;
}
const ts = (iso) => (iso ? new Date(iso).getTime() || 0 : 0);

// ---------- YouTube のチャンネル RSS ----------
// https://www.youtube.com/feeds/videos.xml?channel_id=UC… は API のユニットを使わずに直近 15 本を返す。
// 再生数（media:statistics）も入っているので、アップロード済みの動画の数字はこれで足りる。
export function parseYoutubeFeed(xml) {
  const channelTitle = decodeEntities((/<feed[\s\S]*?<title>([^<]*)<\/title>/.exec(xml) || [])[1] || "").trim();
  const entries = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const e = m[1];
    const id = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e) || [])[1];
    if (!id) continue;
    entries.push({
      id,
      channelId: (/<yt:channelId>([^<]+)<\/yt:channelId>/.exec(e) || [])[1] || "",
      title: decodeEntities((/<title>([^<]*)<\/title>/.exec(e) || [])[1] || "").trim(),
      publishedAt: (/<published>([^<]+)<\/published>/.exec(e) || [])[1] || "",
      views: Number((/<media:statistics views="(\d+)"/.exec(e) || [])[1]) || 0,
      likes: Number((/<media:starRating count="(\d+)"/.exec(e) || [])[1]) || 0,
    });
  }
  return { channelTitle, entries };
}

// ---------- 配信のジャンル ----------
// タイトルの言葉から大まかに分ける。上から順に見て、最初に当てはまったものにする
export const GENRES = [
  { id: "event", label: "記念・お披露目", re: /3D|お披露目|周年|記念配信|記念ライブ|生誕祭|誕生日|凸待ち|anniversary|birthday|debut/i },
  { id: "song", label: "歌枠", re: /歌枠|歌う|うたわく|カラオケ|karaoke|singing|歌配信|歌ってみた/i },
  { id: "asmr", label: "ASMR", re: /asmr|耳かき|囁き|添い寝|バイノーラル|睡眠導入/i },
  { id: "watch", label: "同時視聴", re: /同時視聴|同接視聴|watch\s?-?along|ウォッチパーティ|みんなで見る/i },
  { id: "cook", label: "料理・食", re: /料理|cooking|お料理|食レポ|飯テロ|晩酌|飲酒/i },
  { id: "draw", label: "お絵描き", re: /お絵描き|お絵かき|drawing|art stream|イラスト/i },
  { id: "morning", label: "朝活", re: /朝活|おはよう|good morning/i },
  { id: "talk", label: "雑談", re: /雑談|freetalk|free talk|chatting|just chatting|お話|おしゃべり|まったり話|フリートーク|マシュマロ|お便り|superchat|スパチャ読み/i },
];
export function genreOf(title) {
  for (const g of GENRES) if (g.re.test(title)) return g.id;
  return "game";
}

// ---------- タイトルから「いま遊ばれているゲーム・企画」を拾う ----------
const STOP_WORDS = [
  "ホロライブ", "hololive", "ホロスターズ", "holostars", "にじさんじ", "nijisanji", "ぶいすぽ", "ぶいすぽっ", "vspo", "ネオポルテ", "neo-porte", "neoporte",
  "ななしいんく", "774inc", "vtuber", "新人vtuber", "個人vtuber", "個人勢", "jp", "en", "id", "dev_is", "regloss", "flowglow",
  "初見", "初見プレイ", "初見歓迎", "ネタバレあり", "ネタバレ注意", "ネタバレ", "live", "生配信", "配信", "アーカイブ", "archive", "ゲーム実況", "実況", "ゲーム",
  "shorts", "short", "ショート", "切り抜き", "歌ってみた", "mv", "official", "music video", "cover", "original", "オリジナル曲",
  "参加型", "コラボ", "collab", "w/", "ft", "feat", "eng sub", "engsub", "日本語", "english", "完全初見", "前編", "後編", "最終回", "part",
  "記念", "雑談", "歌枠", "asmr", "朝活", "同時視聴", "お知らせ", "告知", "重大告知", "新衣装", "3d", "ソロ", "耐久",
  "視点", "ad", "pr", "sponsored", "提供", "案件", "プロモーション", "生放送", "ゲリラ", "ゲリラ配信", "初配信", "サムネ",
];
const STOP = new Set(STOP_WORDS.map((w) => w.normalize("NFKC").toLowerCase()));

function normToken(s) {
  return s
    .normalize("NFKC")
    .replace(/[\s　]+/g, " ")
    // 回数・パート番号（#3、Part2、Day5、10日目）はゲーム名から外す
    .replace(/\s*(?:#|＃|part|ep\.?|episode|day|vol\.?)\s*\d+$/i, "")
    .replace(/\s*\d+\s*日目$/, "")
    .replace(/^[\s\-–—~〜:：!！?？.。,、]+|[\s\-–—~〜:：!！?？.。,、]+$/g, "")
    .trim();
}

// 名前の一覧（自分や他のタレントの名前を除くため）
export function nameMatcher(names) {
  const list = [...new Set(names.map((n) => n.normalize("NFKC").toLowerCase().replace(/\s+/g, "")).filter((n) => n.length >= 2))];
  return (token) => {
    const t = token.toLowerCase().replace(/\s+/g, "");
    return list.some((n) => t === n || (n.length >= 3 && t.includes(n)));
  };
}

// タイトルから名前を消す（「レイン・パターソン」のように区切り文字を含む名前を、分割する前に取り除くため）
export function nameStripper(names) {
  // 2 文字の名前（える、叶 など）はゲーム名の一部まで消してしまうので、3 文字以上（英字は 4 文字以上）だけを消す
  const list = [...new Set(names.map((n) => n.normalize("NFKC").trim()).filter((n) => (/^[\x20-\x7e]+$/.test(n) ? n.length >= 4 : n.length >= 3)))].sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  const re = list.length ? new RegExp(list.map(esc).join("|"), "gi") : null;
  return (text) => (re ? text.replace(re, " ") : text);
}

// 事務所名やユニット名で始まる言葉（hololive Dreams のような企画名は残す）
const AGENCY_PREFIX = /^(hololive|holostars|nijisanji|vspo|ホロライブ|ホロスターズ|にじさんじ|ぶいすぽ)(\s*(en|id|jp|dev_is|kr|holoro|holoh3ro|area15|myth|promise|advent|justice|regloss|flow\s?glow))?$/i;

// よく遊ばれるゲームの表記ゆれをまとめる（左が表示に使う名前）
const ALIASES = [
  ["APEX", "apex legends", "apexlegends", "エーペックス", "えぺ"],
  ["Minecraft", "マイクラ", "マインクラフト"],
  ["スト6", "street fighter 6", "streetfighter6", "ストリートファイター6", "sf6"],
  ["VALORANT", "ヴァロラント", "ヴァロ"],
  ["LoL", "league of legends", "リーグ・オブ・レジェンド"],
  ["Overwatch 2", "ow", "ow2", "overwatch", "オーバーウォッチ", "オーバーウォッチ2"],
  ["スプラトゥーン3", "splatoon3", "splatoon 3", "スプラ3", "スプラ"],
  ["ペルソナ5 ザ・ロイヤル", "p5r", "persona 5 royal"],
  ["マリオカート8DX", "マリカ", "マリオカート", "mario kart 8 deluxe", "mk8dx"],
  ["Fortnite", "フォートナイト"],
  ["GTA V", "gta5", "gtav", "グラセフ", "gta"],
  ["雀魂", "じゃんたま", "mahjong soul"],
  ["ポケモンSV", "ポケットモンスター スカーレット・バイオレット", "pokemon sv"],
  ["Among Us", "amongus", "アモアス"],
];
const ALIAS = new Map();
for (const [display, ...rest] of ALIASES) {
  const key = display.normalize("NFKC").toLowerCase();
  ALIAS.set(key, { key, display });
  for (const r of rest) ALIAS.set(r.normalize("NFKC").toLowerCase(), { key, display });
}

export function titleTokens(title) {
  const brackets = [];
  for (const m of title.matchAll(/【([^】]{1,60})】|\[([^\]]{1,60})\]|『([^』]{1,60})』/g)) brackets.push(m[1] || m[2] || m[3]);
  const tags = [...title.matchAll(/[#＃]([^\s#＃【】\[\]()（）「」『』、。,!！?？|｜/／]{2,30})/g)].map((m) => m[1]);
  const words = [];
  for (const b of brackets) {
    // 「・」はゲーム名にも入る（ペルソナ5 ザ・ロイヤル）ので区切りにしない
    for (const part of b.split(/[\/／|｜,，、＆&×]+/)) {
      const t = part.replace(/[#＃]\S*/g, "").trim();
      if (t) words.push(t);
    }
  }
  return { words, tags };
}

// streams: [{ id, c, title, live }]。数えるのは「その言葉が出てくる配信の本数」。
// 1 チャンネルだけが使っている言葉（本人の愛称・シリーズ名・個人のハッシュタグ）は外し、2 チャンネル以上で使われているものだけを出す
export function buildWords(streams, isName, { limit = 30, strip = (t) => t, minChannels = 2 } = {}) {
  const game = new Map();
  const tag = new Map();
  const add = (map, raw, s) => {
    let n = normToken(raw);
    let key = n.toLowerCase();
    if (n.length < 2 || n.length > 30 || /^\d+$/.test(n) || STOP.has(key) || AGENCY_PREFIX.test(n) || isName(n)) return;
    const alias = ALIAS.get(key);
    if (alias) ({ key, display: n } = alias);
    const r = map.get(key) || { forms: new Map(), ids: new Set(), chs: new Set(), live: 0 };
    if (r.ids.has(s.id)) return;
    r.ids.add(s.id);
    r.chs.add(s.c || s.id);
    if (s.live) r.live++;
    r.forms.set(n, (r.forms.get(n) || 0) + 1);
    map.set(key, r);
  };
  for (const s of streams) {
    const title = (s.title || "").normalize("NFKC");
    const { tags } = titleTokens(title);
    const { words } = titleTokens(strip(title));
    for (const w of words) add(game, w, s);
    for (const t of tags) add(tag, t, s);
  }
  const out = (map) =>
    [...map.values()]
      .filter((r) => r.ids.size >= 2 && r.chs.size >= minChannels)
      .sort((a, b) => b.chs.size - a.chs.size || b.ids.size - a.ids.size || b.live - a.live)
      .slice(0, limit)
      .map((r) => ({ w: [...r.forms.entries()].sort((a, b) => b[1] - a[1])[0][0], n: r.ids.size, ch: r.chs.size, live: r.live }));
  return { games: out(game), tags: out(tag) };
}

// ---------- 登録者数の節目 ----------
const MILESTONES = [1e4, 3e4, 5e4, 1e5, 2e5, 3e5, 4e5, 5e5, 6e5, 7e5, 8e5, 9e5, 1e6, 1.25e6, 1.5e6, 1.75e6, 2e6, 2.5e6, 3e6, 3.5e6, 4e6, 4.5e6, 5e6];
const nextMilestone = (n) => MILESTONES.find((m) => m > n) || 0;

// ---------- まとめ ----------
// input:
//   now, site, agencies（config.vtuber.agencies + other）
//   roster   { talents: [{ id, name, enName, agency, unit, birthday, debut, fanName, page, color }], officials: [{ id, agency }] }
//   state    { channels, subDays, subs, videos, peaks, timeline, discovered }
//   trending 急上昇（rankings.json の videos）
export function buildVtuberData({ now, site, agencies, roster, state, trending = [], isSample = false, upcomingDays = 7, previousAt = "" }) {
  const agencyById = new Map(agencies.map((a) => [a.id, a]));
  const otherId = agencies[agencies.length - 1].id;

  // チャンネル単位にまとめる（1 チャンネルを複数人で使っている場合は名前を並べる）
  const chMeta = new Map();
  for (const t of roster.talents || []) {
    const c = chMeta.get(t.id) || { id: t.id, names: [], enNames: [], agency: t.agency, unit: t.unit || "", page: t.page || "", fan: [], color: t.color || "" };
    c.names.push(t.name);
    if (t.enName) c.enNames.push(t.enName);
    if (t.fanName && !/^(無し|なし|-|ー)$/.test(t.fanName)) c.fan.push(t.fanName);
    chMeta.set(t.id, c);
  }
  for (const o of roster.officials || []) {
    if (!chMeta.has(o.id)) chMeta.set(o.id, { id: o.id, names: [], enNames: [], agency: o.agency, unit: "", page: "", fan: [], official: true });
  }
  for (const [id, d] of Object.entries(state.discovered || {})) {
    if (!chMeta.has(id)) chMeta.set(id, { id, names: [], enNames: [], agency: otherId, unit: "", page: "", fan: [], discovered: true, dTitle: d.t });
  }
  const chName = (id) => {
    const c = chMeta.get(id);
    if (!c) return state.channels?.[id]?.t || "";
    if (c.names.length) return c.names.join(" / ");
    return state.channels?.[id]?.t || c.dTitle || "";
  };

  // ---------- 動画を状態ごとに分ける ----------
  const vids = Object.entries(state.videos || {})
    .map(([id, v]) => ({ id, ...v }))
    .filter((v) => chMeta.has(v.c));
  const live = vids.filter((v) => v.st === "live").sort((a, b) => (b.cv || 0) - (a.cv || 0));
  const upcomingLimit = now + upcomingDays * DAY;
  // 予定時刻を 1 時間以上過ぎても始まらない枠は、延期や消し忘れのことが多いので出さない
  const upcoming = vids
    .filter((v) => v.st === "upcoming" && ts(v.sc) > now - H && ts(v.sc) < upcomingLimit)
    .sort((a, b) => ts(a.sc) - ts(b.sc));
  const recentFrom = now - 48 * H;
  const recent = vids
    .filter((v) => (v.st === "done" || v.st === "video" || !v.st) && Math.max(ts(v.e), ts(v.p)) >= recentFrom)
    .map((v) => {
      const base = ts(v.e) || ts(v.p);
      const ageH = Math.max(1, (now - base) / H);
      return { ...v, vph: Math.round((v.v || 0) / ageH) };
    })
    .sort((a, b) => Math.max(ts(b.e), ts(b.p)) - Math.max(ts(a.e), ts(a.p)));

  const kindOf = (v) => (v.pr ? "premiere" : v.st === "done" ? "stream" : v.d > 0 && v.d <= 60 ? "short" : "video");

  // ---------- チャンネルごとの状態 ----------
  const status = new Map();
  for (const v of live) if (!status.has(v.c)) status.set(v.c, { st: "live", liveId: v.id });
  const nextLive = new Map();
  for (const v of upcoming) if (!nextLive.has(v.c)) nextLive.set(v.c, v.sc);
  const lastLive = new Map();
  for (const v of vids) {
    if (v.st !== "done" && v.st !== "live") continue;
    const t = v.st === "live" ? now : ts(v.e) || ts(v.s);
    if (t && t > (lastLive.get(v.c) || 0)) lastLive.set(v.c, t);
  }

  // 登録者数の伸び（日本時間の日ごとに残している値との差）
  const days = state.subDays || [];
  const gain = (arr, back) => {
    if (!arr || arr.length < 2) return null;
    const cur = arr[arr.length - 1];
    const old = arr[arr.length - 1 - back];
    return cur != null && old != null && arr.length - 1 - back >= 0 ? cur - old : null;
  };

  const channels = [...chMeta.values()]
    .filter((c) => !c.discovered || vids.some((v) => v.c === c.id))
    .map((c) => {
      const info = state.channels?.[c.id] || {};
      const arr = state.subs?.[c.id];
      const subs = info.s || 0;
      const st = status.get(c.id)?.st || (nextLive.has(c.id) && ts(nextLive.get(c.id)) - now < 24 * H ? "upcoming" : "");
      return {
        id: c.id,
        n: chName(c.id),
        en: c.enNames.join(" / ") || undefined,
        yt: info.t && info.t !== chName(c.id) ? info.t : undefined,
        a: c.agency,
        u: c.unit || undefined,
        th: info.th || "",
        s: subs,
        d1: gain(arr, 1),
        d7: gain(arr, 7),
        d30: gain(arr, 30),
        vc: info.vc || 0,
        v: info.v || 0,
        h: info.h || undefined,
        page: c.page || undefined,
        fan: c.fan.join(" / ") || undefined,
        off: c.official || undefined,
        st: st || undefined,
        next: nextLive.get(c.id) || undefined,
        last: lastLive.get(c.id) ? new Date(lastLive.get(c.id)).toISOString() : undefined,
      };
    })
    .sort((a, b) => b.s - a.s);

  // ---------- 人ごとの記念日（誕生日・デビュー日）----------
  const people = (roster.talents || [])
    .filter((t) => t.birthday || t.debut)
    .map((t) => ({ n: t.name, c: t.id, a: t.agency, b: t.birthday || undefined, d: t.debut || undefined }));

  // ---------- 事務所ごとの集計 ----------
  const agencyRows = agencies.map((a) => {
    const chs = channels.filter((c) => c.a === a.id);
    const lv = live.filter((v) => chMeta.get(v.c)?.agency === a.id);
    return {
      id: a.id,
      label: a.label,
      color: a.color,
      talents: chs.filter((c) => !c.off).length,
      live: lv.length,
      viewers: lv.reduce((s, v) => s + (v.cv || 0), 0),
      upcoming24: upcoming.filter((v) => chMeta.get(v.c)?.agency === a.id && ts(v.sc) - now < 24 * H).length,
      subs: chs.reduce((s, c) => s + (c.s || 0), 0),
    };
  }).filter((a) => a.talents > 0 || a.live > 0);

  // ---------- 同時視聴者数のランキング（観測できた最大値）----------
  const peakRows = (state.peaks || []).map((p) => ({ ...p, live: state.videos?.[p.id]?.st === "live" }));
  const peakOut = (list, n) => list.sort((a, b) => b.pk - a.pk).slice(0, n).map((p) => ({ id: p.id, t: p.t, c: p.c, pk: p.pk, s: p.s, e: p.e || undefined, live: p.live || undefined }));
  const peaks = {
    day: peakOut(peakRows.filter((p) => p.live || ts(p.s) >= now - DAY), 20),
    week: peakOut(peakRows.filter((p) => ts(p.s) >= now - 7 * DAY), 30),
  };

  // ---------- 登録者数の節目 ----------
  const near = [];
  const reached = [];
  for (const c of channels) {
    if (!c.s || c.off) continue;
    const next = nextMilestone(c.s);
    if (next && c.s >= next * 0.96) {
      const perDay = c.d7 != null && c.d7 > 0 ? c.d7 / 7 : c.d30 != null && c.d30 > 0 ? c.d30 / 30 : 0;
      near.push({ c: c.id, s: c.s, next, eta: perDay ? Math.ceil((next - c.s) / perDay) : null });
    }
    const arr = state.subs?.[c.id] || [];
    const old = arr.length > 7 ? arr[arr.length - 8] : arr.find((x) => x != null);
    if (old != null) {
      const crossed = MILESTONES.filter((m) => old < m && c.s >= m).pop();
      if (crossed) reached.push({ c: c.id, s: c.s, th: crossed });
    }
  }
  near.sort((a, b) => b.s / b.next - a.s / a.next);
  reached.sort((a, b) => b.th - a.th);

  // ---------- タイトルの言葉 ----------
  const allNames = [...chMeta.values()].flatMap((c) => [...c.names, ...c.enNames, ...(state.channels?.[c.id]?.t ? [state.channels[c.id].t] : [])]);
  const units = [...new Set([...chMeta.values()].map((c) => c.unit).filter(Boolean))];
  const isName = nameMatcher([...allNames, ...units, ...agencies.map((a) => a.label)]);
  const strip = nameStripper([...allNames, ...units]);
  const todayStart = jstMidnight(now);
  // まだ API で確かめていない新着（st が空）も、配信のアーカイブであることが多いので数に入れる
  const isStreamish = (v) => v.st === "done" || (!v.st && !(v.d > 0 && v.d <= 60));
  const streamsForWords = [
    ...live.map((v) => ({ id: v.id, c: v.c, title: v.t, live: true })),
    ...upcoming.filter((v) => ts(v.sc) - now < 24 * H).map((v) => ({ id: v.id, c: v.c, title: v.t })),
    ...recent.filter(isStreamish).map((v) => ({ id: v.id, c: v.c, title: v.t })),
  ];
  const words = buildWords(streamsForWords, isName, { strip });

  // ジャンルの内訳（配信中と、この 24 時間に終わった配信）
  const genreCount = new Map(GENRES.map((g) => [g.id, { live: 0, all: 0 }]));
  genreCount.set("game", { live: 0, all: 0 });
  for (const s of [...live.map((v) => ({ ...v, isLive: true })), ...recent.filter((v) => isStreamish(v) && (ts(v.e) || ts(v.p)) >= now - DAY)]) {
    const g = genreCount.get(genreOf(s.t || ""));
    g.all++;
    if (s.isLive) g.live++;
  }
  const genres = [...GENRES, { id: "game", label: "ゲーム・その他" }]
    .map((g) => ({ id: g.id, label: g.label, ...genreCount.get(g.id) }))
    .filter((g) => g.all > 0)
    .sort((a, b) => b.all - a.all);

  // ---------- コラボ（タイトルに別のタレントの名前が入っている配信）----------
  const nameIndex = [];
  for (const c of chMeta.values()) {
    for (const n of c.names) {
      const k = n.normalize("NFKC").replace(/\s+/g, "");
      if (k.length >= 3) nameIndex.push({ k, c: c.id });
    }
    for (const n of c.enNames) if (n.length >= 6) nameIndex.push({ k: n.toLowerCase(), c: c.id, en: true });
  }
  const collabOf = (v) => {
    const t = (v.t || "").normalize("NFKC");
    const flat = t.replace(/\s+/g, "");
    const lower = t.toLowerCase();
    const found = new Set();
    for (const x of nameIndex) {
      if (x.c === v.c) continue;
      if (x.en ? lower.includes(x.k) : flat.includes(x.k)) found.add(x.c);
    }
    return [...found];
  };
  const collabs = [];
  for (const [list, kind] of [[live, "live"], [upcoming.filter((v) => ts(v.sc) - now < 3 * DAY), "upcoming"], [recent.filter((v) => v.st === "done"), "done"]]) {
    for (const v of list) {
      const w = collabOf(v);
      if (w.length) collabs.push({ id: v.id, t: v.t, c: v.c, w, k: kind, at: v.sc || v.s || v.p });
    }
  }

  // ---------- 急上昇に入っている VTuber の動画 ----------
  const trend = trending
    .filter((v) => chMeta.has(v.channelId) && (v.overallRank > 0 || (v.categories || []).some((c) => c !== "live")))
    .sort((a, b) => (a.overallRank || 999) - (b.overallRank || 999) || (a.rank || 999) - (b.rank || 999))
    .slice(0, 30)
    .map((v) => ({ id: v.id, t: v.title, c: v.channelId, r: v.overallRank || 0, cat: (v.categories || []).filter((c) => c !== "all" && c !== "live")[0] || "", cr: v.rank || 0, v: v.views }));

  // ---------- 一覧の外に出す数字 ----------
  const doneToday = vids.filter((v) => (v.st === "done" || v.st === "live") && ts(v.s) >= todayStart).length;
  const summary = {
    live: live.length,
    viewers: live.reduce((s, v) => s + (v.cv || 0), 0),
    upcoming24: upcoming.filter((v) => ts(v.sc) - now < 24 * H).length,
    streamsToday: doneToday,
    uploads24: recent.filter((v) => v.st !== "done" && ts(v.p) >= now - DAY).length,
    talents: channels.filter((c) => !c.off && !chMeta.get(c.id)?.discovered).length,
    totalSubs: channels.reduce((s, c) => s + (c.s || 0), 0),
    collabs: collabs.filter((c) => c.k === "live").length,
  };

  return {
    updatedAt: new Date(now).toISOString(),
    previousAt,
    isSample: isSample || undefined,
    site,
    rosterAt: roster.syncedAt || "",
    agencies: agencyRows,
    summary,
    live: live.map((v) => ({ id: v.id, t: v.t, c: v.c, cv: v.cv || 0, pk: v.pk || 0, s: v.s || "", pr: v.pr || undefined, g: genreOf(v.t || "") })),
    upcoming: upcoming.map((v) => ({ id: v.id, t: v.t, c: v.c, sc: v.sc, pr: v.pr || undefined })),
    recent: recent.slice(0, 400).map((v) => ({ id: v.id, t: v.t, c: v.c, p: v.p, v: v.v || 0, vph: v.vph, d: v.d || 0, k: kindOf(v), pk: v.pk || undefined, s: v.s || undefined, e: v.e || undefined })),
    peaks,
    milestones: { near: near.slice(0, 20), reached: reached.slice(0, 20) },
    timeline: (state.timeline || []).slice(-96),
    words,
    genres,
    collabs: collabs.slice(0, 40),
    trending: trend,
    channels,
    people,
  };
}

// 前回の値と比べて、1 回の集計ぶんのタイムライン（配信中の本数・合計視聴者数）を作る
export function timelinePoint(nowIso, liveVideos, agencyOf) {
  const a = {};
  for (const v of liveVideos) {
    const id = agencyOf(v.c);
    if (!id) continue;
    a[id] = a[id] || [0, 0];
    a[id][0]++;
    a[id][1] += v.cv || 0;
  }
  return { t: nowIso, n: liveVideos.length, v: liveVideos.reduce((s, v) => s + (v.cv || 0), 0), a };
}

// 配信中の動画の最大同時視聴者数を残しておく（直近 7 日・上位 200 本）
export function updatePeaks(peaks, videos, now) {
  const map = new Map((peaks || []).map((p) => [p.id, p]));
  for (const [id, v] of Object.entries(videos)) {
    if (!v.pk || !v.s) continue;
    const cur = map.get(id);
    if (!cur || v.pk >= cur.pk || v.e !== cur.e) map.set(id, { id, t: v.t, c: v.c, pk: Math.max(v.pk, cur?.pk || 0), s: v.s, e: v.e || "" });
  }
  return [...map.values()]
    .filter((p) => ts(p.s) >= now - 7 * DAY)
    .sort((a, b) => b.pk - a.pk)
    .slice(0, 200);
}
