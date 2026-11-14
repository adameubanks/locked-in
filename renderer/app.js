/* ============================================================
   LOCKED IN — study environment for ACME Vol 3 & Vol 4
   ============================================================ */

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/* ---------------- state ---------------- */
const DEFAULT_STATE = {
  lastPos: null,           // {vol, page} of reader 0
  lastPos2: null,          // {vol, page} of reader 1
  prefs: { dim: true, zoom: 1.0, splitPct: 58, split: false, focusMode: "ember" }
};
let S = JSON.parse(JSON.stringify(DEFAULT_STATE));
let MANIFEST = null;
let CHAPTERS = {};


let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { window.api.setState(S).catch(() => {}); }, 400);
}

/* ---------------- content helpers ---------------- */
/* Any PDF opened from disk is a volume too, with no chapters: "file:" + its path.
   Made on first sight, so a restored lastPos brings it back. */
function volOf(id) {
  let v = MANIFEST.volumes.find(v => v.id === id);
  if (!v && /^file:/.test(id)) {
    MANIFEST.volumes.push(v = { id, pdf: id.slice(5), short: id.split("/").pop().replace(/\.pdf$/i, ""), pageOffset: 0, chapters: [] });
  }
  return v;
}
function loadedChapters() { return Object.values(CHAPTERS); }
function withCh(c, ch) { return Object.assign({}, c, { vol: ch.volume }); }


/* Flattened once and kept: sectionForBookPage runs on every scroll tick and
   per find hit, and rebuilding this list was the bulk of that work.
   Chapters all load during boot and nothing adds one later. */
let SECS = null;
function sectionsOf(volId) {
  if (!SECS) {
    const chs = loadedChapters();
    if (!chs.length) return [];
    SECS = {};
    chs.forEach(ch => { (SECS[ch.volume] = SECS[ch.volume] || []).push(...ch.sections); });
  }
  return SECS[volId] || [];
}
function sectionForBookPage(volId, p) {
  return sectionsOf(volId).find(s => p >= s.from && p <= s.to) || null;
}
/* Exercise groups are pinned by (page, y) marks; pick the last group whose
   start is at or above the current spot so the exercises pane and the section
   stay paired while you scroll either side. */
function posKey(page, y) { return page + Math.max(0, Math.min(1, y || 0)); }
function sectionForExercisePos(volId, page, y) {
  const secs = sectionsOf(volId).filter(s => s.exFrom);
  if (!secs.length) return null;
  const at = posKey(page, y);
  let hit = null;
  for (const s of secs) {
    if (posKey(s.exFrom.page, s.exFrom.y) <= at + 1e-6) hit = s;
  }
  const last = secs[secs.length - 1];
  if (last.exTo && at > posKey(last.exTo.page, last.exTo.y) + 1e-6) return null;
  return hit;
}
function chapterForBookPage(volId, p) {
  return loadedChapters().find(c => c.volume === volId &&
    ((c.sections.length && p >= c.sections[0].from && p <= c.sections[c.sections.length - 1].to) ||
     (c.exercises && p >= c.exercises.from && p <= c.exercises.to)));
}
function chapterOfSection(volId, secId) {
  return loadedChapters().find(c => c.volume === volId && c.sections.some(s => s.id === secId));
}


function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/* ============================================================
   READER — one PDF viewer. Two of these can run side by side so
   the exercises and the definitions they need are visible at once.
   ============================================================ */
pdfjsLib.GlobalWorkerOptions.workerSrc = "../vendor/pdf.worker.js";

const READERS = [];
let docCache = {};       // volId -> { doc, size, mtimeMs }

class Reader {
  constructor(index, hostSel) {
    this.i = index;
    this.hostSel = hostSel || "#readers";
    // The exercises pane is narrow, so scale to the text column and let the
    // page margins clip rather than shrinking the type to fit them.
    this.cropFrac = index === 1 ? 0.70 : 1;
    this.doc = null;
    this.vol = null;
    this.pageEls = [];
    this.jobs = new Map();     // page -> in-flight/finished draw, so a jump can await one
    this.tl = new Map();       // page -> text layer bookkeeping, for find highlights
    this.cur = 1;
    this.zoom = 1.0;
    this.base = 1.0;
    this.io = null;
    this.build();
  }

  build() {
    const el = document.createElement("div");
    el.className = "reader";
    el.dataset.r = this.i;
    el.innerHTML = `
      <div class="rtoolbar">
        <button class="tb pg-prev" title="Previous page">&#8249;</button>
        <span class="pgbox"><input class="pg-input" type="text" inputmode="numeric" value="1"><span class="pg-total">/ &mdash;</span></span>
        <button class="tb pg-next" title="Next page">&#8250;</button>
        <span class="tb-sep"></span>
        <button class="tb zoom-out" title="Zoom out">&minus;</button>
        <span class="zoom-lvl">100%</span>
        <button class="tb zoom-in" title="Zoom in">+</button>
        <span class="rlabel-tag"></span>
      </div>
      <div class="rscroll"><div class="rpages"></div></div>`;
    $(this.hostSel).appendChild(el);
    this.el = el;
    this.scroll = $(".rscroll", el);
    this.pages = $(".rpages", el);

    $(".pg-prev", el).onclick = () => this.goto(this.cur - 1);
    $(".pg-next", el).onclick = () => this.goto(this.cur + 1);
    $(".zoom-in", el).onclick = () => this.setZoom(this.zoom + 0.15);
    $(".zoom-out", el).onclick = () => this.setZoom(this.zoom - 0.15);
    $(".pg-input", el).onkeydown = e => {
      if (e.key !== "Enter") return;
      const b = parseInt(e.target.value, 10);
      if (!isNaN(b)) this.gotoBook(b);
      e.target.blur();
    };
    el.addEventListener("mousedown", () => { ACTIVE = this.i; });
    this.scroll.addEventListener("wheel", () => { this.want = null; }, { passive: true });
    this.scroll.onscroll = () => {
      clearTimeout(this._st);
      this._st = setTimeout(() => this.dominant(), 90);
      // Keep soft exercise-follow from firing mid-scroll (e.g. peeking at the
      // end of the previous section on a chapter-start page).
      if (pendingFollow) armExFollow();
    };
  }

  async open(volId, gotoPage) {
    const v = volOf(volId);
    if (!v) return;
    this.vol = v;
    if (this.i === 0) {
      // only an ACME volume has a study pane to show
      document.body.classList.toggle("solo", !v.chapters.length);
      S.recent = [volId, ...(S.recent || []).filter(x => x !== volId)].slice(0, 30);
      this.zoom = (S.zooms && S.zooms[volId]) || S.prefs.zoom || 1;
      $(".zoom-lvl", this.el).textContent = Math.round(this.zoom * 100) + "%";
      libRender();
    }
    this.pages.innerHTML = "";
    this.pageEls = []; this.jobs = new Map(); this.tl = new Map();
    if (this.io) { this.io.disconnect(); this.io = null; }

    const st = await window.api.pdfStat(v.pdf);
    const cached = docCache[volId];
    if (!cached || !st || cached.size !== st.size || cached.mtimeMs !== st.mtimeMs) {
      if (!(await window.api.pdfCheck(v.pdf))) {
        this.pages.innerHTML =
          `<div class="empty"><h3>Can't find the PDF</h3>
           <p>Expected <span class="mono" style="font-size:12px">${esc(v.pdf)}</span>.
           Put the PDF there or fix the path in <span class="mono" style="font-size:12px">content/manifest.json</span>.</p></div>`;
        return;
      }
      try {
        const buf = await window.api.pdfRead(v.pdf);
        const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
        docCache[volId] = { doc, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
      } catch (e) {
        this.pages.innerHTML = `<div class="empty"><h3>Failed to open the PDF</h3></div>`;
        return;
      }
    }
    this.doc = docCache[volId].doc;
    $(".pg-total", this.el).textContent = "/ " + this.doc.numPages;

    const p1 = await this.doc.getPage(1);
    const vp1 = p1.getViewport({ scale: 1 });
    this.vp1w = vp1.width; this.vp1h = vp1.height;
    this.base = Math.max(0.4, Math.min(3.0, (this.scroll.clientWidth - 52) / (vp1.width * this.cropFrac)));

    for (let i = 1; i <= this.doc.numPages; i++) {
      const d = document.createElement("div");
      d.className = "pg";
      d.dataset.page = i;
      const s = this.base * this.zoom;
      d.style.width = Math.round(vp1.width * s) + "px";
      d.style.height = Math.round(vp1.height * s) + "px";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = this.label(i);
      d.appendChild(num);
      this.pages.appendChild(d);
      this.pageEls.push(d);
    }

    this.io = new IntersectionObserver(en => {
      en.forEach(e => { if (e.isIntersecting) this.render(+e.target.dataset.page); });
    }, { root: this.scroll, rootMargin: "500px 0px", threshold: 0 });
    this.pageEls.forEach(e => this.io.observe(e));

    const saved = this.i === 0 ? S.lastPos : S.lastPos2;
    const start = gotoPage || (this.i === 0 && S.pages && S.pages[volId]) || (saved && saved.vol === volId ? saved.page : 1);
    this.goto(start, true);
  }

  label(pdfPage) {
    if (!this.vol) return String(pdfPage);
    const b = pdfPage - (this.vol.pageOffset || 0);
    return b >= 1 ? String(b) : "–";
  }

  /* One draw per page, kept as a promise: landing on a find hit has to wait
     for the page it is on, and the observer may already be drawing it. */
  render(n) {
    if (!this.doc || !this.pageEls[n - 1]) return Promise.resolve();
    let job = this.jobs.get(n);
    if (!job) this.jobs.set(n, job = this.draw(n).catch(() => this.jobs.delete(n)));
    return job;
  }

  async draw(n) {
    const host = this.pageEls[n - 1], v = this.vol;
    const page = await this.doc.getPage(n);
    const vp = page.getViewport({ scale: this.base * this.zoom });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width * dpr);
    canvas.height = Math.round(vp.height * dpr);
    canvas.style.width = Math.round(vp.width) + "px";
    canvas.style.height = Math.round(vp.height) + "px";
    const c = canvas.getContext("2d", { alpha: false });
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    host.insertBefore(canvas, host.firstChild);
    await page.render({ canvasContext: c, viewport: vp }).promise;

    const tl = document.createElement("div");
    tl.className = "textLayer";
    tl.style.width = Math.round(vp.width) + "px";
    tl.style.height = Math.round(vp.height) + "px";
    host.appendChild(tl);
    // Set after insertion (pdf.js reads it via getComputedStyle, which is
    // empty for a detached node) and taken from vp.scale rather than
    // recomputed, since fit() can change base during the await below.
    tl.style.setProperty("--scale-factor", String(vp.scale));
    const tc = await page.getTextContent();
    const divs = [];
    await pdfjsLib.renderTextLayer({ textContentSource: tc, container: tl, viewport: vp, textDivs: divs }).promise;
    if (this.vol !== v) return;          // the volume changed under this draw

    const hl = document.createElement("div");
    hl.className = "hlLayer";
    host.appendChild(hl);
    const m = pageMap(tc, v);
    this.tl.set(n, { hl, divs, low: m.low, mk: m.mk, mj: m.mj });
    this.paintFind(n);
  }

