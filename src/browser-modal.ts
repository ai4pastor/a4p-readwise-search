import { Editor, EditorPosition, Modal, Notice, Platform, setIcon } from "obsidian";
import {
  citationOptions,
  formatHitCitation,
  insertCitationText,
  replaceWithCitation,
} from "./citation";
import {
  CITATION_FORMAT_LABELS,
  CitationFormat,
  joinCitations,
  locationLabel,
} from "./citation-format";
import type { ActiveFilters } from "./filters";
import { createHighlightNoteFromHit } from "./highlight-note";
import { formatRelative, renderTextWithMarks, snippetAround } from "./hit-render";
import type ReadwiseSearchPlugin from "./main";
import { highlightTime, MatchMode, queryAll, SearchHit, sortHits, SortMode } from "./search";
import type { ReadwiseBook, ReadwiseHighlight } from "./types";

/** 노트에서 시작 글자(,,)로 열었을 때 인용으로 바꿀 자리 */
export interface BrowserTarget {
  editor: Editor;
  from: EditorPosition;
  to: EditorPosition;
}

export interface BrowserOpenOptions {
  query?: string;
  /** 사이드 패널의 "크게 보기"에서 넘어온 필터 */
  filters?: ActiveFilters;
  target?: BrowserTarget;
}

type Period = "all" | "week" | "month" | "year";
type FacetKey = "category" | "book" | "tag" | "state" | "period";

interface FacetCounts {
  categories: Map<string, number>;
  books: Map<number, { book: ReadwiseBook; count: number }>;
  tags: Map<string, number>;
  memo: number;
  noted: number;
  favorite: number;
}

const PERIODS: Array<[Period, string, number]> = [
  ["all", "전체", Infinity],
  ["week", "1주", 7],
  ["month", "1달", 31],
  ["year", "1년", 366],
];
const SORTS: Array<[SortMode, string]> = [
  ["recent", "최신순"],
  ["relevance", "관련도"],
  ["book", "책별"],
  ["oldest", "오래된순"],
];
const CATEGORY_LABELS: Record<string, string> = {
  books: "책",
  articles: "아티클",
  tweets: "트윗",
  podcasts: "팟캐스트",
  supplementals: "보조자료",
};
const CATEGORY_ORDER = ["books", "articles", "tweets", "podcasts", "supplementals"];
/** 목록은 이만큼씩 그린다 ("N건 더 보기") */
const PAGE = 60;
const BOOKS_VISIBLE = 10;
const TAGS_VISIBLE = 12;
const DEBOUNCE_MS = 120;
/** 창 폭이 이보다 좁으면 한 단으로 접고 필터·미리보기를 덮개로 연다 */
const NARROW_PX = 900;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 큰 검색 창 (v0.3.0, 시안 A — 2026-11-12 성현님 선택).
 * 왼쪽 필터(건수) · 가운데 결과 목록 · 오른쪽 미리보기(전문·메모·넣을 모양·같은 책 앞뒤 밑줄).
 * 노트에서 ,,를 치거나 명령·사이드 패널 "크게 보기"로 연다.
 */
export class HighlightBrowserModal extends Modal {
  private plugin: ReadwiseSearchPlugin;
  private target: BrowserTarget | undefined;
  /** 시작 글자로 열었을 때 그 자리에 있던 글자 — 창을 연 사이 노트가 바뀌었는지 확인용 */
  private targetText = "";

  private query: string;
  private sort: SortMode;
  private categories = new Set<string>();
  private bookIds = new Set<number>();
  private tagNames = new Set<string>();
  private onlyMemo = false;
  private onlyNoted = false;
  private onlyFavorite = false;
  private period: Period = "all";
  private bookQuery = "";
  private showAllBooks = false;
  private showAllTags = false;

  private list: SearchHit[] = [];
  private mode: MatchMode = "all";
  private terms: string[] = [];
  private counts: FacetCounts | null = null;
  private current: SearchHit | null = null;
  /** 고른 순서대로 넣는다 */
  private selected = new Map<number, SearchHit>();
  private shown = PAGE;
  private byBook = new Map<number, ReadwiseHighlight[]>();
  private timer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private inputEl!: HTMLInputElement;
  private bookInputEl!: HTMLInputElement;
  private sortEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private listEl!: HTMLElement;
  private previewEl!: HTMLElement;
  private selectionEl!: HTMLElement;
  private facetEls!: Record<"category" | "book" | "tag" | "state" | "period", HTMLElement>;
  private bookCountEl!: HTMLElement;

  constructor(plugin: ReadwiseSearchPlugin, opts: BrowserOpenOptions = {}) {
    super(plugin.app);
    this.plugin = plugin;
    this.target = opts.target;
    this.query = opts.query ?? "";
    this.sort = plugin.settings.defaultSort;
    opts.filters?.categories?.forEach((c) => this.categories.add(c));
    opts.filters?.bookIds?.forEach((id) => this.bookIds.add(id));
    opts.filters?.tagNames?.forEach((t) => this.tagNames.add(t));
    if (this.target) {
      try {
        this.targetText = this.target.editor.getRange(this.target.from, this.target.to);
      } catch {
        this.target = undefined;
      }
    }
  }

