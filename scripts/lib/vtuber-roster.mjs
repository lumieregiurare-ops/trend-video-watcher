// VTuber の名簿（チャンネル ID・名前・誕生日・デビュー日など）を各事務所の公式サイトから集める。
// 名簿は data/vtuber-roster.json にコミットしておき、collect-vtuber.mjs が 1 週間おきに作り直す。
//
// 取り方は事務所ごとに 3 種類:
//   pages      … 一覧ページ → タレントごとのページ（ホロライブ・ホロスターズ・ネオポルテ）
//   nijisanji  … 公式サイトの Next.js のデータ（にじさんじ・NIJISANJI EN）
//   links      … 1 枚のページに並んでいる YouTube のリンク（ぶいすぽっ！・ななしいんく）
import { fetchText, pool, log } from "./util.mjs";
import { decodeEntities, stripTags } from "./xml.mjs";
import { fetchChannelIdsByHandle } from "./youtube.mjs";

const YT_LINK = /https?:\/\/(?:www\.|m\.)?youtube\.com\/(channel\/UC[\w-]{22}|@[^"'\s?<>#\\/]+)/g;

// youtube.com/channel/UC… か youtube.com/@handle を、{ id } か { handle } にする
function ytRefs(html) {
  const out = [];
  const seen = new Set();
  for (const m of html.matchAll(YT_LINK)) {
    const raw = decodeURIComponent(m[1]);
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ ref: raw.startsWith("@") ? { handle: raw } : { id: raw.slice("channel/".length) }, index: m.index });
  }
  return out;
}