  /* A hit is a character offset in the page's text; the map turns that back
     into text layer spans, and the browser measures them for us.

     One box per line, not per span: a word runs through several spans (pdf.js
     splits at every kern, and reports some of them twice), and a box each
     leaves a notch wherever two abut and doubles the tint wherever they
     overlap. Same line if a rectangle's middle falls inside one already
     collected — that is what puts a mended hyphen on two boxes. */
  boxesFor(n, from, to, m = this.tl.get(n)) {
    const L = this.tl.get(n);
    if (!L || !m || to <= from) return [];
    const rows = [];
    const add = q => {
      if (q.width < 0.5 || q.height < 0.5) return;
      const mid = q.top + q.height / 2;
      const row = rows.find(w => mid > w.top && mid < w.bottom);
      if (!row) { rows.push({ top: q.top, bottom: q.bottom, left: q.left, right: q.right }); return; }
      row.top = Math.min(row.top, q.top);
      row.bottom = Math.max(row.bottom, q.bottom);
      row.left = Math.min(row.left, q.left);
      row.right = Math.max(row.right, q.right);
    };
    // One range per run of consecutive glyphs in a single span. A range that
    // jumps from span A to span B also covers every span between them in the
    // text layer — subscripts, footnote marks, empty EOL nodes — and the box
    // swallows them.
    try {
      for (let i = from; i < to; ) {
        const k = m.mk[i];
        let j1 = m.mj[i], i1 = i + 1;
        while (i1 < to && m.mk[i1] === k && m.mj[i1] === j1 + 1) { j1 = m.mj[i1]; i1++; }
        const a = L.divs[k];
        if (a && a.firstChild) {
          const r = document.createRange();
          r.setStart(a.firstChild, Math.min(m.mj[i], a.firstChild.length));
          r.setEnd(a.firstChild, Math.min(j1 + 1, a.firstChild.length));
          for (const q of r.getClientRects()) add(q);
        }
        i = i1;
      }
    } catch (e) { return []; }
    return rows;
  }

  paintFind(n) {
    const L = this.tl.get(n);
    if (!L) return;
    L.hl.textContent = "";
    const q = FIND.on ? FIND.needle : "";
    if (q.length < 2) return;
    const base = L.hl.getBoundingClientRect();
    if (!base.width) return;                       // pane hidden: nothing to measure against
    const cur = FIND.hits[FIND.h];
    const here = cur && this.vol && cur.vol === this.vol.id && cur.page === n;
    let k = 0;
    for (let at = L.low.indexOf(q); at >= 0; at = L.low.indexOf(q, at + q.length), k++) {
      const on = here && k === FIND.k;
      for (const w of this.boxesFor(n, at, at + q.length)) {
        const d = document.createElement("div");
        d.className = on ? "hl cur" : "hl";
        d.style.left = (w.left - base.left) + "px";
        d.style.top = (w.top - base.top) + "px";
        d.style.width = (w.right - w.left) + "px";
        d.style.height = (w.bottom - w.top) + "px";
        L.hl.appendChild(d);
      }
    }
  }

  repaintFind() { for (const n of this.tl.keys()) this.paintFind(n); }

  /* Bring the current hit into view, and leave the page alone when it already
     is — stepping through hits on one page shouldn't jog it. */
  showMatch(n, keep) {
    const L = this.tl.get(n);
    const el = L && $(".hl.cur", L.hl);
    if (!el) { if (!keep) { this.setCur(n); this.goto(n); } return; }
    this.setCur(n);
    const r = el.getBoundingClientRect(), box = this.scroll.getBoundingClientRect();
    const pg = this.pageEls[n - 1].getBoundingClientRect();
    this.want = { page: n, y: (r.top - pg.top) / (pg.height || 1) };   // survives a zoom
    const list = $("#fb-results");
    const lip = list && !list.hidden ? list.getBoundingClientRect().bottom - box.top + 14 : 0;
    const top = box.top + Math.min(Math.max(lip, Math.min(box.height * 0.28, 170)), box.height * 0.55);
    if (r.top >= top && r.bottom <= box.bottom - 24) return;
    this.scroll.scrollTo({ top: this.scroll.scrollTop + (r.top - top), behavior: "smooth" });
    clearTimeout(this._st);
    this._st = setTimeout(() => this.dominant(), 420);
  }

  reflow() {
    if (!this.doc) return;
    // Preserve the position *within* the page: an exercise group starts partway
    // down, and a resize must not throw that away.
    let keepFrac = 0, at = this.cur;
    if (this.want) {
      at = this.want.page; keepFrac = this.want.y;      // an explicit target wins
    } else {
      const cel = this.pageEls[this.cur - 1];
      if (cel && cel.offsetHeight) {
        keepFrac = Math.max(0, Math.min(1, (this.scroll.scrollTop - cel.offsetTop) / cel.offsetHeight));
      }
    }
    this.jobs = new Map(); this.tl = new Map();
    const s = this.base * this.zoom;
    this.pageEls.forEach(el => {
      el.innerHTML = "";
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = this.label(+el.dataset.page);
      el.appendChild(num);
      el.style.width = Math.round(this.vp1w * s) + "px";
      el.style.height = Math.round(this.vp1h * s) + "px";
    });
    setTimeout(() => {
      const el = this.pageEls[at - 1];
      if (!el) return;
      this.render(at);
      this.scroll.scrollTo({ top: el.offsetTop + keepFrac * el.offsetHeight, behavior: "auto" });
      this.setCur(at);
      this.renderVisible();
      // the redraw took the boxes with it; put the hit you were on back in view
      if (FIND.on) this.render(at).then(() => this.showMatch(at, true));
    }, 40);
  }

  /* The observer only fires on a *change* of intersection, so pages that were
     already on screen never re-render after a reflow wiped them. Do those by
     hand. */
  renderVisible() {
    const top = this.scroll.scrollTop - 200;
    const bot = top + this.scroll.clientHeight + 400;
    for (const el of this.pageEls) {
      const a = el.offsetTop, b = a + el.offsetHeight;
      if (a > bot) break;
      if (b >= top) this.render(+el.dataset.page);
    }
  }

  setZoom(z) {
    this.zoom = Math.max(0.4, Math.min(2.6, Math.round(z * 100) / 100));
    $(".zoom-lvl", this.el).textContent = Math.round(this.zoom * 100) + "%";
    if (this.i === 0 && this.vol) { S.prefs.zoom = this.zoom; (S.zooms = S.zooms || {})[this.vol.id] = this.zoom; save(); }
    this.reflow();
  }

  fit() {
    if (!this.doc) return;
    const nb = Math.max(0.4, Math.min(3.0, (this.scroll.clientWidth - 52) / (this.vp1w * this.cropFrac)));
    if (Math.abs(nb - this.base) < 0.02) return;
    this.base = nb;
    this.reflow();
  }

  goto(n, instant) {
    if (!this.doc) return;
    this.want = null;
    n = Math.max(1, Math.min(this.doc.numPages, n | 0));
    const el = this.pageEls[n - 1];
    if (!el) return;
    this.render(n);
    this.scroll.scrollTo({ top: el.offsetTop - 10, behavior: instant ? "auto" : "smooth" });
    this.setCur(n);
    clearTimeout(this._st);
    this._st = setTimeout(() => this.dominant(), 420);
  }

  gotoBook(bookPage) {
    this.goto(bookPage + (this.vol.pageOffset || 0));
  }

  /* Exercise groups start partway down a page, so jumps need a y offset. */
  gotoAt(bookPage, yFrac) {
    const n = Math.max(1, Math.min(this.doc.numPages, bookPage + (this.vol.pageOffset || 0)));
    const el = this.pageEls[n - 1];
    if (!el) return;
    this.want = { page: n, y: yFrac || 0 };   // survives a reflow mid-animation
    this.render(n);
    const off = el.offsetTop + Math.max(0, (yFrac || 0) * el.offsetHeight - 26);
    // Smooth scroll never finishes across a long chapter (Ch 5's exercises
    // sit ~90 pages past the text). Jump if the target is more than two pages away.
    const far = Math.abs(off - this.scroll.scrollTop) > 2 * (el.offsetHeight || 800);
    this.scroll.scrollTo({ top: off, behavior: far ? "auto" : "smooth" });
    this.setCur(n);
    clearTimeout(this._st);
    this._st = setTimeout(() => this.dominant(), 420);
  }

  async gotoVolAt(volId, bookPage, yFrac) {
    if (!this.vol || this.vol.id !== volId) {
      await this.open(volId, bookPage + (volOf(volId).pageOffset || 0));
    }
    this.gotoAt(bookPage, yFrac);
  }

  async gotoVolBook(volId, bookPage) {
    if (!this.vol || this.vol.id !== volId) await this.open(volId, bookPage + (volOf(volId).pageOffset || 0));
    else this.gotoBook(bookPage);
  }


  dominant() {
    if (!this.pageEls.length) return;
    const top = this.scroll.scrollTop, bot = top + this.scroll.clientHeight;
    let best = this.cur, cover = -1;
    for (const el of this.pageEls) {
      const a = el.offsetTop, b = a + el.offsetHeight;
      if (b < top) continue;
      if (a > bot) break;
      const c = Math.min(b, bot) - Math.max(a, top);
      if (c > cover) { cover = c; best = +el.dataset.page; }
    }
    if (cover > 0) this.setCur(best);
  }

  setCur(n) {
    if (n === this.cur) { this.paintCtx(); return; }
    this.cur = n;
    $(".pg-input", this.el).value = this.label(n);
    const pos = { vol: this.vol.id, page: n };
    if (this.i === 0) { S.lastPos = pos; (S.pages = S.pages || {})[pos.vol] = n; } else S.lastPos2 = pos;
    save();
    this.paintCtx();
  }

  paintCtx() {
    if (this.vol) {
      const bk = this.cur - (this.vol.pageOffset || 0);
      const ch = chapterForBookPage(this.vol.id, bk);
      const inEx = ch && ch.exercises && bk >= ch.exercises.from && bk <= ch.exercises.to;
      if (this.i === 0 && !inEx) {
        const sc = sectionForBookPage(this.vol.id, bk);
        if (sc) setSection(this.vol.id, sc.id);
      } else if (this.i === 1 && inEx && !this.want) {
        // User scrolling exercises updates the study section only — never yanks text.
        const el = this.pageEls[this.cur - 1];
        const y = el && el.offsetHeight
          ? Math.max(0, Math.min(1, (this.scroll.scrollTop - el.offsetTop) / el.offsetHeight))
          : 0;
        const sc = sectionForExercisePos(this.vol.id, bk, y);
        if (sc) setSection(this.vol.id, sc.id, { fromEx: true });
      }
    }
    if (ACTIVE !== this.i || !this.vol) return;
    const book = this.cur - (this.vol.pageOffset || 0);
    const sec = sectionForBookPage(this.vol.id, book) ||
      (CURSEC && CURSEC.vol === this.vol.id && sectionsOf(this.vol.id).find(s => s.id === CURSEC.id));
    const ch = chapterForBookPage(this.vol.id, book);
    const inEx = ch && ch.exercises && book >= ch.exercises.from && book <= ch.exercises.to;
    const el = $("#context");
    if (inEx && sec) {
      el.innerHTML = `${esc(this.vol.short)} &middot; <b>&sect;${esc(sec.id)} Exercises</b> <span class="muted">p.${book}</span>`;
      window.api.setTitle(`LOCKED IN — ${this.vol.short} §${sec.id} Exercises, p.${book}`);
    } else if (inEx) {
      el.innerHTML = `${esc(this.vol.short)} &middot; <b>Ch ${esc(ch.chapter)} Exercises</b> <span class="muted">p.${book}</span>`;
      window.api.setTitle(`LOCKED IN — ${this.vol.short} Ch ${ch.chapter} Exercises, p.${book}`);
    } else if (sec) {
      el.innerHTML = `${esc(this.vol.short)} &middot; <b>&sect;${esc(sec.id)} ${esc(sec.name)}</b>`;
      window.api.setTitle(`LOCKED IN — ${this.vol.short} §${sec.id} ${sec.name}`);
    } else {
      el.innerHTML = `${esc(this.vol.short)} &middot; <span class="muted">p. ${this.label(this.cur)}</span>`;
      window.api.setTitle(`LOCKED IN — ${this.vol.short} p. ${this.label(this.cur)}`);
    }
  }
}