  onOpen() {
    this.modalEl.addClass("a4p-rw-browser");
    this.indexBooks();
    this.buildLayout();
    this.registerKeys();
    this.refresh();
    this.focusInput();
    // Obsidian이 창을 연 직후 포커스를 창 자체로 옮기므로 다음 틱에 검색칸으로 다시 가져온다
    window.setTimeout(() => this.focusInput(), 0);

    // 좁은 창(모바일·작은 화면)에서는 한 단으로 접는다
    this.resizeObserver = new ResizeObserver(() => {
      this.modalEl.toggleClass("is-narrow", this.modalEl.clientWidth < NARROW_PX);
    });
    this.resizeObserver.observe(this.modalEl);
  }

  onClose() {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.resizeObserver?.disconnect();
    this.contentEl.empty();
  }

  // ───────── 데이터 ─────────

  /** 같은 책의 앞뒤 밑줄을 찾기 위한 책별 목록 (위치 → 하이라이트한 시각 순) */
  private indexBooks() {
    for (const book of this.plugin.cache.books) {
      const items = (book.highlights ?? []).filter(
        (h) => !h.is_deleted || this.plugin.noteIndex.has(h.id),
      );
      items.sort(
        (a, b) =>
          (a.location ?? 0) - (b.location ?? 0) ||
          highlightTime(a).localeCompare(highlightTime(b)),
      );
      this.byBook.set(book.user_book_id, items);
    }
  }

  /** 필터·정렬·카드를 누른 뒤에도 바로 타이핑과 ↑↓·Enter가 되게 검색칸으로 돌아온다 */
  private focusInput() {
    this.inputEl.focus({ preventScroll: true });
    const end = this.inputEl.value.length;
    this.inputEl.setSelectionRange(end, end);
  }

  private refresh() {
    const outcome = queryAll(this.plugin.cache.books, this.query, (id) =>
      this.plugin.noteIndex.has(id),
    );
    this.mode = outcome.mode;
    this.terms = outcome.terms;
    this.counts = this.countFacets(outcome.hits);
    const list = outcome.hits.filter((hit) => this.passes(hit));
    sortHits(list, this.mode, this.sort, this.terms.length > 0);
    this.list = list;
    this.shown = PAGE;
    if (!this.current || !list.some((h) => h.highlight.id === this.current!.highlight.id)) {
      this.current = list[0] ?? null;
    }
    this.renderFacets();
    this.renderSort();
    this.renderStatus();
    this.renderList();
    this.renderPreview();
    this.renderSelection();
    // 필터 단추 등을 누른 경우에만 검색칸으로 돌아온다. 검색칸에서 타이핑 중이면 건드리지 않는다
    // (커서를 옮기면 한글 조합이 끊긴다)
    const active = document.activeElement;
    if (active !== this.inputEl && active !== this.bookInputEl) this.focusInput();
  }

  private passes(hit: SearchHit, skip?: FacetKey): boolean {
    const h = hit.highlight;
    const book = hit.book;
    if (skip !== "category" && this.categories.size > 0 && !this.categories.has(book.category)) {
      return false;
    }
    if (skip !== "book" && this.bookIds.size > 0 && !this.bookIds.has(book.user_book_id)) {
      return false;
    }
    if (skip !== "tag" && this.tagNames.size > 0 && !tagsOf(hit).some((t) => this.tagNames.has(t))) {
      return false;
    }
    if (skip !== "state") {
      if (this.onlyMemo && !(h.note ?? "").trim()) return false;
      if (this.onlyNoted && !this.plugin.noteIndex.has(h.id)) return false;
      if (this.onlyFavorite && !h.is_favorite) return false;
    }
    if (skip !== "period" && !this.inPeriod(h)) return false;
    return true;
  }

  private inPeriod(h: ReadwiseHighlight): boolean {
    const days = PERIODS.find(([p]) => p === this.period)?.[2] ?? Infinity;
    if (days === Infinity) return true;
    const t = Date.parse(highlightTime(h));
    return !isNaN(t) && Date.now() - t <= days * DAY_MS;
  }

  /** 각 필터의 건수 — 그 필터 자신을 뺀 나머지 조건으로 센다 (눌렀을 때 몇 건이 될지 보이게) */
  private countFacets(base: SearchHit[]): FacetCounts {
    const c: FacetCounts = {
      categories: new Map(),
      books: new Map(),
      tags: new Map(),
      memo: 0,
      noted: 0,
      favorite: 0,
    };
    for (const hit of base) {
      const h = hit.highlight;
      if (this.passes(hit, "category")) {
        c.categories.set(hit.book.category, (c.categories.get(hit.book.category) ?? 0) + 1);
      }
      if (this.passes(hit, "book")) {
        const e = c.books.get(hit.book.user_book_id) ?? { book: hit.book, count: 0 };
        e.count++;
        c.books.set(hit.book.user_book_id, e);
      }
      if (this.passes(hit, "tag")) {
        for (const t of tagsOf(hit)) c.tags.set(t, (c.tags.get(t) ?? 0) + 1);
      }
      if (this.passes(hit, "state")) {
        if ((h.note ?? "").trim()) c.memo++;
        if (this.plugin.noteIndex.has(h.id)) c.noted++;
        if (h.is_favorite) c.favorite++;
      }
    }
    return c;
  }