// 「4月16日」→「04-16」
function monthDay(s) {
  const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/.exec(s || "");
  return m ? `${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
}

// 「2026年9月24日」→「2026-09-24」
function ymd(s) {
  const m = /(\d{4})\s*[年/.-]\s*(\d{1,2})\s*[月/.-]\s*(\d{1,2})/.exec(s || "");
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
}

// ISO の時刻を日本時間の日付にする（にじさんじのデビュー日は前日 15:00Z で入っている）
function jstDate(iso) {
  const t = new Date(iso).getTime();
  if (!t) return "";
  return new Date(t + 9 * 3600000).toISOString().slice(0, 10);
}

// <dt>誕生日</dt><dd>4月16日</dd> のような表を読む
function profileTable(html) {
  const out = {};
  for (const m of html.matchAll(/<dt[^>]*>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi)) {
    const k = stripTags(m[1]);
    if (k && !(k in out)) out[k] = stripTags(m[2]);
  }
  return out;
}

const pick = (table, keys) => keys.map((k) => table[k]).find(Boolean) || "";

// 公式サイトの名前にはゼロ幅スペースが混ざっていることがある
const cleanName = (s) => (s || "").replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();

// ---------- pages: 一覧 → 個別ページ ----------
async function fromPages(agency) {
  const src = agency.source;
  const listHtml = await fetchText(src.list, { timeoutMs: 30000 });
  const pageRe = new RegExp(src.page);
  const urls = [...new Set([...listHtml.matchAll(/href=["']([^"']+)["']/gi)].map((m) => new URL(decodeEntities(m[1]), src.list).toString()))].filter((u) => pageRe.test(u));
  // 一覧ページの <h3>宝鐘マリン<span>Houshou Marine</span></h3> から英語名を拾っておく（英語のタイトルのコラボ検出に使う）
  const enNames = new Map();
  for (const m of listHtml.matchAll(/href=["']([^"']+)["']/gi)) {
    const u = new URL(decodeEntities(m[1]), src.list).toString();
    if (!pageRe.test(u) || enNames.has(u)) continue;
    const h = /<h3[^>]*>[^<]*<span[^>]*>([^<]+)<\/span>/i.exec(listHtml.slice(m.index, m.index + 1500));
    if (h) enNames.set(u, decodeEntities(h[1]).trim());
  }
  // 一覧ページにあるリンクは事務所の公式チャンネルなので、タレントのページでは除く
  const official = ytRefs(listHtml).map((r) => r.ref);
  const officialKeys = new Set(official.map((r) => (r.id || r.handle).toLowerCase()));

  const rows = await pool(urls, 4, async (url) => {
    const html = await fetchText(url, { timeoutMs: 30000 });
    const title = decodeEntities((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "").split(/\s+[|｜]\s+/)[0].trim();
    // 【卒業生】【配信活動終了】【退職】などの付いた人は活動していないので載せない
    if (!title || /^【/.test(title)) return null;
    const ref = ytRefs(html).map((r) => r.ref).find((r) => !officialKeys.has((r.id || r.handle).toLowerCase()));
    if (!ref) return null;
    const table = profileTable(html);
    return {
      ...ref,
      name: title,
      enName: /^[\x20-\x7e]+$/.test(enNames.get(url) || "") ? enNames.get(url) : "",
      unit: pick(table, ["ユニット", "所属", "Unit"]),
      birthday: monthDay(pick(table, ["誕生日", "Birthday"])),
      debut: ymd(pick(table, ["初配信日", "デビュー日", "初配信", "Debut"])),
      fanName: pick(table, ["ファンネーム", "Fan Name"]),
      page: url,
    };
  });
  const talents = rows.filter((r) => r && !r.error);
  const failed = rows.filter((r) => r?.error).length;
  if (failed) log(`[roster] ${agency.label}: ${failed} ページを読めませんでした`);
  return { talents, official };
}

// ---------- nijisanji: 公式サイトの Next.js データ ----------
async function fromNijisanji(agency) {
  const src = agency.source;
  const base = "https://www.nijisanji.jp";
  const html = await fetchText(`${base}/talents`, { timeoutMs: 30000 });
  const next = JSON.parse(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  const buildId = next.buildId;
  const livers = (next.props?.pageProps?.allLivers || []).filter((l) => (l.profile?.affiliation || []).some((a) => src.affiliations.includes(a)));

  const rows = await pool(livers, 4, async (l) => {
    let d = null;
    try {
      d = (await fetchJsonText(`${base}/_next/data/${buildId}/ja/talents/l/${l.slug}.json`)).pageProps?.liverDetail;
    } catch {
      // ビルドが入れ替わった直後などは JSON の URL が変わるので、HTML から読み直す
      const page = await fetchText(`${base}/talents/l/${l.slug}`, { timeoutMs: 30000 });
      d = JSON.parse(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(page)[1]).props?.pageProps?.liverDetail;
    }
    if (!d || d.hidden || d.unit) return null;
    const id = d.channelId || (/channel\/(UC[\w-]{22})/.exec(d.socialLinks?.youtube || "") || [])[1];
    if (!id) return null;
    const items = Object.fromEntries((d.profile?.profileItems || []).map((x) => [x.name, x.value]));
    const aff = (d.profile?.affiliation || []).find((a) => src.affiliations.includes(a)) || "";
    return {
      id,
      name: d.name || l.name,
      enName: d.enName || l.enName || "",
      unit: aff === "にじさんじ" ? "" : aff,
      birthday: monthDay(items["誕生日"] || ""),
      debut: jstDate(d.profile?.debutAt),
      fanName: items["ファンネーム"] || "",
      color: d.profile?.color || "",
      page: `${base}/talents/l/${l.slug}`,
    };
  });
  const failed = rows.filter((r) => r?.error).length;
  if (failed) log(`[roster] ${agency.label}: ${failed} 人分を読めませんでした`);
  return { talents: rows.filter((r) => r && !r.error), official: [] };
}

async function fetchJsonText(url) {
  return JSON.parse(await fetchText(url, { timeoutMs: 30000 }));
}

// ---------- links: 1 枚のページの YouTube リンク ----------
// 名前はリンクの直前にある見出しか画像の alt から取る（取れなければ YouTube のチャンネル名を使う）
const NOT_A_NAME = /\.(png|jpe?g|webp|gif|svg)$|^(youtube|twitter|x|niconico|bilibili|tiktok|twitch|instagram|icon|logo|)$/i;
function nameBefore(html, index) {
  const chunk = html.slice(Math.max(0, index - 2500), index);
  let best = { at: -1, name: "" };
  for (const m of chunk.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)) {
    const t = stripTags(m[1]);
    if (t && t.length <= 30 && m.index > best.at) best = { at: m.index, name: t };
  }
  for (const m of chunk.matchAll(/\balt=["']([^"']*)["']/gi)) {
    const t = decodeEntities(m[1]).trim();
    if (t && !NOT_A_NAME.test(t) && t.length <= 30 && m.index > best.at) best = { at: m.index, name: t };
  }
  return best.name;
}

async function fromLinks(agency) {
  const html = await fetchText(agency.source.url, { timeoutMs: 30000 });
  const talents = ytRefs(html).map((r) => {
    const key = r.ref.handle || r.ref.id;
    // 事務所そのもののチャンネル（@774inc_official など）は公式として扱う
    const official = /official|office|公式/i.test(key);
    return { ...r.ref, name: official ? "" : nameBefore(html, r.index), official, page: agency.source.url };
  });
  return { talents: talents.filter((t) => !t.official), official: talents.filter((t) => t.official).map((t) => (t.id ? { id: t.id } : { handle: t.handle })) };
}

const SOURCES = { pages: fromPages, nijisanji: fromNijisanji, links: fromLinks };

// ハンドル（@xxx）をチャンネル ID にする。前回の名簿 → YouTube API（1 件 1 ユニット）→ チャンネルのページ の順に試す
async function resolveHandles(handles, cache) {
  const out = new Map();
  const todo = [];
  for (const h of handles) {
    const hit = cache.get(h.toLowerCase());
    if (hit) out.set(h.toLowerCase(), hit);
    else todo.push(h);
  }
  if (!todo.length) return out;
  log(`[roster] ハンドルを ${todo.length} 件調べます`);
  const viaApi = await fetchChannelIdsByHandle(todo).catch(() => new Map());
  const rest = [];
  for (const h of todo) {
    const id = viaApi.get(h.toLowerCase());
    if (id) out.set(h.toLowerCase(), id);
    else rest.push(h);
  }
  await pool(rest, 3, async (h) => {
    const html = await fetchText(`https://www.youtube.com/${encodeURIComponent(h).replace(/^%40/, "@")}`, { timeoutMs: 30000, headers: { "accept-language": "ja,en;q=0.8" } });
    const id = (/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html) || /"externalId":"(UC[\w-]{22})"/.exec(html) || [])[1];
    if (id) out.set(h.toLowerCase(), id);
  });
  return out;
}