let ACTIVE = 0;                    // pane the context bar follows
let CURSEC = null;                 // {vol, id} — what both panes are about
let pendingFollow = null;          // soft exercise follow target
let FOLLOW_T = null;
const FOLLOW_MS = 1600;

function armExFollow() {
  if (!pendingFollow || !READERS[1]) return;
  clearTimeout(FOLLOW_T);
  const { vol, id } = pendingFollow;
  FOLLOW_T = setTimeout(() => {
    FOLLOW_T = null;
    pendingFollow = null;
    if (!CURSEC || CURSEC.vol !== vol || CURSEC.id !== id) return;
    const sec = sectionsOf(vol).find(s => s.id === id);
    if (sec && sec.exFrom) READERS[1].gotoVolAt(vol, sec.exFrom.page, sec.exFrom.y);
    else if (sec) flash(READERS[1].el, "No exercises recorded for this section");
  }, FOLLOW_MS);
}

/* Text scroll updates the study section right away; exercises catch up after
   you stop scrolling. Section picker jumps both immediately. */
function setSection(volId, secId, opts) {
  opts = opts || {};
  const changed = !CURSEC || CURSEC.vol !== volId || CURSEC.id !== secId;
  CURSEC = { vol: volId, id: secId };
  const sec = sectionsOf(volId).find(s => s.id === secId);
  if (!sec) return;
  if (opts.navText && (changed || opts.force)) READERS[0].gotoVolBook(volId, sec.from);
  if (opts.fromEx) {
    clearTimeout(FOLLOW_T);
    FOLLOW_T = null;
    pendingFollow = null;
  } else if (READERS[1] && (changed || opts.force)) {
    if (opts.force) {
      clearTimeout(FOLLOW_T);
      FOLLOW_T = null;
      pendingFollow = null;
      if (sec.exFrom) READERS[1].gotoVolAt(volId, sec.exFrom.page, sec.exFrom.y);
      else flash(READERS[1].el, "No exercises recorded for this section");
    } else {
      pendingFollow = { vol: volId, id: secId };
      armExFollow();
    }
  }
  if (changed) render();
}

/* An overlay's field keeps focus after the overlay is hidden, and the keydown
   handler ignores everything while a field has focus. Hand it back. */
function blurAway() {
  const el = document.activeElement;
  if (el && el !== document.body && typeof el.blur === "function") el.blur();
}

function flash(host, msg) {
  const d = document.createElement("div");
  d.className = "flash";
  d.textContent = msg;
  host.appendChild(d);
  setTimeout(() => d.remove(), 2200);
}

async function setExPane(on) {
  S.prefs.split = on;
  $("#expane").hidden = !on;
  $("#exgrip").hidden = !on;
  if (on && READERS.length === 1 && READERS[0].vol) {
    const r = new Reader(1, "#expane");
    READERS.push(r);
    r.el.classList.add("expane");
    $(".rlabel-tag", r.el).textContent = "exercises";
    await r.open(READERS[0].vol.id);
    if (CURSEC) setSection(CURSEC.vol, CURSEC.id, { force: true });
  } else if (!on && READERS.length > 1) {
    READERS[1].el.remove();
    READERS.pop();
    ACTIVE = 0;
  }
  $("#btn-ex").setAttribute("aria-pressed", String(on));
  save();
  setTimeout(() => READERS.forEach(r => r.fit()), 120);
}

function wireExGrip(grip) {
  let drag = false;
  grip.onmousedown = e => { drag = true; grip.classList.add("dragging"); e.preventDefault(); };
  window.addEventListener("mousemove", e => {
    if (!drag) return;
    const box = $("#pane-study").getBoundingClientRect();
    const h = Math.max(120, Math.min(box.height - 160, box.bottom - e.clientY));
    $("#expane").style.height = h + "px";
    S.prefs.exH = h;
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = false; grip.classList.remove("dragging"); save();
    setTimeout(() => READERS.forEach(r => r.fit()), 100);
  });
}

/* ---------------- selection → card ---------------- */
let lastSel = null;
document.addEventListener("selectionchange", () => {
  const sel = document.getSelection();
  const pop = $("#sel-pop");
  if (!sel || sel.isCollapsed || !sel.toString().trim()) { pop.hidden = true; lastSel = null; return; }
  const node = sel.anchorNode;
  if (!node || !(node.parentElement && node.parentElement.closest(".textLayer"))) { pop.hidden = true; return; }
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  if (!rect.width && !rect.height) { pop.hidden = true; return; }
  const pgEl = node.parentElement.closest(".pg");
  const rdEl = node.parentElement.closest(".reader");
  const rd = READERS[rdEl ? +rdEl.dataset.r : 0] || READERS[0];
  const rg = sel.getRangeAt(0), page = pgEl ? +pgEl.dataset.page : rd.cur, L = rd.tl.get(page);
  lastSel = {
    text: sel.toString().replace(/\s+/g, " ").trim().slice(0, 600),
    page, reader: rd,
    // where it starts, as a text layer span and offset: listen begins there
    k: L ? L.divs.indexOf(rg.startContainer.parentElement) : -1, j: rg.startOffset
  };
  pop.hidden = false;
  pop.style.left = Math.min(Math.max(8, rect.left + rect.width / 2 - 70), window.innerWidth - 200) + "px";
  pop.style.top = Math.max(8, rect.top - 44) + "px";
});

/* ============================================================
   FOCUS — lyric-free ambient electronic tracks. Empirically:
   no lyrics, moderate volume, not loud/fast; 16 Hz only as a
   faint air shimmer (whole-mix AM sounded like a helicopter).
   A random track each time — same architecture, different keys
   and densities so it still sounds like music.
   ============================================================ */

const FOCUS_TRACKS = [
  { id: "ember",  label: "ember",  root: 65.41, bright: 1400, kick: 0.2,  tick: 0.028, arpG: 0.55, climbG: 0.65, fastG: 0.12, pump: 0.11, saw: 1,   arpHz: 8,   climbHz: 0.62 },
  { id: "tide",   label: "tide",   root: 73.42, bright: 980,  kick: 0.08, tick: 0.012, arpG: 0.32, climbG: 0.4,  fastG: 0.04, pump: 0.06, saw: 0.55, arpHz: 4,   climbHz: 0.4  },
  { id: "lattice",label: "lattice",root: 87.31, bright: 1600, kick: 0.14, tick: 0.035, arpG: 0.62, climbG: 0.35, fastG: 0.18, pump: 0.09, saw: 0.85, arpHz: 6,   climbHz: 0.5  },
  { id: "drift",  label: "drift",  root: 55.00, bright: 850,  kick: 0,    tick: 0.01,  arpG: 0.22, climbG: 0.5,  fastG: 0,    pump: 0.04, saw: 0.35, arpHz: 2.5, climbHz: 0.35 },
  { id: "glow",   label: "glow",   root: 77.78, bright: 1200, kick: 0.12, tick: 0.02,  arpG: 0.4,  climbG: 0.55, fastG: 0.08, pump: 0.08, saw: 0.7,  arpHz: 5,   climbHz: 0.55 }
];
let audio = null, focusNodes = null, focusGain = null, focusBufs = null, focusCur = null;

