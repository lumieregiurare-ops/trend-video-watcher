(() => {
  const $ = (s) => document.querySelector(s);
  const STATE_KEY = "vt:state";
  const OSHI_KEY = "vt:oshi";
  const H = 3600000;
  const DAY = 24 * H;

  let data = null;
  let chById = new Map();
  let agencyById = new Map();
  const shown = { live: 24, up: 40, recent: 30, sub: 30, dir: 60 };
  const PAGE = { live: 24, up: 40, recent: 30, sub: 30, dir: 60 };

  const state = Object.assign(
    { ag: "all", q: "", genre: "all", liveSort: "viewers", peakRange: "day", recentSort: "new", recentKind: "all", subSort: "s", dirSort: "status", agencyMetric: "viewers", timelineMetric: "v", milestoneTab: "near" },
    load(STATE_KEY, {})
  );
  // ?ag=hololive のように URL で事務所を指定できる（共有用）
  const urlAg = new URLSearchParams(location.search).get("ag");
  if (urlAg) state.ag = urlAg;
  // 推しはこのブラウザにだけ保存する。サーバーには何も送らない
  let oshi = load(OSHI_KEY, {});

  function load(k, fb) {
    try {
      return JSON.parse(localStorage.getItem(k)) ?? fb;
    } catch {
      return fb;
    }
  }
  function store(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* 保存できない設定のブラウザでは黙って諦める */
    }
  }

  // ---------- 表示の部品 ----------
  function jpNum(n) {
    if (n == null) return "—";
    const a = Math.abs(n);
    if (a >= 100000000) return `${(n / 100000000).toFixed(a >= 1000000000 ? 0 : 1)}億`;
    if (a >= 10000) return `${(n / 10000).toFixed(a >= 1000000 ? 0 : 1).replace(/\.0$/, "")}万`;
    return n.toLocaleString("ja-JP");
  }
  const signed = (n) => (n == null ? "—" : n > 0 ? `+${jpNum(n)}` : n < 0 ? `−${jpNum(-n)}` : "±0");
  const pad = (x) => String(x).padStart(2, "0");
  const ms = (iso) => (iso ? new Date(iso).getTime() : 0);
  const hm = (iso) => {
    const d = new Date(iso);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
  const md = (iso) => {
    const d = new Date(iso);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  };
  function rel(iso) {
    const d = (Date.now() - ms(iso)) / 1000;
    if (d < 60) return "たった今";
    if (d < 3600) return `${Math.floor(d / 60)}分前`;
    if (d < 86400) return `${Math.floor(d / 3600)}時間前`;
    return `${Math.floor(d / 86400)}日前`;
  }
  function until(iso) {
    const d = (ms(iso) - Date.now()) / 60000;
    if (d < -1) return "予定時刻を過ぎています";
    if (d < 1) return "まもなく";
    if (d < 60) return `あと${Math.round(d)}分`;
    if (d < 24 * 60) return `あと${Math.floor(d / 60)}時間${Math.round(d % 60) ? `${Math.round(d % 60)}分` : ""}`;
    return `あと${Math.floor(d / 1440)}日`;
  }
  function elapsed(iso) {
    const m = Math.max(0, Math.floor((Date.now() - ms(iso)) / 60000));
    return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${pad(m % 60)}分`;
  }
  function mmss(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function dayLabel(t) {
    const d = new Date(t);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - today) / DAY);
    const base = `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`;
    return diff === 0 ? `今日 ${base}` : diff === 1 ? `明日 ${base}` : diff === 2 ? `あさって ${base}` : base;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function link(href, cls, text) {
    const a = el("a", cls, text);
    a.href = href;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }
  const watchUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
  const chUrl = (c) => (c?.h ? `https://www.youtube.com/${c.h}` : `https://www.youtube.com/channel/${c?.id || ""}`);

  function thumb(id, { live = false, dur = 0, short = false, size = "" } = {}) {
    const a = link(watchUrl(id), `vt-thumb${size ? ` ${size}` : ""}`);
    const img = el("img");
    img.src = `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    // 消えた動画・サンプルの ID は灰色の枠のままにする
    img.addEventListener("error", () => img.remove(), { once: true });
    a.appendChild(img);
    if (live) a.appendChild(el("span", "live-tag", "LIVE"));
    else if (dur) a.appendChild(el("span", "dur", mmss(dur)));
    if (short) a.appendChild(el("span", "short-tag", "ショート"));
    return a;
  }

  function avatar(c, size = 28) {
    const wrap = el("span", "vt-avatar");
    wrap.style.setProperty("--ag", agencyById.get(c?.a)?.color || "#999");
    wrap.style.width = wrap.style.height = `${size}px`;
    if (c?.th) {
      const img = el("img");
      img.src = c.th;
      img.alt = "";
      img.loading = "lazy";
      img.addEventListener("error", () => {
        img.remove();
        wrap.textContent = (c.n || "?").slice(0, 1);
      }, { once: true });
      wrap.appendChild(img);
    } else {
      wrap.textContent = (c?.n || "?").slice(0, 1);
    }
    return wrap;
  }

  function agencyBadge(id) {
    const a = agencyById.get(id);
    const b = el("span", "vt-ag");
    b.style.setProperty("--ag", a?.color || "#999");
    b.textContent = a?.label || "その他";
    return b;
  }

  function oshiButton(c, small = false) {
    const b = el("button", `vt-oshi${small ? " small" : ""}${oshi[c.id] ? " on" : ""}`);
    b.type = "button";
    const sync = () => {
      const on = !!oshi[c.id];
      b.classList.toggle("on", on);
      b.textContent = on ? "★" : "☆";
      b.title = on ? `${c.n} を推しから外す` : `${c.n} を推しに登録`;
      b.setAttribute("aria-label", b.title);
      b.setAttribute("aria-pressed", String(on));
    };
    sync();
    b.addEventListener("click", (e) => {
      e.preventDefault();
      if (oshi[c.id]) delete oshi[c.id];
      else oshi[c.id] = { n: c.n, at: new Date().toISOString() };
      store(OSHI_KEY, oshi);
      if (state.ag === "oshi") renderAll();
      else {
        renderTabs();
        for (const other of document.querySelectorAll(`.vt-oshi[data-c="${c.id}"]`)) other.dispatchEvent(new Event("vt:sync"));
      }
    });
    b.dataset.c = c.id;
    b.addEventListener("vt:sync", sync);
    return b;
  }

  // 「名前（事務所）☆」の行
  function who(chId, { star = true, size = 24 } = {}) {
    const c = chById.get(chId) || { id: chId, n: "", a: "other" };
    const row = el("div", "vt-who");
    const a = link(chUrl(c), "vt-who-link");
    a.append(avatar(c, size), el("span", "vt-name", c.n || c.yt || "（チャンネル）"));
    row.append(a, agencyBadge(c.a));
    if (star) row.appendChild(oshiButton(c, true));
    return row;
  }

  // ---------- 絞り込み ----------
  const qNorm = (s) => (s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  function chOk(chId) {
    const c = chById.get(chId);
    if (state.ag === "oshi") return !!oshi[chId];
    if (state.ag !== "all" && (c?.a || "other") !== state.ag) return false;
    return true;
  }
  function textOk(title, chId) {
    const q = qNorm(state.q);
    if (!q) return true;
    const c = chById.get(chId) || {};
    return qNorm(`${title || ""} ${c.n || ""} ${c.en || ""} ${c.yt || ""} ${c.u || ""}`).includes(q);
  }
  const ok = (v) => chOk(v.c) && textOk(v.t, v.c);
  const scopeLabel = () => (state.ag === "oshi" ? "推し" : state.ag === "all" ? "" : agencyById.get(state.ag)?.label || "");

  // ---------- タブ ----------
  function renderTabs() {
    const box = $("#tabs");
    box.innerHTML = "";
    const tabs = [
      { id: "all", label: "すべて", n: data.summary.live },
      ...data.agencies.map((a) => ({ id: a.id, label: a.label, n: a.live, color: a.color })),
      { id: "oshi", label: `★ 推し ${Object.keys(oshi).length}` },
    ];
    for (const t of tabs) {
      const b = el("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("aria-selected", String(state.ag === t.id));
      if (t.color) {
        const dot = el("span", "vt-tab-dot");
        dot.style.background = t.color;
        b.appendChild(dot);
      }
      b.appendChild(document.createTextNode(t.label));
      if (t.id !== "oshi" && t.n) b.appendChild(el("span", "vt-tab-n", `${t.n}`));
      if (t.id !== "oshi") b.title = `配信中 ${t.n || 0} 枠`;
      b.addEventListener("click", () => set({ ag: t.id }));
      box.appendChild(b);
    }
  }

  // ---------- 上の数字 ----------
  function renderHero() {
    const live = data.live.filter(ok);
    const now = Date.now();
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    const up24 = data.upcoming.filter((v) => ok(v) && ms(v.sc) - now < DAY && ms(v.sc) > now - H);
    const today = live.filter((v) => ms(v.s) >= midnight.getTime()).length + data.recent.filter((v) => ok(v) && v.k === "stream" && ms(v.s) >= midnight.getTime()).length;
    const uploads = data.recent.filter((v) => ok(v) && v.k !== "stream" && ms(v.p) >= now - DAY).length;
    const talents = data.channels.filter((c) => !c.off && chOk(c.id)).length;
    const kpis = [
      { label: "配信中", value: `${live.length}`, unit: "枠", key: true },
      { label: "同時視聴者（合計）", value: jpNum(live.reduce((s, v) => s + (v.cv || 0), 0)), unit: "人" },
      { label: "24 時間以内の配信予定", value: `${up24.length}`, unit: "枠" },
      { label: "今日始まった配信", value: `${today}`, unit: "枠" },
      { label: "24 時間の新着動画", value: `${uploads}`, unit: "本" },
      { label: "集計しているタレント", value: `${talents}`, unit: "人" },
    ];
    const box = $("#kpis");
    box.innerHTML = "";
    for (const k of kpis) {
      const d = el("div", `vt-kpi${k.key ? " key" : ""}`);
      const dd = el("dd");
      dd.append(el("span", "vt-kpi-v", k.value), el("span", "vt-kpi-u", k.unit));
      d.append(el("dt", "", k.label), dd);
      box.appendChild(d);
    }
    const u = new Date(data.updatedAt);
    const agN = data.agencies.filter((a) => a.id !== "other").length;
    $("#heroDesc").textContent =
      `${data.agencies.filter((a) => a.id !== "other").map((a) => a.label).join("・")} の ${data.summary.talents} 人（${agN} 事務所）と、急上昇などで見つけた個人勢の配信を 30 分おきに集計しています。` +
      `最終更新 ${md(data.updatedAt)} ${hm(data.updatedAt)}（${rel(u.toISOString())}）`;
  }

  // ---------- 配信中 ----------
  const GENRE_LABEL = () => new Map((data.genres || []).map((g) => [g.id, g.label]));
  function renderGenreChips() {
    const box = $("#genreChips");
    box.innerHTML = "";
    const live = data.live.filter(ok);
    const counts = new Map();
    for (const v of live) counts.set(v.g, (counts.get(v.g) || 0) + 1);
    const labels = GENRE_LABEL();
    const list = [["all", "すべて", live.length], ...[...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => [id, labels.get(id) || id, n])];
    if (state.genre !== "all" && !counts.has(state.genre)) state.genre = "all";
    for (const [id, label, n] of list) {
      const b = el("button", state.genre === id ? "active" : "");
      b.type = "button";
      b.append(document.createTextNode(label), el("span", "n", ` ${n}`));
      b.addEventListener("click", () => set({ genre: id }, false));
      box.appendChild(b);
    }
    box.hidden = live.length === 0;
  }

  function renderLive() {
    $("#liveLoading").hidden = true;
    const sorts = {
      viewers: (a, b) => (b.cv || 0) - (a.cv || 0),
      new: (a, b) => ms(b.s) - ms(a.s),
      long: (a, b) => ms(a.s) - ms(b.s),
    };
    const all = data.live.filter((v) => ok(v) && (state.genre === "all" || v.g === state.genre)).sort(sorts[state.liveSort] || sorts.viewers);
    const box = $("#liveList");
    box.innerHTML = "";
    const labels = GENRE_LABEL();
    all.slice(0, shown.live).forEach((v, i) => {
      const li = el("li", `vt-card${i < 3 && state.liveSort === "viewers" ? " top" : ""}`);
      const th = thumb(v.id, { live: true });
      th.querySelector(".live-tag").textContent = v.s ? `LIVE ${elapsed(v.s)}` : "LIVE";
      const viewers = el("span", "vt-viewers");
      viewers.innerHTML = `<b>${jpNum(v.cv)}</b>人`;
      th.appendChild(viewers);
      if (v.pr) th.appendChild(el("span", "vt-premiere", "プレミア公開"));
      const body = el("div", "vt-card-body");
      const title = link(watchUrl(v.id), "vt-title", v.t);
      title.title = v.t;
      const meta = el("div", "vt-meta");
      meta.append(
        el("span", "", v.s ? `${hm(v.s)} 開始` : ""),
        el("span", "", v.pk > v.cv ? `最大 ${jpNum(v.pk)} 人` : ""),
        el("span", "vt-genre", labels.get(v.g) || "")
      );
      body.append(title, who(v.c), meta);
      li.append(th, body);
      box.appendChild(li);
    });
    $("#liveCount").textContent = ` ${all.length} 枠`;
    const empty = $("#liveEmpty");
    empty.hidden = all.length > 0;
    empty.textContent = state.ag === "oshi" && !Object.keys(oshi).length ? "推しはまだいません。名鑑や各配信の ☆ を押すと登録できます。" : "条件に合う配信はいまありません。";
    const more = $("#liveMore");
    more.hidden = all.length <= shown.live;
    more.textContent = `もっと見る（残り ${all.length - shown.live} 枠）`;
  }

  // ---------- 配信予定 ----------
  function renderUpcoming() {
    const now = Date.now();
    const all = data.upcoming.filter((v) => ok(v) && ms(v.sc) > now - H);
    const box = $("#upList");
    box.innerHTML = "";
    let curDay = "";
    let ol = null;
    for (const v of all.slice(0, shown.up)) {
      const label = dayLabel(ms(v.sc));
      if (label !== curDay) {
        curDay = label;
        const sec = el("div", "vt-day");
        sec.appendChild(el("h3", "vt-day-head", label));
        ol = el("ol", "vt-sched");
        sec.appendChild(ol);
        box.appendChild(sec);
      }
      const li = el("li", "vt-sched-item");
      const time = el("div", "vt-time");
      const left = el("span", "vt-until");
      left.dataset.sc = v.sc;
      time.append(el("span", "vt-time-hm", hm(v.sc)), left);
      tickUntil(left);
      const body = el("div", "vt-sched-body");
      const title = link(watchUrl(v.id), "vt-title", v.t);
      title.title = v.t;
      body.append(title, who(v.c));
      if (v.pr) body.appendChild(el("span", "vt-chip", "プレミア公開"));
      li.append(time, thumb(v.id, { size: "sm" }), body);
      ol.appendChild(li);
    }
    $("#upCount").textContent = ` ${all.length} 枠`;
    const empty = $("#upEmpty");
    empty.hidden = all.length > 0;
    empty.textContent = "条件に合う配信予定はいまありません。";
    const more = $("#upMore");
    more.hidden = all.length <= shown.up;
    more.textContent = `もっと見る（残り ${all.length - shown.up} 枠）`;
  }

  // ---------- 同接ランキング ----------
  function renderPeaks() {
    const list = (data.peaks?.[state.peakRange] || []).filter(ok).slice(0, 20);
    const box = $("#peakList");
    box.innerHTML = "";
    list.forEach((p, i) => {
      const li = el("li", `vt-rank-item${i < 3 ? ` top${i + 1}` : ""}`);
      const body = el("div", "vt-rank-body");
      const title = link(watchUrl(p.id), "vt-title", p.t);
      title.title = p.t;
      const meta = el("div", "vt-meta");
      meta.append(el("span", "", `${md(p.s)} ${hm(p.s)} 開始`), el("span", "", p.e ? `${elapsedBetween(p.s, p.e)}の配信` : ""));
      if (p.live) meta.prepend(el("span", "vt-chip live", "配信中"));
      body.append(title, who(p.c), meta);
      const val = el("div", "vt-rank-val");
      val.innerHTML = `<b>${jpNum(p.pk)}</b><span>人</span>`;
      li.append(el("span", "vt-rank-num", `${i + 1}`), thumb(p.id, { size: "sm", live: p.live }), body, val);
      box.appendChild(li);
    });
    const empty = $("#peakEmpty");
    empty.hidden = list.length > 0;
    empty.textContent = "まだ記録がありません。集計が進むと、配信中に観測した同時視聴者数が貯まっていきます。";
  }
  function elapsedBetween(a, b) {
    const m = Math.max(0, Math.round((ms(b) - ms(a)) / 60000));
    return m < 60 ? `${m}分` : `${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}`;
  }

  // ---------- 新着 ----------
  const KIND_LABEL = { stream: "配信アーカイブ", video: "動画", short: "ショート", premiere: "プレミア公開" };
  function renderRecent() {
    const sorts = {
      new: (a, b) => Math.max(ms(b.e), ms(b.p)) - Math.max(ms(a.e), ms(a.p)),
      vph: (a, b) => b.vph - a.vph,
      views: (a, b) => b.v - a.v,
    };
    const all = data.recent
      .filter((v) => ok(v) && (state.recentKind === "all" || v.k === state.recentKind || (state.recentKind === "video" && v.k === "premiere")))
      .sort(sorts[state.recentSort] || sorts.new);
    const box = $("#recentList");
    box.innerHTML = "";
    for (const v of all.slice(0, shown.recent)) {
      const li = el("li", "vt-row");
      const body = el("div", "vt-row-body");
      const title = link(watchUrl(v.id), "vt-title", v.t);
      title.title = v.t;
      const stats = el("div", "stats");
      const tag = (html, key) => {
        const s = el("span", `stat${key ? " key" : ""}`);
        s.innerHTML = html;
        stats.appendChild(s);
      };
      tag(`再生 <b>${jpNum(v.v)}</b>`, state.recentSort === "views");
      tag(`<b>+${jpNum(v.vph)}</b>/時`, state.recentSort === "vph");
      if (v.pk) tag(`最大同接 <b>${jpNum(v.pk)}</b>`);
      tag(v.k === "stream" && v.e ? `${rel(v.e)}に配信終了` : `${rel(v.p)}に公開`, state.recentSort === "new");
      tag(KIND_LABEL[v.k] || "動画");
      body.append(title, who(v.c), stats);
      li.append(thumb(v.id, { dur: v.d, short: v.k === "short" }), body);
      box.appendChild(li);
    }
    $("#recentCount").textContent = ` ${all.length} 本`;
    const empty = $("#recentEmpty");
    empty.hidden = all.length > 0;
    empty.textContent = "条件に合う動画はありません。";
    const more = $("#recentMore");
    more.hidden = all.length <= shown.recent;
    more.textContent = `もっと見る（残り ${all.length - shown.recent} 本）`;
  }

  // ---------- コラボ ----------
  function renderCollabs() {
    const list = (data.collabs || []).filter((v) => (chOk(v.c) || v.w.some(chOk)) && textOk(v.t, v.c)).slice(0, 12);
    const box = $("#collabList");
    box.innerHTML = "";
    for (const v of list) {
      const li = el("li", "vt-row");
      const body = el("div", "vt-row-body");
      const title = link(watchUrl(v.id), "vt-title", v.t);
      title.title = v.t;
      const w = el("div", "vt-with");
      w.appendChild(el("span", "vt-with-label", "一緒に："));
      for (const id of v.w) {
        const c = chById.get(id);
        if (!c) continue;
        const a = link(chUrl(c), "vt-with-name");
        a.append(avatar(c, 18), document.createTextNode(c.n));
        w.appendChild(a);
      }
      const st = el("span", `vt-chip${v.k === "live" ? " live" : ""}`, v.k === "live" ? "配信中" : v.k === "upcoming" ? `${dayLabel(ms(v.at)).replace(/ .*/, "")} ${hm(v.at)} から` : "アーカイブ");
      const metaRow = el("div", "vt-meta");
      metaRow.appendChild(st);
      body.append(title, who(v.c), w, metaRow);
      li.append(thumb(v.id, { live: v.k === "live" }), body);
      box.appendChild(li);
    }
    $("#collabSec").hidden = list.length === 0;
  }

  // ---------- 急上昇入り ----------
  const CAT_LABEL = { music: "音楽", gaming: "ゲーム", entertainment: "エンタメ", people: "ブログ", comedy: "お笑い", sports: "スポーツ", news: "ニュース", howto: "ハウツー", education: "教育", tech: "科学・技術", film: "映画・アニメ", autos: "車", pets: "ペット", travel: "旅行" };
  function renderTrending() {
    const list = (data.trending || []).filter(ok);
    const box = $("#trendList");
    box.innerHTML = "";
    for (const v of list.slice(0, 15)) {
      const li = el("li", "vt-row");
      const body = el("div", "vt-row-body");
      const title = link(watchUrl(v.id), "vt-title", v.t);
      title.title = v.t;
      const stats = el("div", "stats");
      const rank = el("span", "stat key");
      rank.innerHTML = v.r ? `総合 <b>${v.r}</b> 位` : `${CAT_LABEL[v.cat] || v.cat} <b>${v.cr}</b> 位`;
      const views = el("span", "stat");
      views.innerHTML = `再生 <b>${jpNum(v.v)}</b>`;
      stats.append(rank, views);
      body.append(title, who(v.c), stats);
      li.append(thumb(v.id), body);
      box.appendChild(li);
    }
    $("#trendEmpty").hidden = list.length > 0;
  }

  // ---------- 右カラム ----------
  const tip = $("#tip");
  function showTip(html, x, y) {
    tip.innerHTML = html;
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x + 14));
    const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }
  const hideTip = () => (tip.hidden = true);

  // 横棒。色は量の比較なので 1 色に揃え、事務所は名前の横の点と文字で示す
  function bars(box, rows, { onClick } = {}) {
    box.innerHTML = "";
    const max = Math.max(1, ...rows.map((r) => r.value));
    for (const r of rows) {
      const li = el("li", `vt-bar${r.active ? " active" : ""}${onClick ? " clickable" : ""}`);
      const label = el("span", "vt-bar-label");
      if (r.color) {
        const dot = el("span", "vt-tab-dot");
        dot.style.background = r.color;
        label.appendChild(dot);
      }
      label.appendChild(document.createTextNode(r.label));
      const track = el("span", "vt-bar-track");
      const fill = el("span", "vt-bar-fill");
      fill.style.width = `${r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%`;
      track.appendChild(fill);
      li.append(label, track, el("span", "vt-bar-val", r.text));
      if (r.tip) {
        li.addEventListener("pointermove", (e) => showTip(r.tip, e.clientX, e.clientY));
        li.addEventListener("pointerleave", hideTip);
      }
      if (onClick) {
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.addEventListener("click", () => onClick(r));
        li.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onClick(r)));
      }
      box.appendChild(li);
    }
  }

  function renderAgencyBars() {
    const metric = state.agencyMetric;
    const rows = data.agencies.map((a) => ({
      id: a.id,
      label: a.label,
      color: a.color,
      value: metric === "live" ? a.live : a.viewers,
      text: metric === "live" ? `${a.live} 枠` : `${jpNum(a.viewers)} 人`,
      active: state.ag === a.id,
      tip: `<b>${a.label}</b><br>配信中 ${a.live} 枠・${jpNum(a.viewers)} 人が視聴中<br>24 時間以内の予定 ${a.upcoming24} 枠<br>タレント ${a.talents} 人・登録者 合計 ${jpNum(a.subs)}`,
    }));
    rows.sort((x, y) => y.value - x.value);
    bars($("#agencyBars"), rows, { onClick: (r) => set({ ag: state.ag === r.id ? "all" : r.id }) });
  }

  function renderGenreBars() {
    const rows = (data.genres || []).map((g) => ({
      id: g.id,
      label: g.label,
      value: g.all,
      text: `${g.all} 枠`,
      active: state.genre === g.id,
      tip: `<b>${g.label}</b><br>配信中 ${g.live} 枠・24 時間で ${g.all} 枠`,
    }));
    bars($("#genreBars"), rows, {
      onClick: (r) => {
        set({ genre: state.genre === r.id ? "all" : r.id }, false);
        document.getElementById("live").scrollIntoView({ behavior: "smooth" });
      },
    });
    $("#genreMod").hidden = rows.length === 0;
  }

  // 48 時間の推移。1 系列なので凡例は付けず、見出しで何の線かを示す
  function renderTimeline() {
    const box = $("#timelineChart");
    box.innerHTML = "";
    const metric = state.timelineMetric;
    const ag = state.ag !== "all" && state.ag !== "oshi" ? state.ag : "";
    const pts = (data.timeline || []).map((p) => ({ t: ms(p.t), y: ag ? (p.a?.[ag]?.[metric === "n" ? 0 : 1] || 0) : p[metric] || 0, n: ag ? p.a?.[ag]?.[0] || 0 : p.n, v: ag ? p.a?.[ag]?.[1] || 0 : p.v }));
    $("#timelineHead").textContent = `${metric === "n" ? "配信中の枠数" : "同時視聴者数"}の推移${ag ? `（${agencyById.get(ag)?.label}）` : ""}`;
    $("#timelineMod").hidden = pts.length < 3;
    if (pts.length < 3) return;
    const W = 300;
    const Ht = 150;
    const m = { l: 34, r: 8, t: 10, b: 22 };
    const x0 = pts[0].t;
    const x1 = pts[pts.length - 1].t;
    const maxY = niceMax(Math.max(1, ...pts.map((p) => p.y)));
    const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r);
    const Y = (y) => m.t + (1 - y / maxY) * (Ht - m.t - m.b);
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${Ht}`);
    svg.setAttribute("class", "vt-svg");
    svg.setAttribute("role", "img");
    const last = pts[pts.length - 1];
    svg.setAttribute("aria-label", `直近 ${Math.round((x1 - x0) / H)} 時間の${metric === "n" ? "配信中の枠数" : "合計の同時視聴者数"}。いまは ${metric === "n" ? `${last.y} 枠` : `${jpNum(last.y)} 人`}`);
    const mk = (tag, attrs) => {
      const e = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      return e;
    };
    // 目盛り（0・半分・最大）
    for (const f of [0, 0.5, 1]) {
      const y = Y(maxY * f);
      svg.appendChild(mk("line", { x1: m.l, x2: W - m.r, y1: y, y2: y, class: f === 0 ? "vt-axis" : "vt-grid" }));
      const lb = mk("text", { x: m.l - 5, y: y + 3.5, class: "vt-tick", "text-anchor": "end" });
      lb.textContent = metric === "n" ? `${Math.round(maxY * f)}` : jpNum(Math.round(maxY * f));
      svg.appendChild(lb);
    }
    // 日本時間の 0 時・12 時に縦の目印
    const step = 6 * H;
    for (let t = Math.ceil(x0 / step) * step; t <= x1; t += step) {
      const d = new Date(t);
      if (d.getHours() % 12 !== 0) continue;
      const x = X(t);
      svg.appendChild(mk("line", { x1: x, x2: x, y1: m.t, y2: Ht - m.b, class: "vt-grid" }));
      const lb = mk("text", { x, y: Ht - 7, class: "vt-tick", "text-anchor": "middle" });
      lb.textContent = d.getHours() === 0 ? `${d.getMonth() + 1}/${d.getDate()}` : "12時";
      svg.appendChild(lb);
    }
    const line = pts.map((p) => `${X(p.t).toFixed(1)},${Y(p.y).toFixed(1)}`).join(" ");
    svg.appendChild(mk("polygon", { points: `${X(x0)},${Y(0)} ${line} ${X(x1)},${Y(0)}`, class: "vt-area" }));
    svg.appendChild(mk("polyline", { points: line, class: "vt-line" }));
    svg.appendChild(mk("circle", { cx: X(last.t), cy: Y(last.y), r: 4, class: "vt-dot" }));
    // ホバー: 縦線と点、ツールチップ
    const cross = mk("line", { x1: 0, x2: 0, y1: m.t, y2: Ht - m.b, class: "vt-cross", visibility: "hidden" });
    const hover = mk("circle", { cx: 0, cy: 0, r: 4, class: "vt-dot hover", visibility: "hidden" });
    svg.append(cross, hover);
    const hit = mk("rect", { x: m.l, y: 0, width: W - m.l - m.r, height: Ht, fill: "transparent" });
    svg.appendChild(hit);
    hit.addEventListener("pointermove", (e) => {
      const r = svg.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * W;
      let best = pts[0];
      for (const p of pts) if (Math.abs(X(p.t) - px) < Math.abs(X(best.t) - px)) best = p;
      const x = X(best.t);
      cross.setAttribute("x1", x);
      cross.setAttribute("x2", x);
      cross.setAttribute("visibility", "visible");
      hover.setAttribute("cx", x);
      hover.setAttribute("cy", Y(best.y));
      hover.setAttribute("visibility", "visible");
      showTip(`<b>${md(new Date(best.t).toISOString())} ${hm(new Date(best.t).toISOString())}</b><br>配信中 ${best.n} 枠<br>合計 ${jpNum(best.v)} 人が視聴`, e.clientX, e.clientY);
    });
    hit.addEventListener("pointerleave", () => {
      cross.setAttribute("visibility", "hidden");
      hover.setAttribute("visibility", "hidden");
      hideTip();
    });
    box.appendChild(svg);
    const peak = pts.reduce((a, b) => (b.y > a.y ? b : a));
    $("#timelineDesc").textContent = `いま ${metric === "n" ? `${last.y} 枠` : `${jpNum(last.y)} 人`}・この期間の最大は ${md(new Date(peak.t).toISOString())} ${hm(new Date(peak.t).toISOString())} の ${metric === "n" ? `${peak.y} 枠` : `${jpNum(peak.y)} 人`}`;
  }
  function niceMax(v) {
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    for (const f of [1, 2, 2.5, 5, 10]) if (v <= f * p) return f * p;
    return 10 * p;
  }

  function renderClouds() {
    const cloud = (box, list, prefix) => {
      box.innerHTML = "";
      for (const w of list) {
        const b = el("button", `kw${w.live ? " live" : ""}`);
        b.type = "button";
        b.title = `${w.n} 本の配信（${w.ch || w.n} チャンネル）${w.live ? `・いま ${w.live} 枠が配信中` : ""}`;
        b.append(document.createTextNode(`${prefix}${w.w}`), el("span", "n", `${w.n}`));
        b.addEventListener("click", () => {
          $("#q").value = w.w;
          set({ q: w.w });
          document.getElementById("live").scrollIntoView({ behavior: "smooth" });
        });
        box.appendChild(b);
      }
    };
    cloud($("#gameCloud"), data.words?.games || [], "");
    cloud($("#tagCloud"), data.words?.tags || [], "#");
    $("#gameMod").hidden = !(data.words?.games || []).length;
    $("#tagMod").hidden = !(data.words?.tags || []).length;
  }

  function renderMilestones() {
    const tab = state.milestoneTab;
    const list = (data.milestones?.[tab] || []).filter((m) => chOk(m.c)).slice(0, 10);
    const box = $("#milestoneList");
    box.innerHTML = "";
    for (const m of list) {
      const c = chById.get(m.c);
      if (!c) continue;
      const li = el("li", "vt-mini-item");
      const a = link(chUrl(c), "vt-mini-link");
      const text = el("div", "vt-mini-text");
      text.appendChild(el("div", "vt-mini-name", c.n));
      if (tab === "near") {
        text.appendChild(el("div", "vt-mini-sub", `${jpNum(m.next)}人まで あと ${jpNum(m.next - m.s)}${m.eta ? `（このペースで約 ${m.eta} 日）` : ""}`));
      } else {
        text.appendChild(el("div", "vt-mini-sub", `${jpNum(m.th)}人を突破（いま ${jpNum(m.s)}）`));
      }
      a.append(avatar(c, 28), text);
      li.append(a, agencyBadge(c.a));
      box.appendChild(li);
    }
    const empty = $("#milestoneEmpty");
    empty.hidden = list.length > 0;
    empty.textContent = tab === "near" ? "大台の目前にいるタレントはいません。" : "この 1 週間で大台に届いたタレントはいません（登録者数の記録が 1 週間分たまると出ます）。";
  }

  // ---------- 記念日 ----------
  function nextOccurrence(mmdd, from) {
    const [m, d] = mmdd.split("-").map(Number);
    let t = new Date(from.getFullYear(), m - 1, d);
    if (t < from) t = new Date(from.getFullYear() + 1, m - 1, d);
    return t;
  }
  function renderAnniv() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const people = (data.people || []).filter((p) => chOk(p.c) && textOk("", p.c));
    const within = (t) => Math.round((t - today) / DAY);
    const bdays = people
      .filter((p) => p.b)
      .map((p) => ({ p, t: nextOccurrence(p.b, today) }))
      .filter((x) => within(x.t) <= 6)
      .sort((a, b) => a.t - b.t);
    const debuts = people
      .filter((p) => p.d && p.d.slice(0, 4) < String(today.getFullYear() + 1))
      .map((p) => {
        const t = nextOccurrence(p.d.slice(5), today);
        return { p, t, years: t.getFullYear() - Number(p.d.slice(0, 4)) };
      })
      .filter((x) => x.years >= 1 && within(x.t) <= 6)
      .sort((a, b) => a.t - b.t || b.years - a.years);
    const rookies = people
      .filter((p) => p.d)
      .map((p) => ({ p, t: new Date(`${p.d}T00:00:00`) }))
      .filter((x) => x.t <= new Date(today.getTime() + 14 * DAY) && today - x.t <= 90 * DAY)
      .sort((a, b) => b.t - a.t);

    const fill = (box, rows, render, emptyText) => {
      box.innerHTML = "";
      for (const r of rows.slice(0, 16)) box.appendChild(render(r));
      if (!rows.length) box.appendChild(el("li", "vt-anniv-empty", emptyText));
    };
    const row = (p, when, what, isToday) => {
      const c = chById.get(p.c) || { id: p.c, n: p.n, a: p.a };
      const li = el("li", `vt-anniv-item${isToday ? " today" : ""}`);
      const a = link(chUrl(c), "vt-anniv-link");
      const text = el("div", "vt-mini-text");
      text.append(el("div", "vt-mini-name", p.n), el("div", "vt-mini-sub", what));
      a.append(avatar({ ...c, n: p.n }, 30), text);
      li.append(el("span", "vt-anniv-when", when), a, agencyBadge(p.a));
      return li;
    };
    const whenLabel = (t) => {
      const n = within(t);
      return n === 0 ? "今日" : n === 1 ? "明日" : `${t.getMonth() + 1}/${t.getDate()}`;
    };
    fill($("#birthdayList"), bdays, (x) => row(x.p, whenLabel(x.t), `${x.t.getMonth() + 1}月${x.t.getDate()}日 生まれ`, within(x.t) === 0), "1 週間以内の誕生日はありません。");
    fill($("#debutList"), debuts, (x) => row(x.p, whenLabel(x.t), `デビュー ${x.years} 周年（${x.p.d.replace(/-/g, "/")}）`, within(x.t) === 0), "1 週間以内のデビュー記念日はありません。");
    fill(
      $("#rookieList"),
      rookies,
      (x) => row(x.p, x.t > today ? "予定" : `${Math.max(0, Math.round((today - x.t) / DAY))}日目`, `${x.p.d.replace(/-/g, "/")} デビュー${x.t > today ? "予定" : ""}`, false),
      "90 日以内にデビューしたタレントはいません。"
    );
  }

  // ---------- 登録者数ランキング ----------
  function renderSubs() {
    const key = state.subSort;
    const all = data.channels
      .filter((c) => !c.off && c.s && chOk(c.id) && textOk("", c.id))
      .filter((c) => key === "s" || c[key] != null)
      .sort((a, b) => (b[key] ?? -Infinity) - (a[key] ?? -Infinity) || b.s - a.s);
    const box = $("#subList");
    box.innerHTML = "";
    all.slice(0, shown.sub).forEach((c, i) => {
      const li = el("li", `vt-sub-item${i < 3 ? ` top${i + 1}` : ""}`);
      const a = link(chUrl(c), "vt-sub-link");
      const text = el("div", "vt-mini-text");
      text.append(el("div", "vt-mini-name", c.n), el("div", "vt-mini-sub", [agencyById.get(c.a)?.label, c.u].filter(Boolean).join(" ・ ")));
      a.append(avatar(c, 34), text);
      const nums = el("div", "vt-sub-nums");
      const cell = (label, v, k) => {
        const s = el("span", `vt-sub-cell${k === key ? " key" : ""}${v != null && v < 0 ? " neg" : ""}`);
        s.append(el("span", "vt-sub-cell-l", label), el("b", "", k === "s" ? jpNum(v) : signed(v)));
        nums.appendChild(s);
      };
      cell("登録者", c.s, "s");
      cell("1日", c.d1, "d1");
      cell("7日", c.d7, "d7");
      cell("30日", c.d30, "d30");
      li.append(el("span", "vt-rank-num", `${i + 1}`), a, nums, oshiButton(c, true));
      box.appendChild(li);
    });
    if (!all.length) box.appendChild(el("li", "vt-anniv-empty", key === "s" ? "条件に合うタレントがいません。" : "登録者数の記録がたまると、伸びのランキングが出ます。"));
    const more = $("#subMore");
    more.hidden = all.length <= shown.sub;
    more.textContent = `もっと見る（残り ${all.length - shown.sub} 人）`;
  }

  // ---------- タレント名鑑 ----------
  function renderDirectory() {
    const debutOf = new Map();
    for (const p of data.people || []) if (p.d && (!debutOf.has(p.c) || p.d > debutOf.get(p.c))) debutOf.set(p.c, p.d);
    const rankSt = (c) => (c.st === "live" ? 0 : c.st === "upcoming" ? 1 : c.next ? 2 : 3);
    const sorts = {
      status: (a, b) => rankSt(a) - rankSt(b) || ms(a.next) - ms(b.next) || ms(b.last) - ms(a.last) || b.s - a.s,
      subs: (a, b) => b.s - a.s,
      name: (a, b) => a.n.localeCompare(b.n, "ja"),
      debut: (a, b) => (debutOf.get(b.id) || "").localeCompare(debutOf.get(a.id) || ""),
    };
    const all = data.channels.filter((c) => !c.off && chOk(c.id) && textOk("", c.id)).sort(sorts[state.dirSort] || sorts.status);
    const liveById = new Map(data.live.map((v) => [v.c, v]));
    const box = $("#dirList");
    box.innerHTML = "";
    for (const c of all.slice(0, shown.dir)) {
      const li = el("li", `vt-dir-item${c.st ? ` ${c.st}` : ""}`);
      const head = el("div", "vt-dir-head");
      const a = link(chUrl(c), "vt-dir-link");
      const text = el("div", "vt-mini-text");
      text.appendChild(el("div", "vt-mini-name", c.n));
      const sub = [c.en, c.yt && c.yt !== c.en ? c.yt : ""].filter(Boolean)[0];
      if (sub) text.appendChild(el("div", "vt-mini-sub", sub));
      a.append(avatar(c, 40), text);
      head.append(a, oshiButton(c));
      const tags = el("div", "vt-dir-tags");
      tags.appendChild(agencyBadge(c.a));
      if (c.u) tags.appendChild(el("span", "vt-chip", c.u));
      const status = el("div", "vt-dir-status");
      const lv = liveById.get(c.id);
      if (lv) {
        const s = link(watchUrl(lv.id), "vt-chip live", `配信中・${jpNum(lv.cv)}人`);
        s.title = lv.t;
        status.appendChild(s);
      } else if (c.next) status.appendChild(el("span", `vt-chip${c.st === "upcoming" ? " soon" : ""}`, `次の配信 ${md(c.next)} ${hm(c.next)}`));
      if (c.last && !lv) status.appendChild(el("span", "vt-dir-last", `最後の配信 ${rel(c.last)}`));
      const nums = el("div", "vt-dir-nums");
      nums.innerHTML = `登録者 <b>${jpNum(c.s)}</b>${c.d7 ? ` ・ 7日 ${signed(c.d7)}` : ""}${c.fan ? ` ・ ファン「${escapeHtml(c.fan)}」` : ""}`;
      li.append(head, tags, status, nums);
      if (c.page) {
        const p = link(c.page, "vt-dir-page", "公式プロフィール");
        li.appendChild(p);
      }
      box.appendChild(li);
    }
    $("#dirCount").textContent = ` ${all.length} 人`;
    if (!all.length) box.appendChild(el("li", "vt-anniv-empty", state.ag === "oshi" ? "推しはまだいません。☆ を押すと登録できます。" : "条件に合うタレントがいません。"));
    const more = $("#dirMore");
    more.hidden = all.length <= shown.dir;
    more.textContent = `もっと見る（残り ${all.length - shown.dir} 人）`;
  }
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  // ---------- まとめて描く ----------
  function syncSegs() {
    for (const [id, key] of [["#liveSort", "liveSort"], ["#peakRange", "peakRange"], ["#recentSort", "recentSort"], ["#recentKind", "recentKind"], ["#subSort", "subSort"], ["#dirSort", "dirSort"], ["#agencyMetric", "agencyMetric"], ["#timelineMetric", "timelineMetric"], ["#milestoneTab", "milestoneTab"]]) {
      for (const b of document.querySelectorAll(`${id} button`)) b.classList.toggle("active", b.dataset.v === state[key]);
    }
  }

  function renderAll() {
    $("#sampleNotice").hidden = !data.isSample;
    const ids = new Set(["all", "oshi", ...data.agencies.map((a) => a.id)]);
    if (!ids.has(state.ag)) state.ag = "all";
    syncSegs();
    renderTabs();
    renderHero();
    renderGenreChips();
    renderLive();
    renderUpcoming();
    renderPeaks();
    renderRecent();
    renderCollabs();
    renderTrending();
    renderAgencyBars();
    renderTimeline();
    renderClouds();
    renderGenreBars();
    renderMilestones();
    renderAnniv();
    renderSubs();
    renderDirectory();
    const label = scopeLabel();
    document.title = `${label ? `${label}の配信｜` : ""}VTuber 配信ウォッチ｜急上昇動画ウォッチャー`;
    $("#about").textContent = `名簿は各事務所の公式サイトから 1 週間おきに作り直しています（最終更新 ${data.rosterAt ? md(data.rosterAt) : "—"}）。配信の状態は 30 分おきに YouTube から集めています。`;
  }

  function set(patch, resetPaging = true) {
    Object.assign(state, patch);
    if (resetPaging) Object.assign(shown, PAGE);
    store(STATE_KEY, { ...state, q: "" });
    if ("ag" in patch) {
      const u = new URL(location.href);
      if (state.ag === "all" || state.ag === "oshi") u.searchParams.delete("ag");
      else u.searchParams.set("ag", state.ag);
      history.replaceState(null, "", u);
    }
    renderAll();
  }

  // ---------- 起動 ----------
  async function boot() {
    $("#year").textContent = new Date().getFullYear();
    try {
      const r = await fetch(`../data/vtuber.json?t=${Math.floor(Date.now() / 300000)}`);
      data = await r.json();
    } catch {
      $("#liveLoading").hidden = true;
      $("#liveEmpty").hidden = false;
      $("#liveEmpty").textContent = "データを読み込めませんでした。時間をおいて開き直してください。";
      return;
    }
    index();
    renderAll();
    setInterval(() => {
      renderHero();
      renderUpcomingTimes();
    }, 60000);
    setInterval(checkNewData, 3 * 60000);
    document.addEventListener("visibilitychange", () => !document.hidden && checkNewData());
  }
  function index() {
    chById = new Map(data.channels.map((c) => [c.id, c]));
    agencyById = new Map(data.agencies.map((a) => [a.id, a]));
  }
  // 「あと○分」だけを書き直す（一覧を作り直すと、スクロール中に位置がずれるため）
  function tickUntil(e) {
    const t = ms(e.dataset.sc) - Date.now();
    e.textContent = until(e.dataset.sc);
    e.className = `vt-until${t < 0 ? " late" : t < H ? " soon" : ""}`;
  }
  function renderUpcomingTimes() {
    for (const e of document.querySelectorAll("#upList .vt-until[data-sc]")) tickUntil(e);
  }

  let pending = null;
  async function checkNewData() {
    if (document.hidden || pending || !data) return;
    try {
      const r = await fetch(`../data/vtuber.json?t=${Date.now()}`, { cache: "no-store" });
      const next = await r.json();
      if (next.updatedAt && ms(next.updatedAt) > ms(data.updatedAt)) {
        pending = next;
        $("#newData").hidden = false;
      }
    } catch {
      /* 次の確認でまた試す */
    }
  }
  $("#newData").addEventListener("click", () => {
    if (!pending) return;
    data = pending;
    pending = null;
    $("#newData").hidden = true;
    index();
    renderAll();
  });

  // ---------- イベント ----------
  $("#q").value = state.q;
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
  for (const [id, key, paging] of [["#liveSort", "liveSort", true], ["#peakRange", "peakRange", false], ["#recentSort", "recentSort", true], ["#recentKind", "recentKind", true], ["#subSort", "subSort", true], ["#dirSort", "dirSort", true], ["#agencyMetric", "agencyMetric", false], ["#timelineMetric", "timelineMetric", false], ["#milestoneTab", "milestoneTab", false]]) {
    for (const b of document.querySelectorAll(`${id} button`)) b.addEventListener("click", () => set({ [key]: b.dataset.v }, paging));
  }
  for (const [id, key, fn] of [["#liveMore", "live", renderLive], ["#upMore", "up", renderUpcoming], ["#recentMore", "recent", renderRecent], ["#subMore", "sub", renderSubs], ["#dirMore", "dir", renderDirectory]]) {
    $(id).addEventListener("click", () => {
      shown[key] += PAGE[key];
      fn();
    });
  }
  $("#shareX").addEventListener("click", () => {
    const s = data?.summary;
    const text = s ? `VTuber 配信ウォッチ｜いま ${s.live} 枠が配信中・合計 ${jpNum(s.viewers)} 人が視聴中` : "VTuber 配信ウォッチ";
    const url = new URL(location.href);
    url.hash = "";
    const w = 600;
    const h = 480;
    const left = Math.round((window.screen.width - w) / 2);
    const top = Math.round((window.screen.height - h) / 2);
    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url.toString())}`, "share", `width=${w},height=${h},left=${left},top=${top},noopener,noreferrer`);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== $("#q")) {
      e.preventDefault();
      $("#q").focus();
    }
    if (e.key === "Escape") hideTip();
  });
  const toTop = $("#toTop");
  const onScroll = () => (toTop.hidden = window.scrollY < 500);
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  toTop.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

  boot();
})();