// 名簿を作り直す。取れなかった事務所や、極端に人数が減った事務所は前回の名簿をそのまま使う
// （公式サイトの作りが変わって 0 人になったとき、サイトから一斉に消えないように）
export async function syncRoster(config, previous) {
  const vt = config.vtuber || {};
  const prevTalents = previous?.talents || [];
  const handleCache = new Map(prevTalents.filter((t) => t.handle && t.id).map((t) => [t.handle.toLowerCase(), t.id]));
  for (const [h, id] of Object.entries(previous?.handles || {})) handleCache.set(h, id);

  const talents = [];
  const officials = [];
  const report = [];
  for (const agency of vt.agencies || []) {
    const fn = SOURCES[agency.source?.type];
    const prev = prevTalents.filter((t) => t.agency === agency.id);
    let got = null;
    try {
      if (!fn) throw new Error(`unknown source type: ${agency.source?.type}`);
      got = await fn(agency);
    } catch (e) {
      log(`[roster] ${agency.label}: 取得できませんでした（${e.message}）`);
    }
    if (!got || got.talents.length < Math.max(1, Math.floor(prev.length * 0.5))) {
      if (got) log(`[roster] ${agency.label}: ${got.talents.length} 人しか取れなかったので前回の ${prev.length} 人を使います`);
      talents.push(...prev);
      officials.push(...(previous?.officials || []).filter((o) => o.agency === agency.id));
      report.push({ agency: agency.id, count: prev.length, kept: true });
      continue;
    }
    for (const t of got.talents) talents.push({ ...t, agency: agency.id });
    for (const o of got.official) officials.push({ ...o, agency: agency.id, official: true });
    report.push({ agency: agency.id, count: got.talents.length });
    log(`[roster] ${agency.label}: ${got.talents.length} 人`);
  }

  // 手で足したチャンネル（config.vtuber.extraChannels）
  for (const x of vt.extraChannels || []) talents.push({ ...x, agency: x.agency || "other", manual: true });

  const handles = [...new Set([...talents, ...officials].filter((t) => !t.id && t.handle).map((t) => t.handle))];
  const resolved = await resolveHandles(handles, handleCache);
  const fix = (t) => (t.id ? t : { ...t, id: resolved.get((t.handle || "").toLowerCase()) || "" });

  // 1 つのチャンネルを 2 人以上で使っていることがある（FUWAMOCO など）。
  // 誕生日は人ごとに出したいので、名簿は人単位のまま残し、同じ人の重複だけを落とす
  const seen = new Set();
  const uniq = (list) =>
    list.map(fix).filter((t) => {
      const key = `${t.id}|${t.name || ""}`;
      if (!t.id || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const outTalents = uniq(talents);
  const outOfficials = uniq(officials);
  const missing = handles.filter((h) => !resolved.has(h.toLowerCase()));
  if (missing.length) log(`[roster] チャンネル ID が分からなかったハンドル: ${missing.join(", ")}`);

  return {
    syncedAt: new Date().toISOString(),
    report,
    handles: Object.fromEntries([...resolved.entries()]),
    talents: outTalents.map(({ index, ...t }) => ({ ...t, name: cleanName(t.name) })),
    officials: outOfficials,
  };
}