function focusLabel() {
  const on = !!focusNodes;
  const lab = $("#noise-label");
  if (lab) lab.textContent = on && focusCur ? focusCur.label : "focus";
  const btn = $("#btn-noise");
  if (btn) {
    btn.title = (on && focusCur ? focusCur.label + " — " : "") + "Focus music (N)";
    btn.setAttribute("aria-pressed", String(on));
  }
}
function tone(actx, type, freq, detune, pan, dest, g) {
  const o = actx.createOscillator();
  o.type = type; o.frequency.value = freq; o.detune.value = detune;
  const p = actx.createStereoPanner(); p.pan.value = pan;
  const gg = actx.createGain(); gg.gain.value = g;
  o.connect(p).connect(gg).connect(dest);
  return o;
}
function playBuf(actx, buf, dest) {
  const s = actx.createBufferSource();
  s.buffer = buf; s.loop = true; s.connect(dest); return s;
}
function burst(actx, seconds, decay) {
  const n = Math.floor(actx.sampleRate * seconds);
  const buf = actx.createBuffer(1, n, actx.sampleRate);
  const d = buf.getChannelData(0), tau = actx.sampleRate * decay;
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / tau);
  return buf;
}
function phrase(actx, freqs, hz, dur, gain, tri) {
  const sr = actx.sampleRate, n = Math.floor(sr * freqs.length / hz);
  const buf = actx.createBuffer(2, n, sr);
  const L = buf.getChannelData(0), R = buf.getChannelData(1);
  const period = sr / hz, tau = sr * dur;
  for (let step = 0; step < freqs.length; step++) {
    const f = freqs[step], pan = step & 1 ? 0.4 : -0.4;
    const start = Math.floor(step * period);
    const len = Math.floor(Math.max(period, tau * 3));
    for (let k = 0; k < len; k++) {
      const x = (f * k / sr) % 1;
      const w = tri ? 1 - 4 * Math.abs(x - 0.5) : Math.sin(2 * Math.PI * x);
      const s = w * Math.exp(-k / tau) * gain;
      const i = (start + k) % n;
      L[i] += s * (0.65 - pan * 0.45);
      R[i] += s * (0.65 + pan * 0.45);
    }
  }
  return buf;
}
function stopFocus(fade) {
  if (!focusNodes) return;
  const dying = focusNodes, g = focusGain;
  focusNodes = null; focusGain = null; focusCur = null;
  const t = fade == null ? 0.5 : fade;
  g.gain.cancelScheduledValues(audio.currentTime);
  g.gain.linearRampToValueAtTime(0, audio.currentTime + t);
  setTimeout(() => {
    dying.forEach(n => { try { n.stop(); } catch (e) {} });
    try { g.disconnect(); } catch (e) {}
  }, t * 1000 + 50);
  focusLabel();
}
function scale(root) {
  const r = n => root * Math.pow(2, n / 12);
  return { r1: r(0), r5: r(7), r8: r(12), r10: r(15), r12: r(19), r15: r(24), r17: r(28), r19: r(31), r22: r(36) };
}
function startTrack(master, t) {
  const s = scale(t.root);
  const verb = audio.createGain();
  [0.029, 0.037, 0.047, 0.061, 0.073, 0.089].forEach((dly, i) => {
    const d = audio.createDelay(0.2); d.delayTime.value = dly;
    const f = audio.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 2600;
    const fb = audio.createGain(); fb.gain.value = 0.56;
    const p = audio.createStereoPanner(); p.pan.value = i & 1 ? 0.75 : -0.75;
    verb.connect(d); d.connect(f).connect(fb); fb.connect(d); fb.connect(p).connect(master);
  });

  const padLp = audio.createBiquadFilter();
  padLp.type = "lowpass"; padLp.frequency.value = t.bright; padLp.Q.value = 1.1;
  const pad = audio.createGain(); pad.gain.value = 0.58;
  padLp.connect(pad); pad.connect(master); pad.connect(verb);

  const pump = audio.createOscillator();
  pump.frequency.value = 2;
  const pumpG = audio.createGain(); pumpG.gain.value = t.pump;
  pump.connect(pumpG).connect(pad.gain);

  const sweep = audio.createOscillator();
  sweep.frequency.value = 0.03;
  const sweepG = audio.createGain(); sweepG.gain.value = t.bright * 0.3;
  sweep.connect(sweepG).connect(padLp.frequency);

  const chLfo = [];
  [[0.016, 0.0028, -0.8, 0.14], [0.023, 0.0035, 0.8, 0.21]].forEach(([dt, depth, pan, rate]) => {
    const d = audio.createDelay(); d.delayTime.value = dt;
    const lfo = audio.createOscillator(); lfo.frequency.value = rate;
    const lg = audio.createGain(); lg.gain.value = depth;
    lfo.connect(lg).connect(d.delayTime);
    const p = audio.createStereoPanner(); p.pan.value = pan;
    const g = audio.createGain(); g.gain.value = 0.42;
    pad.connect(d).connect(p).connect(g).connect(master);
    chLfo.push(lfo);
  });

  const sw = t.saw;
  const oscs = [
    tone(audio, "sine", s.r1, 0, 0, pad, 0.5),
    tone(audio, "sine", s.r1, 7, 0, pad, 0.22),
    tone(audio, "sawtooth", s.r1, -8, -0.18, padLp, 0.2 * sw),
    tone(audio, "sawtooth", s.r1, 10, 0.18, padLp, 0.2 * sw),
    tone(audio, "sawtooth", s.r5, -7, -0.38, padLp, 0.15 * sw),
    tone(audio, "sawtooth", s.r5, 11, 0.38, padLp, 0.15 * sw),
    tone(audio, "sawtooth", s.r10, -9, -0.52, padLp, 0.1 * sw),
    tone(audio, "sawtooth", s.r10, 8, 0.52, padLp, 0.1 * sw),
    tone(audio, "sawtooth", s.r12, -6, 0.42, padLp, 0.08 * sw),
    tone(audio, "sawtooth", s.r15, 10, -0.28, padLp, 0.055 * sw),
    tone(audio, "sawtooth", s.r17, -5, 0.22, padLp, 0.045 * sw)
  ];

  const air = audio.createBiquadFilter();
  air.type = "highpass"; air.frequency.value = 2200;
  const airAm = audio.createGain(); airAm.gain.value = 0.1;
  const airD = audio.createGain(); airD.gain.value = 0.02;
  pad.connect(air).connect(airAm).connect(verb);
  const lfo16 = audio.createOscillator();
  lfo16.frequency.value = 16;
  lfo16.connect(airD).connect(airAm.gain);

  if (!focusBufs) focusBufs = { kick: burst(audio, 0.5, 0.055) };
  const key = t.id;
  if (!focusBufs[key]) {
    focusBufs[key] = {
      arp: phrase(audio, [s.r8, s.r10, s.r12, s.r15, s.r12, s.r10, s.r8, s.r12, s.r15, s.r17, s.r15, s.r12],
        t.arpHz, 0.28, 0.08, true),
      fast: phrase(audio, [s.r15, s.r17, s.r19, s.r22], Math.max(8, t.arpHz * 2), 0.1, 0.03, true),
      climb: phrase(audio, [s.r15, s.r17, s.r19, s.r12 * 2, s.r22, s.r15 * 2, s.r17 * 2, s.r15 * 2, s.r22, s.r12 * 2],
        t.climbHz, 2.1, 0.12, false)
    };
  }
  const bufs = focusBufs[key];
  const nodes = [pump, sweep, lfo16, ...oscs, ...chLfo];

  if (t.kick > 0) {
    const kickLp = audio.createBiquadFilter();
    kickLp.type = "lowpass"; kickLp.frequency.value = 135; kickLp.Q.value = 1.3;
    const kickG = audio.createGain(); kickG.gain.value = t.kick;
    kickLp.connect(kickG).connect(master);
    const kick = playBuf(audio, focusBufs.kick, kickLp);
    nodes.push(kick);
  }
  if (t.tick > 0) {
    const tickBp = audio.createBiquadFilter();
    tickBp.type = "bandpass"; tickBp.frequency.value = 3100; tickBp.Q.value = 3.5;
    const tickG = audio.createGain(); tickG.gain.value = t.tick;
    const tickP = audio.createStereoPanner(); tickP.pan.value = 0.45;
    tickBp.connect(tickG).connect(tickP).connect(verb);
    nodes.push(playBuf(audio, focusBufs.kick, tickBp));
  }
  if (t.arpG > 0) {
    const arpLp = audio.createBiquadFilter();
    arpLp.type = "lowpass"; arpLp.frequency.value = 1050; arpLp.Q.value = 0.9;
    const arpG = audio.createGain(); arpG.gain.value = t.arpG;
    arpLp.connect(arpG); arpG.connect(master); arpG.connect(verb);
    nodes.push(playBuf(audio, bufs.arp, arpLp));
  }
  if (t.fastG > 0) {
    const fastLp = audio.createBiquadFilter();
    fastLp.type = "lowpass"; fastLp.frequency.value = 1600; fastLp.Q.value = 0.7;
    const fastG = audio.createGain(); fastG.gain.value = t.fastG;
    fastLp.connect(fastG); fastG.connect(verb);
    nodes.push(playBuf(audio, bufs.fast, fastLp));
  }
  if (t.climbG > 0) {
    const climbLp = audio.createBiquadFilter();
    climbLp.type = "lowpass"; climbLp.frequency.value = 1900; climbLp.Q.value = 0.75;
    const climbG = audio.createGain(); climbG.gain.value = t.climbG;
    climbLp.connect(climbG); climbG.connect(verb); climbG.connect(master);
    nodes.push(playBuf(audio, bufs.climb, climbLp));
  }

  nodes.forEach(n => n.start());
  return nodes;
}
function startFocus() {
  if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
  if (audio.state === "suspended") audio.resume();
  focusCur = FOCUS_TRACKS[Math.floor(Math.random() * FOCUS_TRACKS.length)];
  S.prefs.focusMode = focusCur.id;
  save();
  const master = audio.createGain();
  master.gain.value = 0;
  const comp = audio.createDynamicsCompressor();
  comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 2.4;
  comp.attack.value = 0.04; comp.release.value = 0.22;
  master.connect(comp).connect(audio.destination);
  focusGain = master;
  focusNodes = startTrack(master, focusCur);
  master.gain.linearRampToValueAtTime(0.24, audio.currentTime + 1.6);
  focusLabel();
}
function toggleFocus() {
  if (focusNodes) stopFocus();
  else startFocus();
}

/* ============================================================
   LIBRARY — every PDF under books/. An ACME volume opens with its
   study pane; anything else reads solo, full width. Two ways in:
   the sidebar (B) and quick open (O, Ctrl+P, or click the context).
   ============================================================ */
let LIB = [];
const QO = { ids: [], on: 0 };

async function libLoad() {
  const paths = await window.api.library();
  const acme = MANIFEST.volumes.filter(v => v.chapters.length);
  LIB = [...acme.map(v => v.id), ...paths.filter(p => !acme.some(v => v.pdf === p)).map(p => "file:" + p)];
  libRender();
}
function libName(id) { const v = volOf(id); return v.chapters.length ? v.short + " — " + v.title : v.short; }
function libItems(ids, on) {
  const cur = READERS[0] && READERS[0].vol && READERS[0].vol.id;
  return ids.map((id, i) => `<button class="lib-it${id === cur ? " cur" : ""}${i === on ? " on" : ""}" data-id="${esc(id)}">` +
    (volOf(id).chapters.length ? `<span class="lib-tag">ACME</span>` : "") +
    `<span class="lib-n">${esc(libName(id))}</span></button>`).join("");
}
function libRender() {
  const dir = id => volOf(id).pdf.slice(6).split("/").slice(0, -1).join("/");
  $("#lib-list").innerHTML = [...new Set(LIB.map(dir))].sort().map(d => d
    ? `<details class="lib-dir" open><summary>${esc(d)}</summary>${libItems(LIB.filter(id => dir(id) === d))}</details>`
    : libItems(LIB.filter(id => !dir(id)))).join("") || `<div class="fb-note">No PDFs yet. Put them in books/.</div>`;
}
function libShow(on) {
  S.prefs.lib = on;
  $("#lib").hidden = !on;
  $("#btn-lib").setAttribute("aria-pressed", String(on));
  save();
  READERS.forEach(r => r.fit());
}
function libOpen(id) {
  $("#qo").hidden = true;
  if (!READERS[0].vol || READERS[0].vol.id !== id) READERS[0].open(id);
}

/* Recent first, then the rest; every word typed has to appear in the name. */
function qoRender() {
  const q = $("#qo-q").value.toLowerCase().split(/\s+/).filter(Boolean);
  const rec = (S.recent || []).filter(id => LIB.includes(id));
  QO.ids = [...rec, ...LIB.filter(id => !rec.includes(id))].filter(id => q.every(w => libName(id).toLowerCase().includes(w)));
  QO.on = Math.max(0, Math.min(QO.on, QO.ids.length - 1));
  $("#qo-list").innerHTML = libItems(QO.ids, QO.on) || `<div class="fb-note">Nothing in books/ matches.</div>`;
  const on = $(".lib-it.on", $("#qo-list"));
  if (on) on.scrollIntoView({ block: "nearest" });
}
function openQO() {
  $("#qo").hidden = false;
  $("#qo-q").value = "";
  QO.on = 0;
  qoRender();
  $("#qo-q").focus();
}

function wireLibrary() {
  $("#btn-lib").onclick = () => libShow(!S.prefs.lib);
  $("#context").onclick = openQO;
  $("#lib").onclick = e => { const b = e.target.closest(".lib-it"); if (b) libOpen(b.dataset.id); };
  $("#qo").onclick = e => {
    const b = e.target.closest(".lib-it");
    if (b) libOpen(b.dataset.id); else if (e.target.id === "qo") $("#qo").hidden = true;
  };
  $("#qo-q").oninput = () => { QO.on = 0; qoRender(); };
  $("#qo-q").onkeydown = e => {
    const d = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (d) { QO.on += d; qoRender(); e.preventDefault(); }
    if (e.key === "Enter" && QO.ids[QO.on]) libOpen(QO.ids[QO.on]);
  };
  libShow(!!S.prefs.lib);
}