  private hasActiveFilters(): boolean {
    return (
      this.categories.size > 0 ||
      this.bookIds.size > 0 ||
      this.tagNames.size > 0 ||
      this.onlyMemo ||
      this.onlyNoted ||
      this.onlyFavorite ||
      this.period !== "all"
    );
  }

  private resetFilters() {
    this.categories.clear();
    this.bookIds.clear();
    this.tagNames.clear();
    this.onlyMemo = false;
    this.onlyNoted = false;
    this.onlyFavorite = false;
    this.period = "all";
    this.refresh();
  }

  // ───────── 뼈대 ─────────

  private buildLayout() {
    const root = this.contentEl;
    root.empty();
    root.addClass("a4p-rw-b-root");

    const head = root.createDiv({ cls: "a4p-rw-b-head" });
    const title = head.createDiv({ cls: "a4p-rw-b-title" });
    setIcon(title.createSpan({ cls: "a4p-rw-b-title-icon" }), "book-open");
    title.createSpan({ text: "Readwise 하이라이트" });
    const total = this.plugin.cache.books.reduce((n, b) => n + (b.highlights?.length ?? 0), 0);
    title.createSpan({ cls: "a4p-rw-b-pill", text: total.toLocaleString() });
    if (this.target) {
      head.createSpan({ cls: "a4p-rw-b-hint", text: "고른 밑줄이 노트의 ,, 자리에 들어갑니다" });
    }
    const syncBtn = head.createEl("button", { cls: "a4p-rw-b-ghost a4p-rw-b-sync" });
    setIcon(syncBtn.createSpan(), "refresh-cw");
    syncBtn.createSpan({ text: "동기화" });
    syncBtn.setAttr("aria-label", "Readwise에서 바뀐 것만 받아오기");
    syncBtn.addEventListener("click", () => void this.runSync(syncBtn));

    const body = root.createDiv({ cls: "a4p-rw-b-body" });
    this.buildFacets(body.createDiv({ cls: "a4p-rw-b-facets" }));
    const center = body.createDiv({ cls: "a4p-rw-b-center" });
    this.buildToolbar(center);
    this.listEl = center.createDiv({ cls: "a4p-rw-b-list" });
    this.previewEl = body.createDiv({ cls: "a4p-rw-b-preview" });

    const foot = root.createDiv({ cls: "a4p-rw-b-foot" });
    const mod = Platform.isMacOS ? "⌘" : "Ctrl";
    const alt = Platform.isMacOS ? "⌥" : "Alt";
    const hints: Array<[string[], string]> = [
      [["↑", "↓"], "이동"],
      [["Enter"], "인용 넣기"],
      [["Shift", "Enter"], "메모 노트"],
      [[alt, "Enter"], "고르기"],
      [[mod, "Enter"], "고른 것 넣기"],
      [["Esc"], "닫기"],
    ];
    for (const [keys, label] of hints) {
      const hint = foot.createSpan({ cls: "a4p-rw-b-key" });
      keys.forEach((k, i) => {
        if (i > 0) hint.appendText("+");
        hint.createEl("kbd", { text: k });
      });
      hint.appendText(` ${label}`);
    }
    this.selectionEl = foot.createDiv({ cls: "a4p-rw-b-selection" });
  }

  private buildFacets(el: HTMLElement) {
    const section = (title: string, icon?: string) => {
      const sec = el.createDiv({ cls: "a4p-rw-b-fsec" });
      const h = sec.createDiv({ cls: "a4p-rw-b-fsec-title" });
      if (icon) setIcon(h.createSpan({ cls: "a4p-rw-b-fsec-icon" }), icon);
      h.createSpan({ text: title });
      return { sec, h };
    };
    const category = section("종류");
    const book = section("책", "book");
    this.bookCountEl = book.h.createSpan({ cls: "a4p-rw-b-fsec-count" });
    this.bookInputEl = book.sec.createEl("input", {
      cls: "a4p-rw-b-fsearch",
      attr: { type: "text", placeholder: "책·저자 찾기" },
    });
    this.bookInputEl.addEventListener("input", () => {
      this.bookQuery = this.bookInputEl.value.trim();
      this.renderBookFacet();
    });
    const tag = section("태그", "tag");
    const state = section("상태");
    const period = section("기간", "calendar");
    this.facetEls = {
      category: category.sec.createDiv({ cls: "a4p-rw-b-fitems" }),
      book: book.sec.createDiv({ cls: "a4p-rw-b-fitems" }),
      tag: tag.sec.createDiv({ cls: "a4p-rw-b-fitems" }),
      state: state.sec.createDiv({ cls: "a4p-rw-b-fitems" }),
      period: period.sec.createDiv({ cls: "a4p-rw-b-seg a4p-rw-b-seg-full" }),
    };
  }

