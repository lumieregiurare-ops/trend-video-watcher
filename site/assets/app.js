(() => {
  const $ = (s) => document.querySelector(s);
  const PAGE = 30;
  const STATE_KEY = "ytg:state";

  let data = { videos: [], channels: [], categories: [], rankings: [] };
  let shown = PAGE;

  const state = Object.assign({ cat: "all", rank: "trending", len: "all", q: "" }, load(STATE_KEY, {}));

  function load(k, fb) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fb;
    } catch {
      return fb;
    }
  }
  function save() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(state));
    } catch {
      /* ignore */
    }
  }

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

  const SORTS = {
    trending: (a, b) => (a.rank || 999) - (b.rank || 999) || b.views - a.views,
    growth: (a, b) => b.viewsPerHour - a.viewsPerHour,
    viewers: (a, b) => (b.concurrentViewers || 0) - (a.concurrentViewers || 0),
    views: (a, b) => b.views - a.views,
    like: (a, b) => b.likeRate - a.likeRate,
    comment: (a, b) => b.comments - a.comments,
    fresh: (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt),
  };

  function visible() {
    const q = state.q.trim().toLowerCase();
    const minViews = data.likeRateMinViews || 10000;
    const list = data.videos.filter((v) => {
      if (state.cat !== "all" && !v.categories.includes(state.cat)) return false;
      if (state.len === "short" && !v.isShort) return false;
      if (state.len === "long" && v.isShort) return false;
      // 高評価率は再生数が少ないと極端な値になるので、一定以上の動画だけを対象にする
      if (state.rank === "like" && v.views < minViews) return false;
      // 同時視聴者数は配信中のものにしかないので、そのときはライブだけを出す
      if (state.rank === "viewers" && !v.isLive) return false;
      if (q && !`${v.title} ${v.channel}`.toLowerCase().includes(q)) return false;
      return true;
    });
    return list.sort(SORTS[state.rank] || SORTS.trending);
  }

  function statTags(v) {
    const key = state.rank;
    const tags = [
      ...(v.isLive ? [{ id: "viewers", html: `<b>${jpNum(v.concurrentViewers)}</b> 人が視聴中` }] : []),
      { id: "views", html: `再生 <b>${jpNum(v.views)}</b>` },
      { id: "growth", html: `<b>+${jpNum(v.viewsPerHour)}</b>/時` },
      { id: "like", html: `高評価率 <b>${v.likeRate}%</b>` },
      { id: "comment", html: `コメント <b>${jpNum(v.comments)}</b>` },
      { id: "fresh", html: rel(v.publishedAt) },
    ];
    // 選んでいるランキングの基準になっている数値を先頭に出して色を付ける
    tags.sort((a, b) => (a.id === key ? -1 : b.id === key ? 1 : 0));
    return tags
      .map((t) => `<span class="stat${t.id === key ? " key" : ""}">${t.html}</span>`)
      .join("");
  }

  function makeItem(v, i) {
    const li = document.createElement("li");
    li.className = "item" + (i < 3 ? ` top${i + 1}` : "");
    const url = `https://www.youtube.com/watch?v=${v.id}`;

    const rank = document.createElement("div");
    rank.className = "rank";
    let delta = "";
    if (v.isNew) delta = `<span class="delta new">NEW</span>`;
    else if (v.rankDelta > 0) delta = `<span class="delta up">▲${v.rankDelta}</span>`;
    else if (v.rankDelta < 0) delta = `<span class="delta down">▼${Math.abs(v.rankDelta)}</span>`;
    else delta = `<span class="delta">—</span>`;
    rank.innerHTML = `<span class="num">${i + 1}</span>${delta}`;

    const thumb = document.createElement("a");
    thumb.className = "thumb";
    thumb.href = url;
    thumb.target = "_blank";
    thumb.rel = "noopener noreferrer";
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

    const ch = document.createElement("a");
    ch.className = "ch";
    ch.href = `https://www.youtube.com/channel/${v.channelId}`;
    ch.target = "_blank";
    ch.rel = "noopener noreferrer";
    if (v.channelThumb) {
      const ci = document.createElement("img");
      ci.src = v.channelThumb;
      ci.alt = "";
      ci.loading = "lazy";
      ch.appendChild(ci);
    }
    const nm = document.createElement("span");
    nm.className = "name";
    nm.textContent = v.channel;
    ch.appendChild(nm);
    if (v.subscribers) {
      const subs = document.createElement("span");
      subs.className = "subs";
      subs.textContent = `登録 ${jpNum(v.subscribers)}`;
      ch.appendChild(subs);
    }

    const stats = document.createElement("div");
    stats.className = "stats";
    stats.innerHTML = statTags(v);

    body.append(title, ch, stats);
    li.append(rank, thumb, body);
    return li;
  }

  function renderTabs() {
    const tabs = $("#tabs");
    tabs.innerHTML = "";
    for (const c of data.categories) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(state.cat === c.id));
      b.textContent = c.label;
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
      li.append(r, a);
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
    const list = data.keywords || [];
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

  function render() {
    const all = visible();
    const list = all.slice(0, shown);
    const box = $("#list");
    box.innerHTML = "";
    list.forEach((v, i) => box.appendChild(makeItem(v, i)));

    $("#empty").hidden = all.length > 0;
    const more = $("#more");
    more.hidden = all.length <= list.length;
    more.textContent = `もっと見る（残り ${all.length - list.length} 件）`;

    const u = new Date(data.updatedAt);
    $("#meta").textContent = `${all.length} 件 ・ 最終更新 ${u.getMonth() + 1}/${u.getDate()} ${String(u.getHours()).padStart(2, "0")}:${String(u.getMinutes()).padStart(2, "0")}`;
  }

  function set(patch) {
    Object.assign(state, patch);
    shown = PAGE;
    save();
    renderTabs();
    renderRankChips();
    render();
  }

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
      return;
    }
    $("#sampleNotice").hidden = !data.isSample;
    if (!data.categories.some((c) => c.id === state.cat)) state.cat = "all";
    if (!data.rankings.some((r) => r.id === state.rank)) state.rank = "trending";
    renderTabs();
    renderRankChips();
    renderLive();
    renderChannels();
    renderKeywords();
    renderDigest();
    renderStrength();
    renderLongRunners();
    render();
  }

  $("#q").addEventListener("input", (() => {
    let t;
    return (e) => {
      clearTimeout(t);
      t = setTimeout(() => set({ q: e.target.value }), 180);
    };
  })());
  for (const b of document.querySelectorAll("#lenSeg button")) {
    b.addEventListener("click", () => {
      for (const o of document.querySelectorAll("#lenSeg button")) o.classList.toggle("active", o === b);
      set({ len: b.dataset.len });
    });
  }
  $("#liveMore").addEventListener("click", () => {
    set({ cat: "live", rank: "viewers" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#more").addEventListener("click", () => {
    shown += PAGE;
    render();
  });
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