/* ============================================================
   LISTEN — the body text read aloud in a local neural voice, the
   spoken word marked on the page. Running heads, page numbers,
   captions, footnotes, tables, and everything from a References
   heading on are left out. Inline and displayed math are kept and
   spoken. Sentences carry a map back to text layer spans (page,
   span, offset per character) so the word can be boxed the same
   way a find hit is.
   ============================================================ */
const LS = { gen: 0, r: null, vol: null, doc: null, next: 1, body: 0, back: false, pending: null,
             sents: [], i: 0, loaded: -1, word: -1, dirty: false, userT: 0, wait: false, busy: false, cur: null,
             v: "", speed: 1, fill: Promise.resolve(), cache: new Map(), audio: new Audio() };
const LS_ABBR = /(^|\s)\(?(e\.g|i\.e|et al|etc|vs|cf|figs?|eqs?|secs?|refs?|thm|def|no|dr|prof|approx|resp|[a-z])\.$/i;
const LS_BACK = /^([IVX]+|\d+(\.\d+)*|[A-Z])?\.?\s*(references|bibliography|works cited|acknowledge?ments?|appendix|appendices)\b/i;
const LS_CAPTION = /^(fig(ure)?|tab(le)?|algorithm|listing)\.?\s*[A-Z]?\d+(\.\d+)*[.:|]?/i;
const LS_SPEAK = [[/\s?\[\d+(?:\s*[,–-]\s*\d+)*\]/g, ""], [/\be\.g\.,?/gi, "for example,"], [/\bi\.e\.,?/gi, "that is,"],
  [/\bet al\./gi, "et al"], [/\bFigs?\./g, "Figure"], [/\bEqs?\./g, "Equation"], [/\bSec\./g, "Section"], [/\bcf\./gi, "compare"], [/\bvs\./gi, "versus"]];
const LS_MATH = [
  [/¬/g, " not "], [/≪/g, " much less than "], [/≫/g, " much greater than "],
  [/≤|⩽/g, " less than or equal to "], [/≥|⩾/g, " greater than or equal to "],
  [/≠/g, " not equal to "], [/≈/g, " approximately "], [/≡/g, " equivalent to "],
  [/∈/g, " in "], [/∉/g, " not in "], [/⊂|⊆/g, " subset of "], [/∪/g, " union "], [/∩/g, " intersection "],
  [/∑/g, " sum "], [/∏/g, " product "], [/∫/g, " integral "], [/∂/g, " partial "], [/∞/g, " infinity "],
  [/→/g, " to "], [/⇒/g, " implies "], [/⇔/g, " if and only if "], [/∀/g, " for all "], [/∃/g, " there exists "],
  [/×|·|⋅/g, " times "], [/±/g, " plus or minus "], [/∴/g, " therefore "], [/√/g, " square root "],
  [/∼|~/g, " distributed as "], [/ℓ/g, " ell "], [/ℝ/g, " the reals "], [/ℕ/g, " the naturals "],
  [/ℤ/g, " the integers "], [/ℂ/g, " the complexes "],
  [/α/g, " alpha "], [/β/g, " beta "], [/γ/g, " gamma "], [/δ/g, " delta "], [/ε|ϵ/g, " epsilon "],
  [/θ/g, " theta "], [/λ/g, " lambda "], [/μ/g, " mu "], [/π/g, " pi "], [/ρ/g, " rho "],
  [/σ/g, " sigma "], [/τ/g, " tau "], [/φ|ϕ/g, " phi "], [/ψ/g, " psi "], [/ω/g, " omega "],
  [/Δ/g, " delta "], [/Γ/g, " gamma "], [/Θ/g, " theta "], [/Λ/g, " lambda "], [/Σ/g, " sigma "],
  [/Φ/g, " phi "], [/Ω/g, " omega "], [/κ/g, " kappa "], [/η/g, " eta "], [/ν/g, " nu "],
  [/ξ/g, " xi "], [/χ/g, " chi "], [/ζ/g, " zeta "]];
const LS_OP = { "|": "given", "=": "equals", "+": "plus", "−": "minus", "-": "minus",
  "<": "less than", ">": "greater than", "/": "over", "(": "of", ")": "" };
const lsSize = it => Math.round(Math.abs(it.transform[3]) * 2) / 2;

function lsSpeak(w, sc) {
  let t = LS_SPEAK.reduce((s, [a, b]) => s.replace(a, b), w);
  t = LS_MATH.reduce((s, [a, b]) => s.replace(a, b), t)
    .replace(/\|/g, " given ").replace(/(?<=[A-Za-z])\(/g, " of ")
    .replace(/^\((?![a-z]{2,}|\d)/, "of ").replace(/[()]/g, " ")
    .replace(/=/g, " equals ").replace(/−/g, " minus ").replace(/\+/g, " plus ");
  t = t.replace(/\s+/g, " ").trim();
  if (LS_OP[t] !== undefined) t = LS_OP[t];
  const sub = sc.length && sc.every(x => x < 0), sup = sc.length && sc.every(x => x > 0);
  if (sub && t) t = "sub " + t;
  else if (sup && t) t = t === "2" ? "squared" : t === "3" ? "cubed" : "to the " + t;
  return t.trim();
}

/* Body type is the size most characters are set in, sampled from the pages ahead. */
async function lsBody(from) {
  const n = {};
  for (let p = from; p < from + 8 && p <= LS.doc.numPages; p++) {
    for (const it of (await (await LS.doc.getPage(p)).getTextContent()).items) {
      if (typeof it.str === "string") n[lsSize(it)] = (n[lsSize(it)] || 0) + it.str.length;
    }
  }
  return +Object.keys(n).reduce((a, b) => (n[a] > n[b] ? a : b), 0);
}

/* One page as blocks of readable text, in content order (which is column order
   for anything set in LaTeX). Index k counts string items, the way pageMap does,
   so it names the same text layer span. sc is −1/0/+1 for sub/body/super, so
   the voice can say "x sub i" without changing what gets boxed on the page. */
async function lsPage(n) {
  const page = await LS.doc.getPage(n), h = page.getViewport({ scale: 1 }).height;
  const items = (await page.getTextContent()).items.filter(it => typeof it.str === "string");
  const blocks = [];
  const put = (b, c, k, j, sc) => {
    if (/\s/.test(c)) { if (!b.text || b.text.endsWith(" ")) return; c = " "; sc = 0; }
    b.text += c; b.pg.push(n); b.mk.push(k); b.mj.push(j); b.sc.push(sc);
  };
  const pop = b => { b.text = b.text.slice(0, -1); b.pg.pop(); b.mk.pop(); b.mj.pop(); b.sc.pop(); };
  let line = null, b = null;
  items.forEach((it, k) => {
    const size = lsSize(it), x = it.transform[4], y = it.transform[5], s = it.str;
    if (!s.trim()) { if (b && /\s/.test(s)) put(b, " ", k, 0, 0); return; }
    if (Math.abs(it.transform[1]) > 0.25 || Math.abs(it.transform[2]) > 0.25) return;
    const topish = y > h * 0.88, botish = y < h * 0.12;
    const small = size < LS.body - 1;
    // page numbers, and footnote markers (a raised digit after punctuation)
    if (small && /^\d{1,3}$/.test(s.trim()) && (topish || botish || (b && line && y > line.y + 0.8 && /[.?!]$/.test(b.text)))) return;
    const onLine = line && x > line.x - 1 && Math.abs(y - line.y) < Math.max(size, line.size);
    const sc = (onLine && size < line.size - 1) ? (y > line.y + 0.5 ? 1 : y < line.y - 0.4 ? -1 : 0) : 0;
    if (onLine) {
      if (b.sc.length && b.sc[b.sc.length - 1] !== sc && !b.text.endsWith(" ")) put(b, " ", k, 0, 0);
      else if (x - line.end > Math.max(size, line.size) * 0.15) put(b, " ", k, 0, 0);
    } else {
      const prev = line;
      line = { x, y, size: small && prev ? prev.size : size };
      if (!prev || (!small && Math.abs(size - prev.size) > 0.6) || prev.y - y > Math.max(size, prev.size) * 1.8 ||
          (y > prev.y + 1 && !small) || x > prev.x + Math.max(size, prev.size) * 4) {
        blocks.push(b = { size, top: 1 - y / h, text: "", pg: [], mk: [], mj: [], sc: [] });
      } else if (/[a-z]-$/.test(b.text) && /^[a-z]/.test(s)) pop(b);
      else put(b, " ", k, 0, 0);
    }
    for (let j = 0; j < s.length; j++) put(b, s[j], k, j, sc);
    line.end = x + it.width;
    if (!small) { line.y = y; line.size = size; }
    b.bottom = 1 - y / h;
  });
  return blocks.filter(b => {
    if (b.text.endsWith(" ")) pop(b);
    const t = b.text, ws = t.split(" ");
    const prose = ws.filter(w => /^\(?([a-z]{2,}|a)[,.;:)]?$/.test(w)).length / ws.length;
    const mathish = /[¬≪≫≤≥≠≈≡∈∉⊂⊆∪∩∑∏∫∂∞→⇒⇔∀∃×·±∴√∼=|]/.test(t) ||
      ws.filter(w => /^[A-Za-z]$/.test(w)).length >= 3;
    b.heading = t.length < 100 && !/[,;=.]$/.test(t) &&
      (b.size > LS.body + 0.9 || /^([IVX]+\.?|\d+(\.\d+)*\.?|[A-Z]\.)\s+[A-Z]/.test(t));
    if (LS_BACK.test(t) && (b.heading || t.length < 60)) LS.back = true;
    return !(LS.back || ((b.top < 0.08 || b.bottom > 0.92) && t.length < 120) || LS_CAPTION.test(t) ||
             (b.size < LS.body - (b.top > 0.7 ? 0.6 : 1.5) && !mathish) ||
             (!b.heading && !mathish && (prose < 0.35 || ws.length < 4)));
  });
}

/* A paragraph broken by a page turn, a figure or a displayed equation is put
   back together before it is cut into sentences. */
function lsJoin(a, b) {
  if (/[a-z]-$/.test(a.text) && /^[a-z]/.test(b.text)) { a.text = a.text.slice(0, -1); a.pg.pop(); a.mk.pop(); a.mj.pop(); a.sc.pop(); }
  else { a.text += " "; a.pg.push(b.pg[0]); a.mk.push(b.mk[0]); a.mj.push(0); a.sc.push(0); }
  a.text += b.text; a.pg.push(...b.pg); a.mk.push(...b.mk); a.mj.push(...b.mj); a.sc.push(...b.sc);
}

function lsSplit(b) {
  const out = [], t = b.text;
  let s = 0;
  const cut = e => {
    if (e > s) out.push({ text: t.slice(s, e), pg: b.pg.slice(s, e), mk: b.mk.slice(s, e), mj: b.mj.slice(s, e), sc: b.sc.slice(s, e) });
    s = e + 1;
  };
  for (let p = t.indexOf(" "); p >= 0; p = t.indexOf(" ", p + 1)) {
    const left = t.slice(s, p);
    if ((left.split("[").length !== left.split("]").length) || left.split("(").length !== left.split(")").length) continue;
    if ((/[.?!]["')\]]?$/.test(left) && !LS_ABBR.test(left) && /^["'(\[]?[A-Z0-9]/.test(t.slice(p + 1))) ||
        left.length > 200 || (left.length > 90 && /[,;:]$/.test(left))) cut(p);
  }
  cut(t.length);
  return out;
}

async function lsMore() {
  if (LS.next > LS.doc.numPages) {
    if (LS.pending) { LS.sents.push(...lsSplit(LS.pending)); LS.pending = null; }
    return false;
  }
  for (const b of await lsPage(LS.next++)) {
    const p = LS.pending;
    if (p && !p.heading && !b.heading && !/[.?!:]["')\]]?$/.test(p.text) && /^[a-z(]/.test(b.text)) { lsJoin(p, b); continue; }
    if (p) LS.sents.push(...lsSplit(p));
    LS.pending = b;
  }
  return true;
}

/* Pages are read one at a time and in order, whoever asks. */
function lsFill(done) {
  return LS.fill = LS.fill.then(async () => { while (!done() && await lsMore()); });
}

function lsKey(i) {
  const s = LS.sents[i];
  if (s && !s.say) {
    s.say = [...s.text.matchAll(/\S+/g)].map(m => lsSpeak(m[0], (s.sc || []).slice(m.index, m.index + m[0].length)));
  }
  return s && LS.v + "|" + s.say.join(" ");
}

/* The voice makes one sentence at a time: the one being waited on first,
   then the next three, so a skip never queues behind stale prefetches. */
function lsPump() {
  const cur = LS.cache.get(lsKey(LS.i));
  if (LS.wait && cur && (cur.url || cur.err)) {
    LS.wait = false;
    if (cur.err) { LS.cache.delete(lsKey(LS.i)); lsNote("Voice failed: " + cur.err); lsBtn(); }
    else { LS.cur = cur; LS.audio.src = cur.url; lsRate(); LS.loaded = LS.i; LS.audio.play().catch(() => {}); lsNote(""); }
  }
  if (LS.busy) return;
  const i = [0, 1, 2, 3].map(n => LS.i + n).find(i => LS.sents[i] && !LS.cache.has(lsKey(i)) && i !== LS.loaded);
  if (i === undefined) return;
  for (const [k, x] of LS.cache) if (LS.cache.size > 40 && x.url && x !== LS.cur) { URL.revokeObjectURL(x.url); LS.cache.delete(k); }
  const key = lsKey(i), e = {};
  LS.cache.set(key, e);
  LS.busy = true;
  window.api.tts(LS.sents[i].say, LS.v, 1)
    .then(r => { e.times = r.times; e.url = URL.createObjectURL(new Blob([r.wav], { type: "audio/wav" })); }, err => { e.err = (err && err.message) || String(err); })
    .finally(() => { LS.busy = false; lsPump(); });
}

async function lsStart(sel) {
  const r = (sel && sel.reader) || READERS[ACTIVE] || READERS[0];
  if (!r || !r.doc) return;
  const g = ++LS.gen;
  LS.audio.pause();
  lsClear();
  Object.assign(LS, { r, vol: r.vol, doc: r.doc, next: sel ? sel.page : r.cur, back: false, pending: null,
                      sents: [], i: NaN, loaded: -1, wait: true, fill: Promise.resolve() });
  lsOpen(true);
  lsBtn();
  LS.body = await lsBody(LS.next);
  if (g !== LS.gen) return;
  let i = 0;
  if (sel && sel.k >= 0) {
    const after = s => {
      const e = s.text.length - 1;
      return s.pg[e] > sel.page || (s.pg[e] === sel.page && (s.mk[e] > sel.k || (s.mk[e] === sel.k && s.mj[e] >= sel.j)));
    };
    await lsFill(() => LS.sents.some(after));
    i = Math.max(0, LS.sents.findIndex(after));
  }
  lsPlay(i);
}

/* Generate at 1× so Kokoro doesn't eat syllables; the player applies the rate. */
async function lsPlay(i) {
  if (!(i >= 0)) return;
  const g = LS.gen;
  LS.audio.pause();
  Object.assign(LS, { i, loaded: -1, word: -1, wait: true, v: S.prefs.lsVoice || "af_heart" });
  lsBtn();
  await lsFill(() => LS.sents.length > i + 4);
  if (g !== LS.gen) return;
  if (!LS.sents[i]) { LS.wait = false; lsBtn(); return lsNote("End of the document."); }
  lsPump();
}

function lsToggle() {
  if (LS.wait) LS.gen++;
  if (LS.wait || !LS.audio.paused) { LS.wait = false; LS.audio.pause(); return lsBtn(); }
  if (LS.sents[LS.i] && LS.r && LS.r.vol === LS.vol) return LS.loaded === LS.i ? LS.audio.play().catch(() => {}) : lsPlay(LS.i);
  lsStart(null);
}

function lsBtn() { $("#ls-play").className = "ls-play" + (LS.wait ? " wait" : LS.audio.paused ? "" : " on"); }
function lsClear() { $$(".say").forEach(e => e.remove()); }
function lsNote(t) { $("#ls-note").textContent = t; }

function lsOpen(on) {
  $("#listen").hidden = !on;
  $("#btn-listen").setAttribute("aria-pressed", String(on));
  if (!on) { LS.gen++; LS.wait = false; LS.audio.pause(); LS.loaded = -1; LS.sents = []; lsClear(); }
  if (on && !$("#ls-voice").options.length) {
    lsNote("Loading the voice (the first run downloads it, ~330 MB)…");
    window.api.voices().then(vs => {
      Object.entries(vs).filter(([, x]) => x.language.startsWith("en"))
        .sort((a, b) => a[1].overallGrade.localeCompare(b[1].overallGrade))
        .forEach(([id, x]) => $("#ls-voice").add(new Option(`${x.name} · ${x.language.slice(3).toUpperCase()} ${x.gender.toLowerCase()}`, id)));
      $("#ls-voice").value = S.prefs.lsVoice || "af_heart";
      if ($("#ls-note").textContent.startsWith("Loading")) lsNote("");
    }).catch(e => lsNote("Voice failed to load: " + ((e && e.message) || e)));
  }
}

/* Boxes for chars [from, to) of a sentence, all on one page. */
function lsBoxes(s, from, to, cls) {
  const r = LS.r, n = s.pg[from], L = r.tl.get(n);
  if (!L) { r.render(n); LS.dirty = true; return null; }
  const base = L.hl.getBoundingClientRect();
  let last = null;
  for (const w of r.boxesFor(n, from, to, s)) {
    const d = document.createElement("div");
    d.className = cls;
    d.style.left = (w.left - base.left) + "px";
    d.style.top = (w.top - base.top) + "px";
    d.style.width = (w.right - w.left) + "px";
    d.style.height = (w.bottom - w.top) + "px";
    L.hl.appendChild(d);
    last = w;
  }
  return last;
}

function lsTick() {
  requestAnimationFrame(lsTick);
  const s = LS.sents[LS.i], a = LS.audio, ts = LS.cur && LS.cur.times;
  if (!s || LS.loaded !== LS.i || !ts) return;
  if (LS.r.vol !== LS.vol) { lsOpen(false); return; }
  const ws = s.words || (s.words = [...s.text.matchAll(/\S+/g)].map(m => [m.index, m.index + m[0].length]));
  let w = 0;
  while (w < ws.length - 1 && ts[w + 1] <= a.currentTime) w++;
  if (w === LS.word && !LS.dirty) return;
  LS.word = w; LS.dirty = false;
  lsClear();
  for (let i = 0, from = 0; i <= s.pg.length; i++) {
    if (i === s.pg.length || s.pg[i] !== s.pg[from]) { lsBoxes(s, from, i, "say"); from = i; }
  }
  const box = lsBoxes(s, ws[w][0], ws[w][1], "say w");
  const view = LS.r.scroll.getBoundingClientRect();
  if (box && Date.now() - LS.userT > 4000 && (box.top < view.top + 40 || box.bottom > view.bottom - 60)) {
    LS.r.scroll.scrollTo({ top: LS.r.scroll.scrollTop + box.top - view.top - view.height * 0.35, behavior: "smooth" });
  }
}

function lsRate() {
  const r = +$("#ls-rate").value || 1;
  LS.audio.preservesPitch = true;
  LS.audio.defaultPlaybackRate = LS.audio.playbackRate = r;
}

function wireListen() {
  LS.audio.onended = () => lsPlay(LS.i + 1);
  LS.audio.onplay = LS.audio.onpause = lsBtn;
  [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].forEach(v => $("#ls-rate").add(new Option(v + "×", v)));
  $("#ls-rate").value = S.prefs.lsRate || 1;
  if (!$("#ls-rate").value) $("#ls-rate").value = 1;
  lsRate();
  $("#ls-rate").onchange = e => { S.prefs.lsRate = +e.target.value; save(); lsRate(); };
  $("#ls-voice").onchange = e => { S.prefs.lsVoice = e.target.value; save(); if (LS.wait || !LS.audio.paused) lsPlay(LS.i); };
  $("#ls-play").onclick = lsToggle;
  $("#ls-close").onclick = () => lsOpen(false);
  $("#btn-listen").onclick = () => ($("#listen").hidden ? lsStart(null) : lsOpen(false));
  $("#sel-listen").onclick = () => { const s = lastSel; $("#sel-pop").hidden = true; document.getSelection().removeAllRanges(); lsStart(s); };
  // scrolling away to look at something holds off the follow for a few seconds
  document.addEventListener("wheel", e => { if (e.target.closest && e.target.closest(".rscroll")) LS.userT = Date.now(); }, { passive: true });
  lsTick();
}

/* ============================================================
   FIND — the whole corpus, both volumes at once, and the hits
   drawn on the page you land on. The index is built on first use
   (~3s for 532 pages) and kept for the session.
   ============================================================ */
let INDEX = null;          // [{vol, page, text, low}] — page is the PDF page
let indexing = null;       // in-flight build, so two opens don't build twice
let indexScope = "";       // the volumes INDEX covers (see findScope)
const FIND = {
  on: false,               // is the bar up — closing it takes the highlights with it
  q: "", needle: "",
  hits: [],                // one entry per page that matches
  total: 0,                // matches across all of them
  h: 0, k: 0,              // where you are: page hits[h], its kth match
  cut: false, status: null
};
const FB_CAP = 400;        // pages listed; anything past this is reported, not dropped silently
let fbT = null;            // pending jump, so typing doesn't drag the page along behind it
let fbLandN = 0;           // only the newest jump gets to move the reader

/* The string the index searches, plus a map from every character in it back to
   the text layer span it came from.

   Keep the line breaks: without them the last word of a line fuses to the
   first of the next ("phase\nin" -> "phasein"), and a running head fuses to
   the body. Then undo LaTeX's end-of-line hyphenation, which splits ~600 words
   across the two volumes ("under-\nstanding"); anchoring on the break means a
   real inline compound like "two-dimensional" is left alone. Vol 4's font
   drops the ff/ffi ligatures, so most of its pages carry "di!erent" for
   "different" — repair between letters only, since elsewhere those glyphs are
   real, and in Vol 3 they are large math delimiters. The per-volume flag is
   fixLigatures in the manifest.

   None of that preserves the length, which is the whole reason for the map:
   it is what turns a hit's character offset into a box on the page. */
function pageMap(tc, v) {
  const SP = /\s/, LT = /[A-Za-z]/, LO = /[a-z]/;
  const lig = !!(v && v.fixLigatures);
  // every raw character, tagged with the span it belongs to. pdf.js makes one
  // span per item, in this order, and sets its text to the item's own string.
  const ch = [], ci = [], co = [];
  let d = 0;
  for (const it of tc.items) {
    if (typeof it.str !== "string") continue;        // marked content, no span of its own
    for (let j = 0; j < it.str.length; j++) { ch.push(it.str[j]); ci.push(d); co.push(j); }
    if (it.hasEOL) { ch.push("\n"); ci.push(d); co.push(it.str.length); }
    d++;
  }
  const out = [], mk = [], mj = [];
  const put = (c, i) => { out.push(c); mk.push(ci[i]); mj.push(co[i]); };
  const last = () => (out.length ? out[out.length - 1] : "");
  let mended = false;        // the character just emitted came off a mended hyphen
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i];
    if (c === "-" && !mended && LT.test(last()) && ch[i + 1] === "\n") {
      let k = i + 2;
      while (k < ch.length && SP.test(ch[k])) k++;
      if (k < ch.length && LO.test(ch[k])) { put(ch[k], k); i = k; mended = true; continue; }
    }
    mended = false;
    if (SP.test(c)) {                                // runs collapse to one space, edges to none
      if (out.length && last() !== " ") put(" ", i);
      continue;
    }
    if (lig && (c === "!" || c === '"') && LT.test(last()) && ch[i + 1] && LO.test(ch[i + 1])) {
      for (const r of (c === "!" ? "ff" : "ffi")) put(r, i);   // both halves point at the one glyph
      continue;
    }
    put(c, i);
  }
  if (last() === " ") { out.pop(); mk.pop(); mj.pop(); }
  const text = out.join("");
  return { text, low: text.toLowerCase(), mk, mj };
}

/* In an ACME volume find covers both; in anything else, just that PDF. */
function findScope() {
  const v = READERS[0] && READERS[0].vol;
  if (!v) return [];
  return v.chapters.length ? MANIFEST.volumes.filter(x => x.chapters.length) : [v];
}

async function buildIndex(onProgress) {
  const out = [];
  for (const v of findScope()) {
    let slot = docCache[v.id];
    if (!slot) {
      if (!(await window.api.pdfCheck(v.pdf))) continue;
      const st = await window.api.pdfStat(v.pdf);
      const buf = await window.api.pdfRead(v.pdf);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      slot = docCache[v.id] = { doc, size: st ? st.size : 0, mtimeMs: st ? st.mtimeMs : 0 };
    }
    const doc = slot.doc;
    for (let i = 1; i <= doc.numPages; i++) {
      const m = pageMap(await (await doc.getPage(i)).getTextContent(), v);
      out.push({ vol: v.id, page: i, text: m.text, low: m.low });
      if (onProgress && i % 25 === 0) onProgress(v.short, i, doc.numPages);
    }
  }
  return out;
}

/* One hit per matching page, carrying how many matches sit on it and how many
   came before it, so the bar can count "17 of 233" without a list of every
   single one. The offsets themselves are found again per page, at paint time. */
function runFind(q) {
  FIND.q = q;
  FIND.needle = q.trim().toLowerCase();
  FIND.hits = []; FIND.total = 0; FIND.h = 0; FIND.k = 0; FIND.cut = false;
  const needle = FIND.needle;
  if (needle.length < 2 || !INDEX) return;
  for (const pg of INDEX) {
    const at = pg.low.indexOf(needle);
    if (at < 0) continue;
    if (FIND.hits.length >= FB_CAP) { FIND.cut = true; break; }
    let count = 0;
    for (let i = at; i >= 0; i = pg.low.indexOf(needle, i + needle.length)) count++;
    FIND.hits.push({ vol: pg.vol, page: pg.page, at, count, text: pg.text, n0: FIND.total });
    FIND.total += count;
  }
}

/* Start from where you are, the way a browser does, and wrap around. */
function fbNearest() {
  const r = READERS[0];
  if (!r || !r.vol) return 0;
  const rank = id => MANIFEST.volumes.findIndex(v => v.id === id);
  const rv = rank(r.vol.id);
  for (let i = 0; i < FIND.hits.length; i++) {
    const h = FIND.hits[i], hv = rank(h.vol);
    if (hv > rv || (hv === rv && h.page >= r.cur)) return i;
  }
  return 0;
}

function fbStep(d) {
  const n = FIND.hits.length;
  if (!n) return;
  let h = FIND.h, k = FIND.k + d;
  if (k < 0) { h = (h - 1 + n) % n; k = FIND.hits[h].count - 1; }
  else if (k >= FIND.hits[h].count) { h = (h + 1) % n; k = 0; }
  FIND.h = h; FIND.k = k;
  fbLand();
}

/* Land on the current hit: draw it wherever it is on screen, then bring it
   into view in the main reader. */
async function fbLand() {
  const h = FIND.hits[FIND.h];
  if (!h) return;
  const t = ++fbLandN;
  fbRender();
  const r = READERS[0];
  if (!r) return;
  if (!r.vol || r.vol.id !== h.vol) await r.open(h.vol, h.page);
  await r.render(h.page);
  if (t !== fbLandN) return;            // a newer jump got there first
  READERS.forEach(x => x.repaintFind());
  r.showMatch(h.page);
}

function snippet(h, len) {
  const W = 74, t = h.text;
  const a = Math.max(0, h.at - W), b = Math.min(t.length, h.at + len + W);
  return (a > 0 ? "…" : "") + esc(t.slice(a, h.at)) +
         "<mark>" + esc(t.slice(h.at, h.at + len)) + "</mark>" +
         esc(t.slice(h.at + len, b)) + (b < t.length ? "…" : "");
}

function fbRender() {
  const cnt = $("#fb-count"), list = $("#fb-results");
  const needle = FIND.needle, none = !FIND.hits.length;
  $("#fb-prev").disabled = $("#fb-next").disabled = none;
  $("#fb-list").title = none ? "Every page with a match"
    : `${FIND.hits.length} page${FIND.hits.length === 1 ? "" : "s"} with a match`;
  cnt.textContent =
    !INDEX ? (FIND.status || "indexing") :
    needle.length < 2 ? "" :
    none ? "no match" :
    `${FIND.hits[FIND.h].n0 + FIND.k + 1}/${FIND.total}`;
  if (list.hidden) return;

  if (!INDEX) {
    list.innerHTML = `<div class="fb-note">${esc(FIND.status || "Reading…")}<br>
      Once built it stays for the session.</div>`;
    return;
  }
  if (needle.length < 2) {
    list.innerHTML = `<div class="fb-note">Two characters or more. Searches every page &mdash;
      in an ACME volume, both of them.</div>`;
    return;
  }
  if (none) {
    list.innerHTML = `<div class="fb-note">Nothing for &ldquo;${esc(FIND.q.trim())}&rdquo;.</div>`;
    return;
  }
  list.innerHTML = FIND.hits.map((h, i) => {
    const v = volOf(h.vol) || {};
    const book = h.page - (v.pageOffset || 0);
    const sec = sectionForBookPage(h.vol, book);
    return `<button class="fb-hit${i === FIND.h ? " on" : ""}" data-i="${i}">
      <span class="fb-loc"><span class="v">${esc(v.short || h.vol)}</span> p.${book}` +
      (sec ? `<span class="sec">&sect;${esc(sec.id)} ${esc(sec.name)}</span>` : "") +
      (h.count > 1 ? `<span class="fb-more">${h.count} here</span>` : "") +
      `</span><span class="fb-snip">${snippet(h, needle.length)}</span></button>`;
  }).join("") +
  (FIND.cut ? `<div class="fb-note">Listed the first ${FB_CAP} pages and stopped &mdash;
     there are more. Narrow the search.</div>` : "");
  $$(".fb-hit", list).forEach(b => b.onclick = () => {
    FIND.h = +b.dataset.i; FIND.k = 0;
    fbLand();
  });
  const on = $(`.fb-hit[data-i="${FIND.h}"]`, list);
  if (on) on.scrollIntoView({ block: "nearest" });
}

async function openFind() {
  FIND.on = true;
  $("#find").hidden = false;
  $("#btn-search").setAttribute("aria-pressed", "true");
  const inp = $("#fb-q");
  inp.value = FIND.q || "";
  inp.placeholder = READERS[0].vol && !READERS[0].vol.chapters.length ? `Find in ${READERS[0].vol.short}…` : "Find in both volumes…";
  fbRender();
  inp.focus(); inp.select();
  READERS.forEach(r => r.repaintFind());     // the query outlives a close
  const scope = findScope().map(v => v.id).join("|");
  if (INDEX && indexScope === scope) return;
  if (indexScope !== scope) {
    INDEX = null;
    indexScope = scope;
    indexing = buildIndex((short, i, n) => {
      FIND.status = `indexing ${short} ${i}/${n}`;
      if (FIND.on) fbRender();
    });
  }
  const built = await indexing;
  if (indexScope !== scope) return;           // the document changed while this built
  INDEX = built;
  FIND.status = null;
  if (!FIND.on) return;
  runFind($("#fb-q").value);
  FIND.h = fbNearest();
  fbRender();
  if (FIND.hits.length) fbLand();
}

function closeFind() {
  FIND.on = false;
  $("#find").hidden = true;
  $("#btn-search").setAttribute("aria-pressed", "false");
  clearTimeout(fbT); fbT = null;
  READERS.forEach(r => r.repaintFind());
  blurAway();
}

function wireFind() {
  $("#btn-search").onclick = () => { if (FIND.on) closeFind(); else openFind(); };
  $("#fb-close").onclick = closeFind;
  $("#fb-prev").onclick = () => fbStep(-1);
  $("#fb-next").onclick = () => fbStep(1);
  $("#fb-list").onclick = () => {
    const list = $("#fb-results");
    list.hidden = !list.hidden;
    $("#fb-list").setAttribute("aria-pressed", String(!list.hidden));
    fbRender();
  };
  $("#fb-q").oninput = e => {
    runFind(e.target.value);
    FIND.h = fbNearest();
    fbRender();
    READERS.forEach(r => r.repaintFind());
    clearTimeout(fbT);
    fbT = setTimeout(() => { fbT = null; if (FIND.hits.length) fbLand(); }, 170);
  };
  $("#fb-q").onkeydown = e => {
    if (e.key === "Enter") {
      // the first Enter after typing shows the match the pause hadn't reached
      if (fbT) { clearTimeout(fbT); fbT = null; fbLand(); }
      else fbStep(e.shiftKey ? -1 : 1);
      e.preventDefault();
    } else if (e.key === "ArrowDown") { fbStep(1);  e.preventDefault(); }
    else if (e.key === "ArrowUp")     { fbStep(-1); e.preventDefault(); }
  };
}

/* ============================================================
   STUDY PANE — pick a section once, then work its cards.
   Exercises live in their own pane and follow the section.
   ============================================================ */
function render() {
  const host = $("#study");
  host.innerHTML = sectionBar() + vRead();
  wire(host);
}

/* one persistent selector, instead of a picker inside every mode */
function sectionBar() {
  const opts = [];
  MANIFEST.volumes.forEach(v => {
    const secs = sectionsOf(v.id);
    if (!secs.length) return;
    opts.push(`<optgroup label="${esc(v.short)} — ${esc(v.title)}">` +
      secs.map(s => {
        const sel = CURSEC && CURSEC.vol === v.id && CURSEC.id === s.id ? " selected" : "";
        return `<option value="${v.id}|${s.id}"${sel}>§${esc(s.id)}  ${esc(s.name)}</option>`;
      }).join("") + `</optgroup>`);
  });
  if (!opts.length) return `<div class="empty"><h3>No chapters loaded</h3></div>`;
  return `<div class="secbar">
    <select id="secpick" aria-label="Section">${opts.join("")}</select>
  </div>`;
}

function curList() {
  if (!CURSEC) return [];
  const ch = chapterOfSection(CURSEC.vol, CURSEC.id);
  return ch ? ch.cards.filter(c => c.s === CURSEC.id).map(c => withCh(c, ch)) : [];
}

/* The whole section at once. Every answer is collapsed on its own card rather
   than gated behind the one before it, so you can work in any order. */
function listBar(n, noun) {
  return `<div class="listbar">
    <span class="tiny muted">${n} ${esc(noun)}${n === 1 ? "" : "s"} in &sect;${esc(CURSEC.id)}</span>
  </div>`;
}

function vRead() {
  const list = curList();
  if (!CURSEC) return `<p class="tiny muted">Pick a section above.</p>`;
  if (!list.length) return `<div class="empty"><h3>Nothing authored for &sect;${esc(CURSEC.id)}</h3></div>`;
  return listBar(list.length, "card") +
    list.map(card).join("");
}

const REGISTERS = [["rot", "brain rot", "lower the load"],
                   ["ex", "show me one", "concrete instance"],
                   ["why", "why care", "what it buys you"],
                   ["math", "just the math", "stripped"]];

/* Everything a card can show is rendered up front and hidden; revealing is a
   DOM toggle, not a re-render, so opening one card can't move the others or
   throw away your scroll position. */
function card(c, i) {
  const v = volOf(c.vol) || {};
  const sec = c.s ? sectionsOf(c.vol).find(s => s.id === c.s) : null;

  let h = `<div class="card">
    <div class="q-head">
      ${c.s ? `<span class="sec-tag">&sect;${esc(c.s)}</span>` : ""}
      <span class="muted tiny">${esc(sec ? sec.name : (v.short || ""))}</span>
      ${c.page ? `<button class="pg-ref" data-page="${c.vol}|${c.page}">p.${c.page}</button>` : ""}
      <span class="q-count">${i + 1}</span>
    </div>
    <div class="q-prompt">${c.q}</div>`;

  h += `<p class="q-hint">Say it out loud before revealing. Retrieval only works if you attempt the retrieval.</p>`;

  h += `<div class="btnrow"><button class="btn ghost rev" data-reveal="1" aria-pressed="false">Reveal</button></div>`;

  h += `<div class="answer" hidden><h4>Answer</h4>
    <div class="body">${c.a}</div>`;
  const regs = c.r ? REGISTERS.filter(([k]) => c.r[k]) : [];
  if (regs.length) {
    h += `<div class="registers">` + regs.map(([k, label]) =>
      `<button data-reg="${k}" aria-pressed="false">${label}</button>`).join("") + `</div>`;
    h += regs.map(([k, , note]) =>
      `<div class="reg-out" data-regout="${k}" hidden><div class="rlabel">${note}</div>${c.r[k]}</div>`).join("");
  }
  return h + `</div></div>`;
}

function setOpen(cardEl, open) {
  const ans = $(".answer", cardEl);
  if (!ans) return;
  ans.hidden = !open;
  const rev = $(".rev", cardEl);
  if (rev) { rev.setAttribute("aria-pressed", String(open)); rev.textContent = open ? "Hide" : "Reveal"; }
}

function wire(root) {
  const q = (sel, fn) => $$(sel, root).forEach(fn);
  q("[data-reveal]", b => b.onclick = () => {
    const el = b.closest(".card");
    setOpen(el, $(".answer", el).hidden);
  });
  q("[data-reg]", b => b.onclick = () => {
    const el = b.closest(".card"), k = b.dataset.reg;
    const on = b.getAttribute("aria-pressed") !== "true";
    // one register at a time per card
    $$("[data-reg]", el).forEach(x => x.setAttribute("aria-pressed", String(x === b && on)));
    $$("[data-regout]", el).forEach(x => { x.hidden = !(x.dataset.regout === k && on); });
  });
  q("[data-page]", b => b.onclick = () => {
    const [v, p] = b.dataset.page.split("|");
    READERS[0].gotoVolBook(v, +p);
  });
  const pick = $("#secpick", root);
  if (pick) pick.onchange = () => {
    const [v, id] = pick.value.split("|");
    setSection(v, id, { navText: true, force: true });
    render();
  };
}

/* ============================================================
   CHROME
   ============================================================ */
function wireChrome() {
  $("#btn-noise").onclick = toggleFocus;
  $("#btn-ex").onclick = () => setExPane(!S.prefs.split);
  $("#btn-dim").onclick = () => {
    S.prefs.dim = !S.prefs.dim;
    document.body.classList.toggle("dim", S.prefs.dim);
    $("#btn-dim").setAttribute("aria-pressed", String(S.prefs.dim));
    save();
  };
  $("#btn-zen").onclick = async () => {
    const on = !document.body.classList.contains("zen");
    document.body.classList.toggle("zen", on);
    $("#btn-zen").setAttribute("aria-pressed", String(on));
    await window.api.fullscreen(on);
  };
  let drag = false;
  $("#grip").onmousedown = e => { drag = true; $("#grip").classList.add("dragging"); e.preventDefault(); };
  window.addEventListener("mousemove", e => {
    if (!drag) return;
    const pct = Math.max(26, Math.min(80, (e.clientX / window.innerWidth) * 100));
    $("#pane-pdf").style.flexBasis = pct + "%";
    $("#pane-study").style.flexBasis = (100 - pct) + "%";
    S.prefs.splitPct = pct;
  });
  window.addEventListener("mouseup", () => {
    if (!drag) return;
    drag = false; $("#grip").classList.remove("dragging"); save();
    clearTimeout(window._rf); window._rf = setTimeout(() => READERS.forEach(r => r.fit()), 120);
  });
  window.api.onZoom(d => { const r = READERS[ACTIVE] || READERS[0]; r.setZoom(d ? r.zoom + 0.15 * d : 1); });
  window.addEventListener("resize", () => {
    clearTimeout(window._rf); window._rf = setTimeout(() => READERS.forEach(r => r.fit()), 160);
  });

  document.addEventListener("keydown", e => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === "f") { openFind(); e.preventDefault(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === "p") { openQO(); e.preventDefault(); return; }
    if (FIND.on && (e.key === "F3" || ((e.ctrlKey || e.metaKey) && e.key === "g"))) {
      fbStep(e.shiftKey ? -1 : 1); e.preventDefault(); return;
    }
    if (e.key === "Escape") {
      if (!$("#qo").hidden) { $("#qo").hidden = true; return; }
      if (FIND.on) { closeFind(); return; }
      if (document.body.classList.contains("zen")) { $("#btn-zen").click(); return; }
    }
    if (typing) return;
    if (e.key === "/") { openFind(); e.preventDefault(); return; }
    const r = READERS[ACTIVE] || READERS[0];
    if (e.key === "n") toggleFocus();
    if (e.key === "d") $("#btn-dim").click();
    if (e.key === "l") $("#btn-zen").click();
    if (e.key === "e") setExPane(!S.prefs.split);
    if (e.key === "o") { openQO(); e.preventDefault(); }
    if (e.key === "b") $("#btn-lib").click();
    if (e.key === "r") lsToggle();
    if (e.key === "[" && !$("#listen").hidden) lsPlay(Math.max(0, LS.i - 1));
    if (e.key === "]" && !$("#listen").hidden) lsPlay(LS.i + 1);
    if (e.key === "ArrowRight" || e.key === "PageDown") { r.goto(r.cur + 1); e.preventDefault(); }
    if (e.key === "ArrowLeft"  || e.key === "PageUp")   { r.goto(r.cur - 1); e.preventDefault(); }
    // space walks down the list, opening the next card still closed
    if (e.key === " ") {
      const next = $$("#study .card").find(el => {
        const a = $(".answer", el);
        return a && a.hidden;
      });
      if (next) {
        $(".rev", next).click();
        next.scrollIntoView({ block: "nearest" });
      }
      e.preventDefault();
    }
  });
}

/* ============================================================
   BOOT
   ============================================================ */
async function boot() {
  MANIFEST = await window.api.manifest();
  const st = await window.api.getState();
  if (st) S = Object.assign(JSON.parse(JSON.stringify(DEFAULT_STATE)), st);
  delete S.gen;
  S.prefs = Object.assign({ dim: true, zoom: 1.0, splitPct: 58, split: false, focusMode: "ember" }, S.prefs || {});
  focusLabel();

  for (const v of MANIFEST.volumes) {
    for (const c of v.chapters) {
      if (!c.file) continue;
      const data = await window.api.chapter(c.file);
      if (data) CHAPTERS[v.id + ":" + c.id] = data;
    }
  }

  if (S.prefs.dim) { document.body.classList.add("dim"); $("#btn-dim").setAttribute("aria-pressed", "true"); }
  if (S.prefs.splitPct) {
    $("#pane-pdf").style.flexBasis = S.prefs.splitPct + "%";
    $("#pane-study").style.flexBasis = (100 - S.prefs.splitPct) + "%";
  }

  const r0 = new Reader(0);
  READERS.push(r0);
  r0.zoom = S.prefs.zoom || 1.0;
  $(".zoom-lvl", r0.el).textContent = Math.round(r0.zoom * 100) + "%";

  wireFind();
  wireListen();
  wireLibrary();
  await libLoad();
  wireExGrip($("#exgrip"));
  if (S.prefs.exH) $("#expane").style.height = S.prefs.exH + "px";
  wireChrome();
  render();

  await r0.open((S.lastPos && S.lastPos.vol) || MANIFEST.volumes[0].id);
  if (!CURSEC) {
    const v = MANIFEST.volumes.find(v => sectionsOf(v.id).length);
    if (v) CURSEC = { vol: v.id, id: sectionsOf(v.id)[0].id };
  }
  render();
  if (S.prefs.split) await setExPane(true);
}

boot().catch(e => {
  $("#study").innerHTML =
    `<div class="empty"><h3>Failed to start</h3><p class="mono" style="font-size:12px">${esc(e && e.message)}</p></div>`;
});