  private buildToolbar(center: HTMLElement) {
    const bar = center.createDiv({ cls: "a4p-rw-b-toolbar" });
    const row = bar.createDiv({ cls: "a4p-rw-b-row" });
    const wrap = row.createDiv({ cls: "a4p-rw-b-search" });
    setIcon(wrap.createSpan({ cls: "a4p-rw-b-search-icon" }), "search");
    this.inputEl = wrap.createEl("input", {
      attr: { type: "text", placeholder: "밑줄 검색 — 띄어 쓰면 모두 포함 (예: 고난 소망)" },
    });
    this.inputEl.value = this.query;
    const clear = wrap.createSpan({ cls: "a4p-rw-b-clear" });
    setIcon(clear, "x");
    clear.setAttr("aria-label", "검색어 지우기");
    const syncClear = () => wrap.toggleClass("has-value", this.inputEl.value.length > 0);
    syncClear();
    this.inputEl.addEventListener("input", () => {
      syncClear();
      if (this.timer !== null) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => {
        this.timer = null;
        this.query = this.inputEl.value;
        this.refresh();
      }, DEBOUNCE_MS);
    });
    clear.addEventListener("click", () => {
      this.inputEl.value = "";
      syncClear();
      this.query = "";
      this.refresh();
      this.inputEl.focus();
    });
    // 좁은 창에서만 보이는 필터 열기 단추
    const filterBtn = row.createEl("button", { cls: "a4p-rw-b-ghost a4p-rw-b-filter-toggle" });
    setIcon(filterBtn.createSpan(), "sliders-horizontal");
    filterBtn.createSpan({ text: "필터" });
    filterBtn.addEventListener("click", () => this.modalEl.toggleClass("show-facets", !this.modalEl.hasClass("show-facets")));

