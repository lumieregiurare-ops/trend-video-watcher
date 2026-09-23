(() => {
  const $ = (s) => document.querySelector(s);
  const PAGE = 30;
  const STATE_KEY = "ytg:state";
  const FAV_KEY = "ytg:favs";
  const FOLLOW_KEY = "ytg:follows";
  const SEEN_KEY = "ytg:seen";
  const VISIT_KEY = "ytg:lastRanks";
  const SEEN_MAX = 400;

  let data = { videos: [], channels: [], categories: [], rankings: [] };
  let shown = PAGE;
  let pickupId = "";

  const state = Object.assign({ cat: "all", rank: "trending", len: "all", q: "" }, load(STATE_KEY, {}));
  // ブラウザにだけ残る保存物。サーバーには何も送らない。
  let favs = load(FAV_KEY, {});
  let follows = load(FOLLOW_KEY, {});
  let seen = load(SEEN_KEY, []);

  function load(k, fb) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fb;
    } catch {
      return fb;
    }
  }
  function store(k, value) {
    try {
      localStorage.setItem(k, JSON.stringify(value));
    } catch {
      /* 保存できない設定のブラウザでは黙って諦める */
    }
  }
  const save = () => store(STATE_KEY, state);

  // 1.2万 / 340万 のように、日本語で読みやすい桁にまとめる
  function jpNum(n) {
    if (n >= 100000000) return `${(n / 100000000).toFixed(n >= 1000000000 ? 0 : 1)}億`;
    if (n >= 10000) return `${(n / 10000).toFixed(n >= 1000000 ? 0 : 1)}万`;
    return n.toLocaleString("ja-JP");
  }
  function mmss(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    const pad = (x) => String(x).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function rel(iso) {
    const d = (Date.now() - new Date(iso).getTime()) / 1000;
    if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}分前`;
    if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
    return `${Math.floor(d / 86400)}日前`;
  }

  // ---------- お気に入り・フォロー・既読 ----------
  const isFav = (id) => !!favs[id];
  const isFollowed = (cid) => !!follows[cid];
  const favCount = () => Object.keys(favs).length;

  function toggleFav(v) {
    if (favs[v.id]) delete favs[v.id];
    else {
      // 急上昇から外れると収集データから消えるので、表示に必要な分を控えておく
      favs[v.id] = {
        id: v.id,
        title: v.title,
        channel: v.channel,
        channelId: v.channelId,
        thumb: v.thumb,
        views: v.views,
        durationSec: v.durationSec,
        isShort: v.isShort,
        savedAt: new Date().toISOString(),
      };
    }
    store(FAV_KEY, favs);
  }

  function toggleFollow(channelId, title) {
    if (follows[channelId]) delete follows[channelId];
    else follows[channelId] = { title, savedAt: new Date().toISOString() };
    store(FOLLOW_KEY, follows);
  }

  function markSeen(id) {
    if (seen.includes(id)) return;
    seen.push(id);
    if (seen.length > SEEN_MAX) seen = seen.slice(-SEEN_MAX);
    store(SEEN_KEY, seen);
  }

  // ---------- 並び替え ----------
  // 「おまかせ順」は読み込みごとに変わる。同じ表示の中では固定したいので、ここで順番を決めておく。
  const shuffleOrder = new Map();
  const shuffleKey = (id) => {
    if (!shuffleOrder.has(id)) shuffleOrder.set(id, Math.random());
    return shuffleOrder.get(id);
  };

  const SORTS = {
    trending: (a, b) => (a.rank || 999) - (b.rank || 999) || b.views - a.views,
    growth: (a, b) => b.viewsPerHour - a.viewsPerHour,
    viewers: (a, b) => (b.concurrentViewers || 0) - (a.concurrentViewers || 0),
    views: (a, b) => b.views - a.views,
    like: (a, b) => b.likeRate - a.likeRate,
    comment: (a, b) => b.comments - a.comments,
    fresh: (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
    shuffle: (a, b) => shuffleKey(a.id) - shuffleKey(b.id),
  };

  // お気に入りは保存したものを表示する。いまの収集データにあれば最新の数値に差し替える。
  function favVideos() {
    const byId = new Map(data.videos.map((v) => [v.id, v]));
    return Object.values(favs)
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))
      .map((f) => {
        const live = byId.get(f.id);
        if (live) return { ...live, savedAt: f.savedAt, savedViews: f.views };
        // 急上昇から外れた動画。保存しておいた内容で表示する。
        return {
          ...f,
          rank: 0,
          categories: [],
          comments: 0,
          likeRate: 0,
          viewsPerHour: 0,
          rankDelta: 0,
          isNew: false,
          isLive: false,
          spark: [],
          publishedAt: f.savedAt,
          savedViews: f.views,
          gone: true,
        };
      });
  }

  function visible() {
    const q = state.q.trim().toLowerCase();
    const minViews = data.likeRateMinViews || 10000;
    let base = data.videos;
    if (state.cat === "fav") base = favVideos();
    else if (state.cat === "follow") base = data.videos.filter((v) => isFollowed(v.channelId));

    const list = base.filter((v) => {
      if (state.cat !== "all" && state.cat !== "fav" && state.cat !== "follow" && !v.categories.includes(state.cat)) return false;
      if (state.len === "short" && !v.isShort) return false;
      if (state.len === "long" && v.isShort) return false;
      // 高評価率は再生数が少ないと極端な値になるので、一定以上の動画だけを対象にする
      if (state.rank === "like" && v.views < minViews) return false;
      // 同時視聴者数は配信中のものにしかないので、そのときはライブだけを出す
      if (state.rank === "viewers" && !v.isLive) return false;
      if (q && !`${v.title} ${v.channel}`.toLowerCase().includes(q)) return false;
      return true;
    });
    // お気に入りは既定では保存した順（新しいものが上）
    if (state.cat === "fav" && state.rank === "trending") return list;
    return list.sort(SORTS[state.rank] || SORTS.trending);
  }

  // ---------- 部品 ----------
  // 直近の 1 時間あたり再生数の推移を小さな折れ線にする
  function sparkline(spark) {
    if (!spark || spark.length < 3) return null;
    const w = 58;
    const h = 18;
    const max = Math.max(...spark, 1);
    const step = w / (spark.length - 1);
    const pts = spark.map((n, i) => `${(i * step).toFixed(1)},${(h - (n / max) * (h - 2) - 1).toFixed(1)}`);
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "spark");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.setAttribute("width", w);
    svg.setAttribute("height", h);
    svg.setAttribute("aria-hidden", "true");
    const area = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    area.setAttribute("points", `0,${h} ${pts.join(" ")} ${w},${h}`);
    area.setAttribute("class", "spark-area");
    const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    line.setAttribute("points", pts.join(" "));
    line.setAttribute("class", "spark-line");
    svg.append(area, line);
    svg.setAttribute("title", `直近 ${spark.length} 回の伸び`);
    return svg;
  }

  function statTags(v) {
    const key = state.rank;
    const tags = [
      ...(v.isLive ? [{ id: "viewers", html: `<b>${jpNum(v.concurrentViewers)}</b> 人が視聴中` }] : []),
      { id: "views", html: `再生 <b>${jpNum(v.views)}</b>` },
      ...(v.gone ? [] : [{ id: "growth", html: `<b>+${jpNum(v.viewsPerHour)}</b>/時` }]),
      ...(v.gone ? [] : [{ id: "like", html: `高評価率 <b>${v.likeRate}%</b>` }]),
      ...(v.gone ? [] : [{ id: "comment", html: `コメント <b>${jpNum(v.comments)}</b>` }]),
      { id: "fresh", html: rel(v.publishedAt) },
    ];
    // 選んでいるランキングの基準になっている数値を先頭に出して色を付ける
    tags.sort((a, b) => (a.id === key ? -1 : b.id === key ? 1 : 0));
    return tags.map((t) => `<span class="stat${t.id === key ? " key" : ""}">${t.html}</span>`).join("");
  }

  function favButton(v) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "fav-btn" + (isFav(v.id) ? " on" : "");
    b.textContent = "★";
    b.title = isFav(v.id) ? "お気に入りから外す" : "お気に入りに追加";
    b.setAttribute("aria-label", b.title);
    b.addEventListener("click", (e) => {
      e.preventDefault();
      toggleFav(v);
      renderTabs();
      if (state.cat === "fav") render();
      else {
        b.classList.toggle("on", isFav(v.id));
        b.title = isFav(v.id) ? "お気に入りから外す" : "お気に入りに追加";
      }
    });
    return b;
  }

  function makeItem(v, i) {
    const li = document.createElement("li");
    li.className = "item" + (i < 3 && state.cat !== "fav" ? ` top${i + 1}` : "") + (v.rankDelta > 0 ? " rose" : "");
    const url = `https://www.youtube.com/watch?v=${v.id}`;

    const rank = document.createElement("div");
    rank.className = "rank";
    if (v.gone) {
      rank.innerHTML = `<span class="num off">—</span><span class="delta">圏外</span>`;
    } else if (state.cat === "fav") {
      // お気に入りは順位ではなく保存した並びなので、変動は出さない
      rank.innerHTML = `<span class="num">${i + 1}</span><span class="delta">${rel(v.savedAt || v.publishedAt)}に保存</span>`;
    } else {
      let delta = `<span class="delta">—</span>`;
      if (v.isNew) delta = `<span class="delta new">NEW</span>`;
      else if (v.rankDelta > 0) delta = `<span class="delta up">▲${v.rankDelta}</span>`;
      else if (v.rankDelta < 0) delta = `<span class="delta down">▼${Math.abs(v.rankDelta)}</span>`;
      rank.innerHTML = `<span class="num">${i + 1}</span>${delta}`;
      // 総合の急上昇順を見ているときは、前回このサイトを見たときの順位も添える
      if (lastRanks && state.cat === "all" && state.rank === "trending" && state.len === "all" && !state.q.trim()) {
        const was = document.createElement("span");
        const r = lastRanks[v.id];
        was.className = "was" + (r ? "" : " first");
        was.textContent = r ? `前回${r}位` : "前回圏外";
        was.title = "前回このサイトを見たときの順位";
        rank.appendChild(was);
      }
    }

    const thumb = document.createElement("a");
    thumb.className = "thumb";
    thumb.href = url;
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
    thumb.addEventListener("click", () => markSeen(v.id));
    const img = document.createElement("img");
    img.src = v.thumb;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    thumb.appendChild(img);
    if (v.isLive) {
      // 配信中は再生時間の代わりに LIVE と経過時間を出す
      const l = document.createElement("span");
      l.className = "live-tag";
      l.textContent = v.liveStartedAt ? `LIVE ${rel(v.liveStartedAt).replace("前", "")}` : "LIVE";
      thumb.appendChild(l);
    } else if (v.durationSec) {
      const d = document.createElement("span");
      d.className = "dur";
      d.textContent = mmss(v.durationSec);
      thumb.appendChild(d);
    }
    if (v.isShort) {
      const s = document.createElement("span");
      s.className = "short-tag";
      s.textContent = "ショート";
      thumb.appendChild(s);
    }

    const body = document.createElement("div");
    body.className = "body";

    const title = document.createElement("a");
    title.className = "title";
    title.href = url;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = v.title;
    title.title = v.title;
    title.addEventListener("click", () => markSeen(v.id));

    const ch = document.createElement("div");
    ch.className = "ch";
    const chLink = document.createElement("a");
    chLink.href = `https://www.youtube.com/channel/${v.channelId}`;
    chLink.target = "_blank";
    chLink.rel = "noopener noreferrer";
    chLink.className = "ch-link";
    if (v.channelThumb) {
      const ci = document.createElement("img");
      ci.src = v.channelThumb;
      ci.alt = "";
      ci.loading = "lazy";
      chLink.appendChild(ci);
    }
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = v.channel;
    chLink.appendChild(nm);
    if (v.subscribers) {
      const subs = document.createElement("span");
      subs.className = "subs";
      subs.textContent = `登録 ${jpNum(v.subscribers)}`;
      chLink.appendChild(subs);
    }
    ch.appendChild(chLink);
    if (v.channelId) {
      const fb = document.createElement("button");
      fb.type = "button";
      fb.className = "follow-btn" + (isFollowed(v.channelId) ? " on" : "");
      fb.textContent = isFollowed(v.channelId) ? "フォロー中" : "＋フォロー";
      fb.addEventListener("click", () => {
        toggleFollow(v.channelId, v.channel);
        renderTabs();
        render();
      });
      ch.appendChild(fb);
    }

    const stats = document.createElement("div");
    stats.className = "stats";
    stats.innerHTML = statTags(v);
    // お気に入りは「保存してからどれだけ伸びたか」を出す
    if (state.cat === "fav" && typeof v.savedViews === "number") {
      const diff = v.views - v.savedViews;
      const grown = document.createElement("span");
      grown.className = "stat grown";
      grown.innerHTML = diff > 0 ? `保存してから <b>+${jpNum(diff)}</b>` : "保存してから変化なし";
      stats.prepend(grown);
    }
    const sp = sparkline(v.spark);
    if (sp) stats.appendChild(sp);

    body.append(title, ch, stats);
    li.append(rank, thumb, body, favButton(v));
    return li;
  }

  // ---------- 一覧 ----------
  function render() {
    const all = visible();
    const list = all.slice(0, shown);
    const box = $("#list");
    const loading = $("#listLoading");
    if (loading) loading.hidden = true;
    box.innerHTML = "";
    list.forEach((v, i) => box.appendChild(makeItem(v, i)));

    const empty = $("#empty");
    empty.hidden = all.length > 0;
    if (state.cat === "fav" && !all.length) empty.textContent = "お気に入りはまだありません。各動画の ★ を押すとここに貯まります。";
    else if (state.cat === "follow" && !all.length) empty.textContent = "フォロー中のチャンネルの動画は、いま急上昇に入っていません。";
    else empty.textContent = "条件に合う動画がありません。絞り込みを変えてみてください。";

    const more = $("#more");
    more.hidden = all.length <= list.length;
    more.textContent = `もっと見る（残り ${all.length - list.length} 件）`;

    $("#favTools").hidden = state.cat !== "fav";

    const u = new Date(data.updatedAt);
    $("#meta").textContent = `${all.length} 件 ・ 最終更新 ${u.getMonth() + 1}/${u.getDate()} ${String(u.getHours()).padStart(2, "0")}:${String(u.getMinutes()).padStart(2, "0")}`;
  }

  function renderTabs() {
    const tabs = $("#tabs");
    tabs.innerHTML = "";
    const extra = [{ id: "fav", label: `★ お気に入り`, count: favCount() }];
    if (Object.keys(follows).length) extra.push({ id: "follow", label: "フォロー中", count: Object.keys(follows).length });
    for (const c of [...data.categories, ...extra]) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(state.cat === c.id));
      b.textContent = c.label + (c.id === "fav" || c.id === "follow" ? ` ${c.count}` : "");
      b.addEventListener("click", () => {
        set({ cat: c.id });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      tabs.appendChild(b);
    }
  }

  function renderRankChips() {
    const box = $("#rankChips");
    box.innerHTML = "";
    for (const r of data.rankings) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = state.rank === r.id ? "active" : "";
      b.textContent = r.label;
      b.addEventListener("click", () => set({ rank: r.id }));
      box.appendChild(b);
    }
    $("#rankDesc").textContent = data.rankings.find((r) => r.id === state.rank)?.desc || "";
  }

  // ---------- 更新の様子 ----------
  // ---------- 前回見たときの順位 ----------
  // 前回開いたときの総合ランキングを覚えておく。同じタブで開き直しても基準が動かないよう、
  // 最初に読んだ値を sessionStorage に固定する
  let lastRanks = null;
  function setupLastRanks() {
    let prev = null;
    try {
      prev = JSON.parse(sessionStorage.getItem(VISIT_KEY) || "null");
    } catch {
      /* 読めなければ localStorage の値を使う */
    }
    if (!prev) {
      prev = load(VISIT_KEY, {});
      try {
        sessionStorage.setItem(VISIT_KEY, JSON.stringify(prev));
      } catch {
        /* 保存できなくても動く */
      }
    }
    // 総合・急上昇順の画面に出ている並びをそのまま覚える
    const now = {};
    [...data.videos].sort(SORTS.trending).forEach((v, i) => (now[v.id] = i + 1));
    store(VISIT_KEY, now);
    lastRanks = Object.keys(prev).length ? prev : null;
  }

  function renderChurn() {
    const c = data.churn;
    const el = $("#churn");
    if (lastRanks) {
      const ranked = [...data.videos].sort(SORTS.trending);
      const fresh = ranked.filter((v) => !lastRanks[v.id]).length;
      const up = ranked.filter((v, i) => lastRanks[v.id] && lastRanks[v.id] > i + 1).length;
      el.hidden = false;
      el.innerHTML = `前回見たときから <b>${fresh}</b> 本が新しくランクイン・<b>${up}</b> 本が順位を上げました<span class="next" id="nextUpdate"></span>`;
      tickCountdown();
      return;
    }
    if (!c || !c.previousCount) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const parts = [`前回から <b>${c.newCount}</b> 本が入れ替わり`];
    if (c.upCount) parts.push(`<b>${c.upCount}</b> 本が順位を上げました`);
    el.innerHTML = `${parts.join("・")}<span class="next" id="nextUpdate"></span>`;
    tickCountdown();
  }

  function tickCountdown() {
    const el = $("#nextUpdate");
    if (!el) return;
    const left = data.nextUpdateAt ? new Date(data.nextUpdateAt).getTime() - Date.now() : 0;
    if (left > 0) {
      el.textContent = `次の更新まで約 ${Math.max(1, Math.round(left / 60000))} 分`;
      return;
    }
    // 目安を過ぎたら「まもなく更新されます」と言い続けず、最後に更新した時刻を出す。
    // 収集は遅れることがあり、待たせ続ける表示のほうが止まって見えるため。
    const min = Math.max(0, Math.round((Date.now() - new Date(data.updatedAt).getTime()) / 60000));
    el.textContent = min < 120 ? `最終更新 ${min} 分前` : `最終更新 ${Math.round(min / 60)} 時間前`;
  }

  // ---------- 右カラム ----------
  // すぐ入れ替えると切り替わったことが分かりにくいので、いまの高さを保ったままクルクルを挟む。
  // 高さを固定しないと、サムネイルの読み込みと見出しの行数でこの枠から下が上下に動いてしまう。
  const PICKUP_SPIN_MS = 320;
  let pickupTimer = 0;
  function pickupAgain() {
    const box = $("#pickupBody");
    clearTimeout(pickupTimer);
    // 描画前や非表示のタブでは offsetHeight が 0 や極端な値になることがあるので、
    // 常識的な範囲（120〜360px）に収めてから使う
    const h = Math.min(360, Math.max(120, box.offsetHeight || 0));
    box.style.minHeight = `${h}px`;
    box.classList.add("is-loading");
    box.innerHTML = "";
    const sp = document.createElement("span");
    sp.className = "spinner";
    sp.setAttribute("role", "status");
    sp.setAttribute("aria-label", "読み込み中");
    box.appendChild(sp);
    pickupTimer = setTimeout(() => {
      renderPickup();
      box.classList.remove("is-loading");
      box.style.minHeight = "";
    }, PICKUP_SPIN_MS);
  }

  function renderPickup() {
    const pool = data.videos.filter((v) => !v.gone);
    if (!pool.length) {
      $("#pickupMod").hidden = true;
      return;
    }
    // まだ開いていない動画を優先する（毎回同じものが出ないように）
    const unseen = pool.filter((v) => !seen.includes(v.id) && v.id !== pickupId);
    const from = unseen.length ? unseen : pool;
    const v = from[Math.floor(Math.random() * from.length)];
    pickupId = v.id;

    const box = $("#pickupBody");
    box.innerHTML = "";
    const a = document.createElement("a");
    a.href = `https://www.youtube.com/watch?v=${v.id}`;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "pickup-link";
    a.addEventListener("click", () => markSeen(v.id));
    const img = document.createElement("img");
    img.src = v.thumb;
    img.alt = "";
    const t = document.createElement("div");
    t.className = "pickup-title";
    t.textContent = v.title;
    const m = document.createElement("div");
    m.className = "pickup-meta";
    m.textContent = `${v.channel} ・ 再生 ${jpNum(v.views)}`;
    a.append(img, t, m);
    box.appendChild(a);
    $("#pickupMod").hidden = false;
  }

  function renderChannels() {
    const box = $("#channelList");
    box.innerHTML = "";
    for (const c of (data.channels || []).slice(0, 10)) {
      const li = document.createElement("li");
      li.className = "ch-item" + (c.rank <= 3 ? ` top${c.rank}` : "");
      const a = document.createElement("a");
      a.href = `https://www.youtube.com/channel/${c.id}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.className = "info";
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = c.title;
      const sub = document.createElement("div");
      sub.className = "sub";
      sub.textContent = `急上昇 ${c.count} 本 ・ 合計 ${jpNum(c.views)} 回再生`;
      a.append(nm, sub);
      const r = document.createElement("span");
      r.className = "r";
      r.textContent = c.rank;
      const fb = document.createElement("button");
      fb.type = "button";
      fb.className = "follow-btn small" + (isFollowed(c.id) ? " on" : "");
      fb.textContent = isFollowed(c.id) ? "済" : "＋";
      fb.title = isFollowed(c.id) ? "フォローを外す" : "フォローする";
      fb.addEventListener("click", () => {
        toggleFollow(c.id, c.title);
        renderTabs();
        renderChannels();
        render();
      });
      li.append(r, a, fb);
      box.appendChild(li);
    }
    $("#channelMod").hidden = !(data.channels || []).length;
  }

  function renderLive() {
    const list = data.live || [];
    const box = $("#liveList");
    box.innerHTML = "";
    for (const v of list.slice(0, 6)) {
      const li = document.createElement("li");
      li.className = "live-item";
      const a = document.createElement("a");
      a.href = `https://www.youtube.com/watch?v=${v.id}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "contents";
      const img = document.createElement("img");
      img.src = v.thumb;
      img.alt = "";
      img.loading = "lazy";
      const info = document.createElement("div");
      info.className = "info";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = v.title;
      const m = document.createElement("div");
      m.className = "m";
      m.textContent = `${jpNum(v.concurrentViewers)} 人が視聴中 ・ ${v.channel}`;
      info.append(t, m);
      a.append(img, info);
      li.appendChild(a);
      box.appendChild(li);
    }
    $("#liveMod").hidden = !list.length;
  }

  function renderKeywords() {
    const box = $("#keywordCloud");
    box.innerHTML = "";
    // 同じ言葉でも並びが変わるように、読み込みごとにシャッフルする
    const list = [...(data.keywords || [])].sort(() => Math.random() - 0.5);
    for (const k of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "kw";
      b.innerHTML = `${k.word}<span class="n">${k.count}</span>`;
      b.addEventListener("click", () => {
        $("#q").value = k.word;
        set({ q: k.word });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      box.appendChild(b);
    }
    $("#keywordMod").hidden = !list.length;
  }

  // ---------- 下部 ----------
  function renderDigest() {
    const box = $("#digestGrid");
    box.innerHTML = "";
    const list = data.digest || [];
    for (const d of list) {
      const sec = document.createElement("article");
      sec.className = "digest";

      const head = document.createElement("div");
      head.className = "digest-head";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = d.label;
      btn.addEventListener("click", () => {
        set({ cat: d.id });
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = `${data.categories.find((c) => c.id === d.id)?.count || d.videos.length} 本`;
      head.append(btn, n);

      const ol = document.createElement("ol");
      d.videos.forEach((v, i) => {
        const li = document.createElement("li");
        const r = document.createElement("span");
        r.className = "r";
        r.textContent = i + 1;
        const a = document.createElement("a");
        a.href = `https://www.youtube.com/watch?v=${v.id}`;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.style.display = "contents";
        const img = document.createElement("img");
        img.src = v.thumb;
        img.alt = "";
        img.loading = "lazy";
        const body = document.createElement("div");
        body.style.minWidth = "0";
        const t = document.createElement("div");
        t.className = "t";
        t.textContent = v.title;
        const c = document.createElement("div");
        c.className = "c";
        c.textContent = `${v.channel} ・ ${jpNum(v.views)} 回`;
        body.append(t, c);
        a.append(img, body);
        li.append(r, a);
        ol.appendChild(li);
      });

      sec.append(head, ol);
      box.appendChild(sec);
    }
    $("#digestSection").hidden = !list.length;
  }

  function renderStrength() {
    const box = $("#strengthBars");
    box.innerHTML = "";
    const list = data.stats?.categoryStrength || [];
    const max = Math.max(1, ...list.map((c) => c.viewsPerHour));
    for (const c of list) {
      const row = document.createElement("div");
      row.className = "bar-row";
      const lbl = document.createElement("span");
      lbl.className = "lbl";
      lbl.textContent = c.label;
      const track = document.createElement("div");
      track.className = "bar-track";
      const fill = document.createElement("div");
      fill.className = "bar-fill";
      fill.style.width = `${Math.max(3, Math.round((c.viewsPerHour / max) * 100))}%`;
      track.appendChild(fill);
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `+${jpNum(c.viewsPerHour)}/時`;
      row.append(lbl, track, val);
      box.appendChild(row);
    }
    $("#strengthSection").hidden = !list.length;
  }

  function renderTimeMachine() {
    const box = $("#timeList");
    box.innerHTML = "";
    const list = data.timeMachine || [];
    const nowRank = new Map(data.videos.map((v) => [v.id, v.rank]));
    for (const v of list) {
      const li = document.createElement("li");
      li.className = "time-item";
      const r = document.createElement("span");
      r.className = "r";
      r.textContent = v.rank;
      const a = document.createElement("a");
      a.href = `https://www.youtube.com/watch?v=${v.id}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "contents";
      const img = document.createElement("img");
      img.src = v.thumb;
      img.alt = "";
      img.loading = "lazy";
      const info = document.createElement("div");
      info.className = "info";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = v.title;
      const m = document.createElement("div");
      m.className = "m";
      const cur = nowRank.get(v.id);
      m.innerHTML = cur ? `いまは <b>${cur} 位</b> ・ ${v.channel}` : `いまは圏外 ・ ${v.channel}`;
      info.append(t, m);
      a.append(img, info);
      li.append(r, a);
      box.appendChild(li);
    }
    $("#timeSection").hidden = !list.length;
  }

  function renderLongRunners() {
    const box = $("#longList");
    box.innerHTML = "";
    const list = data.longRunners || [];
    for (const v of list) {
      const li = document.createElement("li");
      li.className = "long-item";
      const a = document.createElement("a");
      a.href = `https://www.youtube.com/watch?v=${v.id}`;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.display = "contents";
      const img = document.createElement("img");
      img.src = v.thumb;
      img.alt = "";
      img.loading = "lazy";
      const info = document.createElement("div");
      info.className = "info";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = v.title;
      const m = document.createElement("div");
      m.className = "m";
      m.innerHTML = `<span class="badge">${v.appearances} 回ランクイン</span>${v.channel} ・ ${jpNum(v.views)} 回再生`;
      info.append(t, m);
      a.append(img, info);
      li.appendChild(a);
      box.appendChild(li);
    }
    $("#longSection").hidden = !list.length;
  }

  // ---------- お気に入りの書き出し・読み込み ----------
  async function exportFavs() {
    const text = JSON.stringify({ favs, follows }, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      alert("お気に入りをクリップボードにコピーしました。テキストとして保存しておけば、別の端末で読み込めます。");
    } catch {
      window.prompt("下の内容をコピーして保存してください。", text);
    }
  }

  function importFavs() {
    const text = window.prompt("書き出したお気に入りの内容を貼り付けてください。（いまの内容に追加されます）");
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      Object.assign(favs, parsed.favs || {});
      Object.assign(follows, parsed.follows || {});
      store(FAV_KEY, favs);
      store(FOLLOW_KEY, follows);
      renderTabs();
      render();
      alert(`読み込みました。お気に入り ${favCount()} 件です。`);
    } catch {
      alert("読み込めませんでした。書き出した内容をそのまま貼り付けてください。");
    }
  }

  function set(patch) {
    Object.assign(state, patch);
    shown = PAGE;
    save();
    renderTabs();
    renderRankChips();
    render();
  }

  // ---------- 起動 ----------
  async function boot() {
    $("#year").textContent = new Date().getFullYear();
    $("#q").value = state.q;
    for (const b of document.querySelectorAll("#lenSeg button")) {
      b.classList.toggle("active", b.dataset.len === state.len);
    }

    try {
      const r = await fetch(`data/rankings.json?t=${Math.floor(Date.now() / 300000)}`);
      data = await r.json();
    } catch {
      $("#meta").textContent = "データを読み込めませんでした。";
      // 読み込み中の表示のまま残さない
      $("#listLoading").hidden = true;
      $("#empty").hidden = false;
      $("#empty").textContent = "動画を読み込めませんでした。時間をおいて開き直してください。";
      return;
    }
    $("#sampleNotice").hidden = !data.isSample;
    const catIds = new Set([...data.categories.map((c) => c.id), "fav", "follow"]);
    if (!catIds.has(state.cat)) state.cat = "all";
    if (!data.rankings.some((r) => r.id === state.rank)) state.rank = "trending";

    setupLastRanks();
    renderTabs();
    renderRankChips();
    renderChurn();
    renderPickup();
    renderLive();
    renderChannels();
    renderKeywords();
    renderDigest();
    renderStrength();
    renderTimeMachine();
    renderLongRunners();
    render();
    setInterval(tickCountdown, 30000);
  }

  // ---------- イベント ----------
  $("#q").addEventListener(
    "input",
    (() => {
      let t;
      return (e) => {
        clearTimeout(t);
        t = setTimeout(() => set({ q: e.target.value }), 180);
      };
    })()
  );
  for (const b of document.querySelectorAll("#lenSeg button")) {
    b.addEventListener("click", () => {
      for (const o of document.querySelectorAll("#lenSeg button")) o.classList.toggle("active", o === b);
      set({ len: b.dataset.len });
    });
  }
  $("#more").addEventListener("click", () => {
    shown += PAGE;
    render();
  });
  $("#pickupAgain").addEventListener("click", pickupAgain);
  $("#liveMore").addEventListener("click", () => {
    set({ cat: "live", rank: "viewers" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#favExport").addEventListener("click", exportFavs);
  $("#favImport").addEventListener("click", importFavs);
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("#q")) {
      e.preventDefault();
      $("#q").focus();
    }
  });
  const toTop = $("#toTop");
  const onScroll = () => (toTop.hidden = window.scrollY < 500);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  boot();
})();