    const row2 = bar.createDiv({ cls: "a4p-rw-b-row" });
    this.sortEl = row2.createDiv({ cls: "a4p-rw-b-seg" });
    this.statusEl = row2.createDiv({ cls: "a4p-rw-b-status" });
  }

  // ───────── 필터 ─────────

  private renderFacets() {
    this.renderCategoryFacet();
    this.renderBookFacet();
    this.renderTagFacet();
    this.renderStateFacet();
    this.renderPeriodFacet();
  }

  private facetItem(
    parent: HTMLElement,
    label: string,
    count: number,
    on: boolean,
    onClick: () => void,
    opts: { icon?: string; dotCls?: string; title?: string } = {},
  ) {
    const btn = parent.createEl("button", { cls: "a4p-rw-b-fitem" });
    if (on) btn.addClass("is-on");
    if (opts.dotCls) btn.createSpan({ cls: `a4p-rw-b-dot ${opts.dotCls}` });
    if (opts.icon) setIcon(btn.createSpan({ cls: "a4p-rw-b-fitem-icon" }), opts.icon);
    btn.createSpan({ cls: "a4p-rw-b-fitem-label", text: label });
    btn.createSpan({ cls: "a4p-rw-b-fitem-count", text: count.toLocaleString() });
    if (opts.title) btn.setAttr("aria-label", opts.title);
    btn.addEventListener("click", onClick);
    return btn;
  }

  private renderCategoryFacet() {
    const el = this.facetEls.category;
    el.empty();
    const counts = this.counts?.categories ?? new Map<string, number>();
    const cats = CATEGORY_ORDER.filter((c) => (counts.get(c) ?? 0) > 0 || this.categories.has(c));
    for (const c of cats) {
      this.facetItem(el, CATEGORY_LABELS[c] ?? c, counts.get(c) ?? 0, this.categories.has(c), () => {
        toggle(this.categories, c);
        this.refresh();
      }, { dotCls: `is-${c}` });
    }
    if (cats.length === 0) el.createDiv({ cls: "a4p-rw-b-fempty", text: "없음" });
  }

  private renderBookFacet() {
    const el = this.facetEls.book;
    el.empty();
    const entries = Array.from(this.counts?.books.values() ?? []);
    // 고른 책은 건수가 0이 되어도 풀 수 있게 남긴다
    for (const id of this.bookIds) {
      if (!entries.some((e) => e.book.user_book_id === id)) {
        const book = this.plugin.cache.books.find((b) => b.user_book_id === id);
        if (book) entries.push({ book, count: 0 });
      }
    }
    const q = this.bookQuery.toLowerCase();
    const matched = entries
      .filter((e) => !q || (e.book.title ?? "").toLowerCase().includes(q) || (e.book.author ?? "").toLowerCase().includes(q))
      .sort(
        (a, b) =>
          Number(this.bookIds.has(b.book.user_book_id)) - Number(this.bookIds.has(a.book.user_book_id)) ||
          b.count - a.count ||
          (a.book.title ?? "").localeCompare(b.book.title ?? "", "ko"),
      );
    this.bookCountEl.setText(String(matched.length));
    const limit = q || this.showAllBooks ? 300 : BOOKS_VISIBLE;
    for (const { book, count } of matched.slice(0, limit)) {
      const id = book.user_book_id;
      this.facetItem(el, book.title || "제목 없음", count, this.bookIds.has(id), () => {
        toggle(this.bookIds, id);
        this.refresh();
      }, { dotCls: `is-${book.category}`, title: book.author ? `${book.title} — ${book.author}` : book.title });
    }
    if (matched.length === 0) el.createDiv({ cls: "a4p-rw-b-fempty", text: q ? "맞는 책이 없습니다" : "없음" });
    if (!q && matched.length > BOOKS_VISIBLE) {
      const more = el.createEl("button", {
        cls: "a4p-rw-b-more",
        text: this.showAllBooks ? "접기" : `+${matched.length - BOOKS_VISIBLE} 더보기`,
      });
      more.addEventListener("click", () => {
        this.showAllBooks = !this.showAllBooks;
        this.renderBookFacet();
      });
    }
  }

  private renderTagFacet() {
    const el = this.facetEls.tag;
    el.empty();
    const counts = this.counts?.tags ?? new Map<string, number>();
    for (const t of this.tagNames) if (!counts.has(t)) counts.set(t, 0);
    const tags = Array.from(counts.entries()).sort(
      (a, b) => Number(this.tagNames.has(b[0])) - Number(this.tagNames.has(a[0])) || b[1] - a[1],
    );
    const limit = this.showAllTags ? 300 : TAGS_VISIBLE;
    for (const [tag, n] of tags.slice(0, limit)) {
      this.facetItem(el, `#${tag}`, n, this.tagNames.has(tag), () => {
        toggle(this.tagNames, tag);
        this.refresh();
      });
    }
    if (tags.length === 0) el.createDiv({ cls: "a4p-rw-b-fempty", text: "태그 없음" });
    if (tags.length > TAGS_VISIBLE) {
      const more = el.createEl("button", {
        cls: "a4p-rw-b-more",
        text: this.showAllTags ? "접기" : `+${tags.length - TAGS_VISIBLE} 더보기`,
      });
      more.addEventListener("click", () => {
        this.showAllTags = !this.showAllTags;
        this.renderTagFacet();
      });
    }
  }

  private renderStateFacet() {
    const el = this.facetEls.state;
    el.empty();
    const c = this.counts;
    this.facetItem(el, "메모 있음", c?.memo ?? 0, this.onlyMemo, () => {
      this.onlyMemo = !this.onlyMemo;
      this.refresh();
    }, { icon: "message-square", title: "Readwise에 메모를 남긴 밑줄만" });
    this.facetItem(el, "노트 만든 것", c?.noted ?? 0, this.onlyNoted, () => {
      this.onlyNoted = !this.onlyNoted;
      this.refresh();
    }, { icon: "file-check", title: "메모 노트를 만든 밑줄만" });
    this.facetItem(el, "즐겨찾기", c?.favorite ?? 0, this.onlyFavorite, () => {
      this.onlyFavorite = !this.onlyFavorite;
      this.refresh();
    }, { icon: "star", title: "Readwise에서 즐겨찾기한 밑줄만" });
  }

  private renderPeriodFacet() {
    const el = this.facetEls.period;
    el.empty();
    for (const [p, label] of PERIODS) {
      const btn = el.createEl("button", { text: label });
      if (this.period === p) btn.addClass("is-on");
      btn.addEventListener("click", () => {
        this.period = p;
        this.refresh();
      });
    }
  }

  // ───────── 가운데 ─────────

  private renderSort() {
    this.sortEl.empty();
    const forced = this.mode === "partial";
    for (const [s, label] of SORTS) {
      const btn = this.sortEl.createEl("button", { text: label });
      if ((forced ? "relevance" : this.sort) === s) btn.addClass("is-on");
      if (forced && s !== "relevance") btn.setAttr("aria-label", "일부만 맞는 결과는 맞은 낱말 수 순으로 보여 줍니다");
      btn.addEventListener("click", () => {
        this.sort = s;
        this.refresh();
      });
    }
  }

  private renderStatus() {
    const el = this.statusEl;
    el.empty();
    el.createEl("b", { text: `${this.list.length.toLocaleString()}건` });
    if (this.mode === "stem") el.createSpan({ cls: "a4p-rw-b-mode", text: " · 조사를 뗀 낱말로 찾음" });
    if (this.mode === "partial") {
      el.createSpan({ cls: "a4p-rw-b-mode", text: " · 모든 낱말이 든 결과가 없어 일부만 맞는 결과" });
    }
    const parts: string[] = [];
    if (this.categories.size) parts.push(`종류 ${this.categories.size}`);
    if (this.bookIds.size) parts.push(`책 ${this.bookIds.size}`);
    if (this.tagNames.size) parts.push(`태그 ${this.tagNames.size}`);
    if (this.onlyMemo) parts.push("메모 있음");
    if (this.onlyNoted) parts.push("노트 만든 것");
    if (this.onlyFavorite) parts.push("즐겨찾기");
    if (this.period !== "all") parts.push(PERIODS.find(([p]) => p === this.period)?.[1] ?? "");
    if (parts.length) {
      el.appendText(` · 필터: ${parts.join(" · ")}`);
      const reset = el.createEl("button", { cls: "a4p-rw-b-reset", text: "필터 초기화" });
      reset.addEventListener("click", () => this.resetFilters());
    }
  }

  private renderList() {
    const el = this.listEl;
    el.empty();
    if (this.plugin.cache.books.length === 0) {
      this.renderEmpty(el, "book-marked", "아직 동기화된 데이터가 없습니다", "설정 → A4P Readwise Search 에서 토큰 입력 후 '전체 동기화'를 실행해주세요.");
      return;
    }
    if (this.list.length === 0) {
      this.renderEmpty(
        el,
        "search-x",
        "맞는 밑줄이 없습니다",
        this.hasActiveFilters() ? "낱말을 줄이거나 필터를 풀어 보세요." : "낱말을 줄이거나 다른 말로 찾아보세요.",
      );
      return;
    }
    for (const hit of this.list.slice(0, this.shown)) this.renderCard(hit);
    this.renderMoreButton();
  }

  private renderMoreButton() {
    const left = this.list.length - this.shown;
    if (left <= 0) return;
    const more = this.listEl.createEl("button", {
      cls: "a4p-rw-b-ghost a4p-rw-b-loadmore",
      text: `${left.toLocaleString()}건 더 보기`,
    });
    more.addEventListener("click", () => this.showMore());
  }

  private showMore() {
    const from = this.shown;
    this.shown += PAGE;
    this.listEl.querySelector(".a4p-rw-b-loadmore")?.remove();
    for (const hit of this.list.slice(from, this.shown)) this.renderCard(hit);
    this.renderMoreButton();
  }

  private renderEmpty(el: HTMLElement, icon: string, title: string, sub: string) {
    const box = el.createDiv({ cls: "a4p-rw-b-empty" });
    setIcon(box.createDiv({ cls: "a4p-rw-b-empty-icon" }), icon);
    box.createDiv({ cls: "a4p-rw-b-empty-title", text: title });
    box.createDiv({ cls: "a4p-rw-b-empty-sub", text: sub });
  }

  private renderCard(hit: SearchHit) {
    const h = hit.highlight;
    const book = hit.book;
    const card = this.listEl.createDiv({ cls: `a4p-rw-bcard is-${book.category}` });
    card.dataset.id = String(h.id);
    if (this.current?.highlight.id === h.id) card.addClass("is-current");
    if (this.selected.has(h.id)) card.addClass("is-selected");

    const check = card.createSpan({ cls: "a4p-rw-bcard-check" });
    check.setAttr("aria-label", "여러 개 고르기");
    check.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleSelect(hit);
    });

    const body = card.createDiv({ cls: "a4p-rw-bcard-body" });
    const meta = body.createDiv({ cls: "a4p-rw-bcard-meta" });
    renderTextWithMarks(meta.createSpan({ cls: "a4p-rw-bcard-title" }), book.title || "제목 없음", this.terms);
    const author = book.author?.trim();
    if (author) renderTextWithMarks(meta.createSpan({ cls: "a4p-rw-bcard-author" }), author, this.terms);
    meta.createSpan({
      cls: `a4p-rw-category-chip is-${book.category}`,
      text: CATEGORY_LABELS[book.category] ?? book.category,
    });
    const loc = locationLabel({ location: h.location, locationType: h.location_type });
    if (loc) meta.createSpan({ cls: "a4p-rw-bcard-loc", text: loc });
    const when = formatRelative(highlightTime(h));
    if (when) meta.createSpan({ cls: "a4p-rw-bcard-time", text: when });

    renderTextWithMarks(
      body.createDiv({ cls: "a4p-rw-bcard-text" }),
      snippetAround(h.text ?? "", this.terms, 220),
      this.terms,
    );

    const tags = tagsOf(hit);
    const noted = this.plugin.noteIndex.has(h.id);
    if ((h.note ?? "").trim() || noted || h.is_deleted || tags.length) {
      const foot = body.createDiv({ cls: "a4p-rw-bcard-foot" });
      if ((h.note ?? "").trim()) badge(foot, "message-square", "메모");
      if (noted) badge(foot, "file-check", "노트 있음", "is-noted");
      if (h.is_deleted) badge(foot, "trash-2", "Readwise에서 삭제됨", "is-deleted");
      for (const t of tags.slice(0, 4)) foot.createSpan({ cls: "a4p-rw-bcard-tag", text: `#${t}` });
    }

    card.addEventListener("click", () => {
      this.setCurrent(hit, false);
      if (this.modalEl.hasClass("is-narrow")) this.modalEl.addClass("show-preview");
      else this.focusInput();
    });
    card.addEventListener("dblclick", () => this.insertHits([hit]));
  }

  private setCurrent(hit: SearchHit, scroll: boolean) {
    this.current = hit;
    this.listEl.querySelectorAll(".a4p-rw-bcard").forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const on = el.dataset.id === String(hit.highlight.id);
      el.toggleClass("is-current", on);
      if (on && scroll) el.scrollIntoView({ block: "nearest" });
    });
    this.renderPreview();
  }

  private move(delta: number) {
    if (this.list.length === 0) return;
    const i = this.current ? this.list.findIndex((h) => h.highlight.id === this.current!.highlight.id) : -1;
    const next = Math.min(this.list.length - 1, Math.max(0, i + delta));
    if (next >= this.shown) this.showMore();
    this.setCurrent(this.list[next], true);
  }

  private toggleSelect(hit: SearchHit) {
    const id = hit.highlight.id;
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.set(id, hit);
    this.listEl
      .querySelector(`.a4p-rw-bcard[data-id="${id}"]`)
      ?.toggleClass("is-selected", this.selected.has(id));
    this.renderSelection();
  }

  private renderSelection() {
    const el = this.selectionEl;
    el.empty();
    const n = this.selected.size;
    el.toggleClass("is-on", n > 0);
    if (n === 0) return;
    el.createEl("b", { text: `${n}개 고름` });
    const insert = el.createEl("button", { cls: "a4p-rw-b-cta" });
    setIcon(insert.createSpan(), "quote");
    insert.createSpan({ text: `고른 ${n}개 넣기` });
    insert.addEventListener("click", () => this.insertHits(Array.from(this.selected.values())));
    const clear = el.createEl("button", { cls: "a4p-rw-b-ghost", text: "고르기 해제" });
    clear.addEventListener("click", () => {
      this.selected.clear();
      this.listEl.querySelectorAll(".a4p-rw-bcard.is-selected").forEach((c) => c.removeClass("is-selected"));
      this.renderSelection();
    });
  }

  // ───────── 미리보기 ─────────

  private renderPreview() {
    const el = this.previewEl;
    el.empty();
    for (const c of CATEGORY_ORDER) el.removeClass(`is-${c}`);
    const hit = this.current;
    if (!hit) {
      this.renderEmpty(el, "panel-right", "미리보기", "목록에서 밑줄을 고르면 전문·메모·앞뒤 맥락이 여기에 보입니다.");
      return;
    }
    const h = hit.highlight;
    const book = hit.book;
    el.addClass(`is-${book.category}`);

    const back = el.createEl("button", { cls: "a4p-rw-b-ghost a4p-rw-b-back" });
    setIcon(back.createSpan(), "arrow-left");
    back.createSpan({ text: "목록" });
    back.addEventListener("click", () => this.modalEl.removeClass("show-preview"));

    const head = el.createDiv({ cls: "a4p-rw-b-pv-head" });
    head.createDiv({ cls: "a4p-rw-b-pv-title", text: book.title || "제목 없음" });
    const sub = head.createDiv({ cls: "a4p-rw-b-pv-sub" });
    if (book.author) sub.createSpan({ text: book.author });
    sub.createSpan({
      cls: `a4p-rw-category-chip is-${book.category}`,
      text: CATEGORY_LABELS[book.category] ?? book.category,
    });
    const loc = locationLabel({ location: h.location, locationType: h.location_type });
    if (loc) sub.createSpan({ text: loc });
    const date = highlightTime(h).slice(0, 10);
    if (date) sub.createSpan({ text: `${date} 밑줄` });
    const siblings = this.byBook.get(book.user_book_id) ?? [];
    const pos = siblings.findIndex((x) => x.id === h.id);
    if (pos >= 0) sub.createSpan({ text: `이 책 ${siblings.length}개 중 ${pos + 1}번째` });
    if (h.is_deleted) sub.createSpan({ cls: "a4p-rw-deleted-chip", text: "Readwise에서 삭제됨" });

    renderTextWithMarks(el.createDiv({ cls: "a4p-rw-b-pv-text" }), (h.text ?? "").trim(), this.terms);

    const note = (h.note ?? "").trim();
    if (note) {
      const box = el.createDiv({ cls: "a4p-rw-b-pv-note" });
      box.createDiv({ cls: "a4p-rw-b-pv-label", text: "Readwise 메모" });
      renderTextWithMarks(box.createDiv(), note, this.terms);
    }
    const tags = tagsOf(hit);
    if (tags.length) {
      const row = el.createDiv({ cls: "a4p-rw-bcard-foot" });
      for (const t of tags) row.createSpan({ cls: "a4p-rw-bcard-tag", text: `#${t}` });
    }

    const actions = el.createDiv({ cls: "a4p-rw-b-pv-actions" });
    const insert = actions.createEl("button", { cls: "a4p-rw-b-cta" });
    setIcon(insert.createSpan(), "quote");
    insert.createSpan({ text: "인용 넣기" });
    insert.addEventListener("click", () => this.insertHits([hit]));
    const fmt = actions.createEl("select", { cls: "dropdown a4p-rw-b-fmt" });
    for (const [value, label] of Object.entries(CITATION_FORMAT_LABELS)) {
      fmt.createEl("option", { value, text: label.replace(/ — .*/, "") });
    }
    fmt.value = this.plugin.settings.citationFormat;
    fmt.setAttr("aria-label", "인용 형식 — 바꾸면 설정에도 저장됩니다");
    const noted = this.plugin.noteIndex.has(h.id);
    const memo = actions.createEl("button", { cls: "a4p-rw-b-ghost" });
    setIcon(memo.createSpan(), noted ? "file-check" : "file-plus");
    memo.createSpan({ text: noted ? "노트 열기" : "메모 노트" });
    memo.addEventListener("click", () => this.openMemo(hit));
    const copy = actions.createEl("button", { cls: "a4p-rw-b-ghost" });
    setIcon(copy.createSpan(), "copy");
    copy.createSpan({ text: "복사" });
    copy.addEventListener("click", () => void this.copy(hit));
    const url = h.readwise_url || book.readwise_url;
    if (url) {
      const link = actions.createEl("a", { cls: "a4p-rw-b-ghost", href: url });
      setIcon(link.createSpan(), "external-link");
      link.createSpan({ text: "Readwise" });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }

    const outSec = el.createDiv({ cls: "a4p-rw-b-pv-sec" });
    outSec.createDiv({ cls: "a4p-rw-b-pv-label", text: "넣을 모양" });
    const out = outSec.createEl("pre", { cls: "a4p-rw-b-pv-out" });
    out.setText(formatHitCitation(hit, citationOptions(this.plugin.settings)));
    fmt.addEventListener("change", async () => {
      this.plugin.settings.citationFormat = fmt.value as CitationFormat;
      await this.plugin.persist();
      out.setText(formatHitCitation(hit, citationOptions(this.plugin.settings)));
    });

    if (pos >= 0 && siblings.length > 1) {
      const ctx = el.createDiv({ cls: "a4p-rw-b-pv-sec" });
      const label = ctx.createDiv({ cls: "a4p-rw-b-pv-label" });
      setIcon(label.createSpan({ cls: "a4p-rw-b-pv-label-icon" }), "layers");
      label.createSpan({ text: "같은 책의 앞뒤 밑줄" });
      for (const sib of siblings.slice(Math.max(0, pos - 2), pos + 3)) {
        const item = ctx.createDiv({ cls: "a4p-rw-b-ctx" });
        if (sib.id === h.id) item.addClass("is-me");
        item.createSpan({ cls: "a4p-rw-b-ctx-num", text: String(siblings.indexOf(sib) + 1) });
        item.appendText((sib.text ?? "").replace(/\s+/g, " ").trim());
        if (sib.id !== h.id) {
          item.addEventListener("click", () => {
            const inList = this.list.find((x) => x.highlight.id === sib.id);
            this.setCurrent(inList ?? { highlight: sib, book, score: 0 }, true);
          });
        }
      }
    }
  }

  // ───────── 동작 ─────────

  private registerKeys() {
    // 책 찾기 칸·형식 선택 같은 다른 입력칸에서는 키를 그 칸에 맡긴다
    const typingElsewhere = () => {
      const a = document.activeElement;
      return (
        a instanceof HTMLSelectElement ||
        a instanceof HTMLTextAreaElement ||
        (a instanceof HTMLInputElement && a !== this.inputEl)
      );
    };
    // 창이 화면에서 떨어져 나갔으면(다른 코드가 DOM을 걷어 낸 경우) 어떤 키에도 반응하지 않는다
    const detached = () => !this.modalEl.isConnected;
    // 단추·링크에 포커스가 있을 때 Enter는 그 단추를 누르는 것으로 둔다
    const onControl = () => {
      const a = document.activeElement;
      return a instanceof HTMLButtonElement || a instanceof HTMLAnchorElement;
    };
    this.scope.register([], "ArrowDown", () => {
      if (detached() || typingElsewhere()) return true;
      this.move(1);
      return false;
    });
    this.scope.register([], "ArrowUp", () => {
      if (detached() || typingElsewhere()) return true;
      this.move(-1);
      return false;
    });
    this.scope.register([], "Enter", (evt) => {
      if (detached() || typingElsewhere() || onControl() || evt.isComposing) return true;
      if (this.current) this.insertHits([this.current]);
      return false;
    });
    this.scope.register(["Shift"], "Enter", (evt) => {
      if (detached() || typingElsewhere() || onControl() || evt.isComposing) return true;
      if (this.current) this.openMemo(this.current);
      return false;
    });
    this.scope.register(["Alt"], "Enter", () => {
      if (detached()) return true;
      if (this.current) this.toggleSelect(this.current);
      return false;
    });
    this.scope.register(["Mod"], "Enter", () => {
      if (detached()) return true;
      const hits = this.selected.size ? Array.from(this.selected.values()) : this.current ? [this.current] : [];
      this.insertHits(hits);
      return false;
    });
  }

  private insertHits(hits: SearchHit[]) {
    if (hits.length === 0) return;
    const opts = citationOptions(this.plugin.settings);
    const parts = hits.map((h) => formatHitCitation(h, opts));
    const text = parts.length === 1 ? parts[0] : joinCitations(parts);
    const target = this.target;
    this.target = undefined;
    this.close();
    // ,,로 열었으면 그 자리를 바꾼다. 창을 연 사이 노트가 바뀌었으면 커서 자리에 넣는다
    if (target && this.targetUnchanged(target)) {
      replaceWithCitation(target.editor, text, target.from, target.to);
      target.editor.focus();
      return;
    }
    insertCitationText(this.app, text);
  }

  private targetUnchanged(target: BrowserTarget): boolean {
    try {
      return target.editor.getRange(target.from, target.to) === this.targetText;
    } catch {
      return false;
    }
  }

  private openMemo(hit: SearchHit) {
    this.close();
    void createHighlightNoteFromHit(this.app, this.plugin.settings, this.plugin.noteIndex, hit);
  }

  private async copy(hit: SearchHit) {
    const text = formatHitCitation(hit, citationOptions(this.plugin.settings));
    try {
      await navigator.clipboard.writeText(text);
      new Notice("인용을 복사했습니다.");
    } catch {
      new Notice("복사하지 못했습니다.");
    }
  }

  private async runSync(btn: HTMLButtonElement) {
    if (this.plugin.sync.isRunning()) return;
    btn.setAttr("disabled", "true");
    btn.addClass("is-syncing");
    try {
      await this.plugin.sync.run({ full: false });
    } finally {
      btn.removeAttribute("disabled");
      btn.removeClass("is-syncing");
    }
    this.byBook.clear();
    this.indexBooks();
    this.refresh();
    this.plugin.notifyViews();
  }
}

function tagsOf(hit: SearchHit): string[] {
  return Array.from(
    new Set([
      ...(hit.highlight.tags ?? []).map((t) => t.name),
      ...(hit.book.book_tags ?? []).map((t) => t.name),
    ]),
  );
}

function toggle<T>(set: Set<T>, value: T) {
  if (set.has(value)) set.delete(value);
  else set.add(value);
}

function badge(parent: HTMLElement, icon: string, text: string, cls = "") {
  const el = parent.createSpan({ cls: `a4p-rw-bcard-badge ${cls}`.trim() });
  setIcon(el.createSpan(), icon);
  el.createSpan({ text });
}
