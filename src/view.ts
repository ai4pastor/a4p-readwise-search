import {
  debounce,
  getAllTags,
  ItemView,
  Menu,
  Notice,
  parseFrontMatterAliases,
  setIcon,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import {
  ReadwiseApiError,
  ReadwiseAuthError,
  ReadwiseClient,
  ReadwiseNoReviewError,
  ReadwiseRateLimitError,
} from "./api";
import { BookSuggestModal } from "./book-suggest-modal";
import {
  citationOptions,
  formatDailyCitation,
  formatHitCitation,
  insertCitation,
  insertDailyCitation,
  insertDailyCitations,
} from "./citation";
import { renderCover } from "./cover";
import {
  createHighlightNoteFromDaily,
  createHighlightNoteFromHit,
} from "./highlight-note";
import {
  ActiveFilters,
  collectFilterOptions,
  FilterOptions,
  hasActiveFilters,
} from "./filters";
import { formatRelative, renderTextWithMarks } from "./hit-render";
import type ReadwiseSearchPlugin from "./main";
import { NoteIndexChange, parseHighlightId } from "./note-index";
import { describeQuery } from "./query";
import { extractTerms, findRelated, NoteTerm } from "./related";
import { highlightTime, SearchHit, searchWithFallback, SortMode } from "./search";
import { DailyReview, DailyReviewHighlight } from "./types";

export const VIEW_TYPE_READWISE_SEARCH = "a4p-readwise-search-view";

export type ReadwiseTab = "search" | "related" | "daily";

const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 280;
const TAG_VISIBLE_LIMIT = 20;
/** 카드의 출처 줄에 보이는 태그 수 */
const CARD_TAGS = 3;

const TABS: { key: ReadwiseTab; label: string; tip: string }[] = [
  { key: "search", label: "검색", tip: "밑줄 검색" },
  { key: "related", label: "관련", tip: "지금 쓰는 노트와 닿는 밑줄" },
  { key: "daily", label: "복습", tip: "오늘의 복습 (Readwise Daily Review)" },
];

const SORT_LABELS: Record<SortMode, string> = {
  recent: "최신순",
  relevance: "관련도",
  book: "책별",
  oldest: "오래된순",
};

const CATEGORY_LABELS: Record<string, string> = {
  books: "책",
  articles: "아티클",
  tweets: "트윗",
  podcasts: "팟캐스트",
  supplementals: "보조자료",
};

/** 오늘의 복습 API의 source_type → 캐시의 category */
const SOURCE_TYPE_CATEGORY: Record<string, string> = {
  book: "books",
  article: "articles",
  tweet: "tweets",
  podcast: "podcasts",
  supplemental: "supplementals",
};

/** 카드 한 장을 그리는 데 필요한 것 — 검색·관련(SearchHit)과 오늘의 복습이 같은 모양을 쓴다 */
interface CardData {
  id: number;
  title: string;
  author: string | null;
  category: string | null;
  sourceUrl: string | null;
  text: string;
  note: string;
  tags: string[];
  whenIso: string | null;
  deleted: boolean;
  /** 책 한 권 보기로 넘어갈 책 (캐시에서 찾은 경우) */
  bookId: number | null;
  link: { url: string; tip: string } | null;
  citation: () => string;
  insert: () => void;
  makeNote: () => void;
}

export class ReadwiseSearchView extends ItemView {
  private plugin: ReadwiseSearchPlugin;
  private headEl!: HTMLDivElement;
  private bodyEl!: HTMLDivElement;
  private activeTab: ReadwiseTab = "search";

  // 검색 탭
  private inputEl: HTMLInputElement | null = null;
  private filtersEl: HTMLDivElement | null = null;
  private searchStatusEl: HTMLDivElement | null = null;
  private searchResultsEl: HTMLDivElement | null = null;
  private debounceTimer: number | null = null;
  private currentQuery = "";
  /** 카드에서 강조할 낱말 — 조사를 떼고 찾았으면 뗀 낱말 (searchWithFallback) */
  private markTerms: string[] = [];
  private filters: ActiveFilters = {
    bookIds: new Set(),
    tagNames: new Set(),
    categories: new Set(),
  };
  private options: FilterOptions = { books: [], tags: [], categories: [] };
  private tagsExpanded = false;
  /** 태그 칩 줄 펼침 여부 — 기본 접힘. 세션 상태, 설정에 저장 안 함 */
  private tagsOpen = false;
  private sortMode: SortMode;

  // 관련 탭
  private relatedHeadEl: HTMLDivElement | null = null;
  private relatedTermsEl: HTMLDivElement | null = null;
  private relatedStatusEl: HTMLDivElement | null = null;
  private relatedResultsEl: HTMLDivElement | null = null;
  private relatedFile: TFile | null = null;
  /** 노트마다 사용자가 끈 낱말 (세션 상태) */
  private relatedSkip = new Map<string, Set<string>>();
  private scheduleRelated = debounce(() => this.runRelated(), 600, true);

  // 복습 탭
  private dailyStatusEl: HTMLElement | null = null;
  private dailyToolsEl: HTMLElement | null = null;
  private dailyBarEl: HTMLDivElement | null = null;
  private dailyResultsEl: HTMLDivElement | null = null;
  private dailyReview: DailyReview | null = null;
  private dailyLoading = false;
  private dailyFetched = false;

  constructor(leaf: WorkspaceLeaf, plugin: ReadwiseSearchPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.sortMode = plugin.settings.defaultSort;
  }

  getViewType(): string {
    return VIEW_TYPE_READWISE_SEARCH;
  }

  getDisplayText(): string {
    return "A4P Readwise Search";
  }

  getIcon(): string {
    return "bookmark";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("a4p-rw-panel");
    this.applyFontScale();

    this.headEl = root.createDiv({ cls: "a4p-rw-head" });
    this.bodyEl = root.createDiv({ cls: "a4p-rw-body-area" });

    // 노트 생성·삭제·이동 시 해당 카드의 버튼만 제자리에서 갱신 (뷰가 닫히면 자동 해제)
    this.registerEvent(this.plugin.noteIndex.onChange((ids) => this.refreshNoteButtons(ids)));
    // 관련 탭: 다른 노트를 열거나 지금 노트의 제목·소제목·태그가 바뀌면 다시 찾는다
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        if (this.activeTab === "related") this.scheduleRelated();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.activeTab === "related" && file.path === this.relatedFile?.path) this.scheduleRelated();
      }),
    );

    this.renderHead();
    this.renderActiveTab();
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.scheduleRelated.cancel();
  }

  /** 설정의 fontScale(%)을 패널 CSS 변수로 반영 — 슬라이더 변경 시에도 호출됨 */
  applyFontScale() {
    const root = this.containerEl.children[1];
    if (!(root instanceof HTMLElement)) return;
    const scale = this.plugin.settings.fontScale / 100;
    root.style.setProperty("--a4p-rw-font-scale", String(scale));
  }

  setTab(tab: ReadwiseTab) {
    if (this.activeTab === tab) {
      if (tab === "daily" && !this.dailyFetched) void this.fetchDaily();
      return;
    }
    this.activeTab = tab;
    this.renderHead();
    this.renderActiveTab();
  }

  /** 머리줄: 탭 + 동기화·크게 보기 */
  private renderHead() {
    const el = this.headEl;
    el.empty();
    const tabs = el.createDiv({ cls: "a4p-rw-tabs" });
    tabs.setAttr("role", "tablist");
    for (const t of TABS) {
      const tab = tabs.createEl("button", { cls: "a4p-rw-tab", text: t.label });
      tab.setAttr("role", "tab");
      tab.setAttr("aria-label", t.tip);
      tab.setAttr("aria-selected", String(t.key === this.activeTab));
      if (t.key === this.activeTab) tab.addClass("is-active");
      tab.addEventListener("click", () => this.setTab(t.key));
    }

    const tools = el.createDiv({ cls: "a4p-rw-head-tools" });
    const syncBtn = iconButton(tools, "refresh-cw", "Readwise에서 바뀐 것만 받아오기");
    syncBtn.addClass("a4p-rw-sync-btn");
    syncBtn.addEventListener("click", () => void this.runSyncFromPanel(syncBtn));

    // 지금 검색어·필터 그대로 큰 검색 창에서 보기 (v0.3.0)
    const bigBtn = iconButton(tools, "maximize-2", "큰 검색 창에서 보기 — 지금 검색어와 필터가 그대로 넘어갑니다");
    bigBtn.addEventListener("click", () =>
      this.plugin.openBrowser({
        query: this.currentQuery,
        filters: {
          bookIds: new Set(this.filters.bookIds),
          tagNames: new Set(this.filters.tagNames),
          categories: new Set(this.filters.categories),
        },
      }),
    );
  }

  private renderActiveTab() {
    this.bodyEl.empty();
    if (this.activeTab === "search") this.renderSearchTab();
    else if (this.activeTab === "related") this.renderRelatedTab();
    else this.renderDailyTab();
  }

  // ───────── 검색 탭 ─────────

  private renderSearchTab() {
    const root = this.bodyEl;

    const box = root.createDiv({ cls: "a4p-rw-searchbox" });
    setIcon(box.createSpan({ cls: "a4p-rw-searchbox-icon" }), "search");
    this.inputEl = box.createEl("input", {
      cls: "a4p-rw-search-input",
      attr: { type: "text", placeholder: '밑줄 찾기 — "구절" · -빼기 · 책: · #태그' },
    });
    this.inputEl.value = this.currentQuery;
    this.inputEl.addEventListener("input", () => {
      this.updateClearButton();
      this.scheduleSearch();
    });

    const clearBtn = box.createSpan({ cls: "a4p-rw-searchbox-clear" });
    setIcon(clearBtn, "x");
    clearBtn.setAttr("aria-label", "검색어 지우기");
    clearBtn.addEventListener("click", () => {
      if (!this.inputEl) return;
      this.inputEl.value = "";
      this.currentQuery = "";
      this.updateClearButton();
      this.runSearch();
      this.inputEl.focus();
    });

    this.filtersEl = root.createDiv({ cls: "a4p-rw-filters" });
    this.searchStatusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.searchResultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.rebuildFilterOptions();
    this.renderFilters();
    this.updateClearButton();
    this.runSearch();
  }

  private updateClearButton() {
    if (!this.inputEl) return;
    this.inputEl.parentElement?.toggleClass("has-value", this.inputEl.value.length > 0);
  }

  private rebuildFilterOptions() {
    this.options = collectFilterOptions(this.plugin.cache.books);
  }

  private scheduleSearch() {
    if (!this.inputEl) return;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.currentQuery = this.inputEl?.value ?? "";
      this.runSearch();
    }, DEBOUNCE_MS);
  }

  /**
   * 필터 칩 한 줄 (v0.5.0 — 네모난 선택 상자 3개를 대신한다).
   * 고른 칩만 색이 들어오고, 칩 안의 ×로 푼다. 태그 칩은 태그 줄을 펼치고 접는다.
   */
  private renderFilters() {
    if (!this.filtersEl) return;
    const el = this.filtersEl;
    el.empty();

    if (this.plugin.cache.books.length === 0) return;

    const row = el.createDiv({ cls: "a4p-rw-chips" });

    // 책
    const bookId = this.filters.bookIds && this.filters.bookIds.size > 0
      ? Array.from(this.filters.bookIds)[0]
      : null;
    const bookLabel = bookId !== null
      ? this.plugin.cache.books.find((b) => b.user_book_id === bookId)?.title ?? "…"
      : "";
    this.filterChip(row, {
      label: bookId !== null ? truncate(bookLabel, 14) : "책",
      tip: "책·글 하나로 좁히기",
      on: bookId !== null,
      onOpen: () => {
        new BookSuggestModal(this.app, this.options.books, (id) => {
          this.filters.bookIds = id !== null ? new Set([id]) : new Set();
          this.renderFilters();
          this.runSearch();
        }).open();
      },
      onClear: () => {
        this.filters.bookIds = new Set();
        this.renderFilters();
        this.runSearch();
      },
    });

    // 종류
    const category = this.filters.categories && this.filters.categories.size > 0
      ? Array.from(this.filters.categories)[0]
      : "";
    this.filterChip(row, {
      label: category ? categoryLabel(category) : "종류",
      tip: "책·아티클 같은 종류로 좁히기",
      on: !!category,
      onOpen: (evt) => {
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("전체").setChecked(!category).onClick(() => this.setCategory("")),
        );
        for (const c of this.options.categories) {
          menu.addItem((item) =>
            item.setTitle(categoryLabel(c)).setChecked(c === category).onClick(() => this.setCategory(c)),
          );
        }
        menu.showAtMouseEvent(evt);
      },
      onClear: () => this.setCategory(""),
    });

    // 태그 — 누르면 아래에 태그 줄이 펼쳐진다
    if (this.options.tags.length > 0) {
      const selected = this.filters.tagNames?.size ?? 0;
      const chip = this.filterChip(row, {
        label: selected > 0 ? `태그 ${selected}` : "태그",
        tip: `태그로 좁히기 · 전체 ${this.options.tags.length}개`,
        on: selected > 0,
        open: this.tagsOpen,
        onOpen: () => {
          this.tagsOpen = !this.tagsOpen;
          this.renderFilters();
        },
        onClear: () => {
          this.filters.tagNames = new Set();
          this.renderFilters();
          this.runSearch();
        },
      });
      chip.addClass("a4p-rw-tags-toggle");
      chip.setAttr("aria-expanded", String(this.tagsOpen));
    }

    // 정렬
    this.filterChip(row, {
      label: SORT_LABELS[this.sortMode],
      tip: "정렬 바꾸기",
      on: false,
      onOpen: (evt) => {
        const menu = new Menu();
        for (const s of Object.keys(SORT_LABELS) as SortMode[]) {
          menu.addItem((item) =>
            item.setTitle(SORT_LABELS[s]).setChecked(s === this.sortMode).onClick(() => {
              this.sortMode = s;
              this.renderFilters();
              this.runSearch();
            }),
          );
        }
        menu.showAtMouseEvent(evt);
      },
    });

    if (hasActiveFilters(this.filters) || this.sortMode !== this.plugin.settings.defaultSort) {
      const reset = row.createEl("button", { cls: "a4p-rw-chip-reset", text: "초기화" });
      reset.setAttr("aria-label", "필터와 정렬을 처음 상태로");
      reset.addEventListener("click", () => {
        this.filters = { bookIds: new Set(), tagNames: new Set(), categories: new Set() };
        this.tagsExpanded = false;
        this.tagsOpen = false;
        this.sortMode = this.plugin.settings.defaultSort;
        this.renderFilters();
        this.runSearch();
      });
    }

    if (this.options.tags.length > 0 && this.tagsOpen) {
      const tagsRow = el.createDiv({ cls: "a4p-rw-tag-row" });
      const limit = this.tagsExpanded ? this.options.tags.length : TAG_VISIBLE_LIMIT;
      for (const t of this.options.tags.slice(0, limit)) {
        const chip = tagsRow.createEl("button", { cls: "a4p-rw-tag-toggle", text: `#${t.name}` });
        if (this.filters.tagNames?.has(t.name)) chip.addClass("is-active");
        chip.addEventListener("click", () => {
          if (!this.filters.tagNames) this.filters.tagNames = new Set();
          if (this.filters.tagNames.has(t.name)) this.filters.tagNames.delete(t.name);
          else this.filters.tagNames.add(t.name);
          this.renderFilters();
          this.runSearch();
        });
      }
      if (this.options.tags.length > TAG_VISIBLE_LIMIT) {
        const more = tagsRow.createEl("button", {
          cls: "a4p-rw-tag-more",
          text: this.tagsExpanded ? "접기" : `+${this.options.tags.length - TAG_VISIBLE_LIMIT} 더보기`,
        });
        more.addEventListener("click", () => {
          this.tagsExpanded = !this.tagsExpanded;
          this.renderFilters();
        });
      }
    }
  }

  private filterChip(
    parent: HTMLElement,
    opts: {
      label: string;
      tip: string;
      on: boolean;
      open?: boolean;
      onOpen: (evt: MouseEvent) => void;
      onClear?: () => void;
    },
  ): HTMLElement {
    const chip = parent.createEl("button", { cls: "a4p-rw-chip" });
    chip.toggleClass("is-on", opts.on);
    chip.setAttr("aria-label", opts.tip);
    chip.createSpan({ cls: "a4p-rw-chip-label", text: opts.label });
    if (opts.on && opts.onClear) {
      const x = chip.createSpan({ cls: "a4p-rw-chip-x" });
      setIcon(x, "x");
      x.setAttr("aria-label", "풀기");
      x.addEventListener("click", (evt) => {
        evt.stopPropagation();
        opts.onClear?.();
      });
    } else {
      setIcon(chip.createSpan({ cls: "a4p-rw-chip-caret" }), opts.open ? "chevron-up" : "chevron-down");
    }
    chip.addEventListener("click", (evt) => opts.onOpen(evt));
    return chip;
  }

  private setCategory(c: string) {
    this.filters.categories = c ? new Set([c]) : new Set();
    this.renderFilters();
    this.runSearch();
  }

  private runSearch() {
    if (!this.searchStatusEl || !this.searchResultsEl) return;
    const books = this.plugin.cache.books;

    if (books.length === 0) {
      this.searchStatusEl.setText("");
      this.renderEmpty(
        this.searchResultsEl,
        "book-marked",
        "아직 동기화된 데이터가 없습니다",
        "설정 → A4P Readwise Search 에서 토큰 입력 후 '전체 동기화'를 실행해주세요.",
      );
      return;
    }

    const query = this.currentQuery.trim();
    const filtersActive = hasActiveFilters(this.filters);
    const isDefaultView = !query && !filtersActive;
    // Readwise에서 지운 하이라이트는 메모 노트가 있는 것만 보인다
    const outcome = searchWithFallback(books, query, this.filters, this.sortMode, (id) =>
      this.plugin.noteIndex.has(id),
    );
    const hits = outcome.hits;
    this.markTerms = outcome.terms;

    let base: string;
    if (isDefaultView) {
      base = `최근 밑줄 ${hits.length}개`;
    } else if (hits.length === 0) {
      base = "결과 없음";
    } else if (outcome.mode === "qwerty") {
      base = `${hits.length}건 · 영문 자판을 한글로 바꿔 찾음 (${outcome.converted.map((c) => `${c.from} → ${c.to}`).join(", ")})`;
    } else if (outcome.mode === "stem") {
      base = `${hits.length}건 · 조사를 뗀 낱말로 찾음`;
    } else if (outcome.mode === "partial") {
      base = `${hits.length}건 · 모든 낱말이 든 결과가 없어 일부만 맞는 결과 (본문에서 맞은 낱말 수 순)`;
    } else {
      base = `${hits.length}건${hits.length >= 100 ? " (상위 100건까지)" : ""}`;
    }
    const condition = outcome.query.hasSyntax ? describeQuery(outcome.query) : "";
    this.searchStatusEl.setText([base, condition && `조건: ${condition}`].filter(Boolean).join(" · "));

    this.searchResultsEl.empty();
    if (hits.length === 0) {
      this.renderEmpty(
        this.searchResultsEl,
        "search-x",
        "맞는 밑줄이 없습니다",
        filtersActive ? "낱말을 줄이거나 필터를 풀어 보세요." : "낱말을 줄이거나 다른 말로 찾아보세요.",
      );
      return;
    }
    for (const hit of hits) this.renderCard(this.searchResultsEl, this.cardFromHit(hit), this.markTerms);
  }

  private renderEmpty(el: HTMLElement, icon: string, title: string, sub: string) {
    el.empty();
    const empty = el.createDiv({ cls: "a4p-rw-empty" });
    setIcon(empty.createDiv({ cls: "a4p-rw-empty-icon" }), icon);
    empty.createEl("p", { cls: "a4p-rw-empty-title", text: title });
    if (sub) empty.createEl("p", { cls: "a4p-rw-empty-sub", text: sub });
  }

  // ───────── 카드 ─────────

  private cardFromHit(hit: SearchHit): CardData {
    const tags = Array.from(
      new Set([
        ...(hit.highlight.tags ?? []).map((t) => t.name),
        ...(hit.book.book_tags ?? []).map((t) => t.name),
      ]),
    );
    return {
      id: hit.highlight.id,
      title: hit.book.title || "제목 없음",
      author: hit.book.author?.trim() || null,
      category: hit.book.category,
      sourceUrl: hit.book.source_url,
      text: hit.highlight.text ?? "",
      note: (hit.highlight.note ?? "").trim(),
      tags,
      // 실제로 하이라이트한 시각 기준 (Readwise updated_at은 재업로드로 옛 항목도 갱신됨)
      whenIso: highlightTime(hit.highlight),
      deleted: !!hit.highlight.is_deleted,
      bookId: hit.book.user_book_id,
      link: {
        url: `https://readwise.io/bookreview/${hit.book.user_book_id}`,
        tip: "Readwise 책 페이지로 이동 (그곳에서 'Find similar highlights' 사용 가능)",
      },
      citation: () => formatHitCitation(hit, citationOptions(this.plugin.settings)),
      insert: () => insertCitation(this.app, hit, citationOptions(this.plugin.settings)),
      makeNote: () =>
        void createHighlightNoteFromHit(this.app, this.plugin.settings, this.plugin.noteIndex, hit),
    };
  }

  private cardFromDaily(dh: DailyReviewHighlight): CardData {
    const url = dh.highlight_url || dh.source_url || dh.url;
    const book = this.plugin.cache.books.find(
      (b) => b.title === dh.title && (b.author ?? "") === (dh.author ?? ""),
    );
    return {
      id: dh.id,
      title: dh.title || "제목 없음",
      author: dh.author?.trim() || null,
      // 복습 API는 category가 비어 오고 source_type("book" 등)만 온다 (2026-11-22 실측)
      category: book?.category ?? dh.category ?? SOURCE_TYPE_CATEGORY[dh.source_type] ?? null,
      sourceUrl: dh.source_url,
      text: dh.text ?? "",
      note: (dh.note ?? "").trim(),
      tags: [],
      whenIso: dh.highlighted_at,
      deleted: false,
      bookId: book?.user_book_id ?? null,
      link: url ? { url, tip: "원문 열기" } : null,
      citation: () => formatDailyCitation(dh, citationOptions(this.plugin.settings)),
      insert: () => insertDailyCitation(this.app, dh, citationOptions(this.plugin.settings)),
      makeNote: () =>
        void createHighlightNoteFromDaily(this.app, this.plugin.settings, this.plugin.noteIndex, dh),
    };
  }

  /**
   * 카드 (v0.5.0 「서재」) — 밑줄이 위·크게, 출처는 아래 한 줄. 상자 없이 가는 선으로 나눈다.
   * 단추는 아이콘만 두고 풀이는 말풍선(aria-label)으로: 메모 노트(있으면 강조색) · 원문 · 인용 넣기.
   */
  private renderCard(parent: HTMLElement, data: CardData, terms: string[]) {
    const card = parent.createDiv({ cls: "a4p-rw-card" });
    card.dataset.highlightId = String(data.id);
    if (data.deleted) {
      // Readwise에서 지웠지만 메모 노트가 있어 남긴 하이라이트 — 노트를 지우면 목록에서 빠진다
      card.addClass("is-deleted");
      card.dataset.deleted = "1";
    }
    this.attachDrag(card, data.citation);

    const quote = card.createDiv({ cls: "a4p-rw-quote" });
    // 빈 줄이 여러 개 이어진 밑줄(전사·웹 글)은 한 줄만 띄운다
    const full = data.text.trim().replace(/\n\s*\n+/g, "\n\n");
    const text = full.length > SNIPPET_MAX ? full.slice(0, SNIPPET_MAX).trimEnd() + "…" : full;
    renderTextWithMarks(quote, text, terms);

    if (data.note) {
      const memo = card.createDiv({ cls: "a4p-rw-memo" });
      setIcon(memo.createSpan({ cls: "a4p-rw-memo-icon" }), "message-square");
      renderTextWithMarks(memo.createSpan({ cls: "a4p-rw-memo-text" }), data.note, terms);
    }

    const src = card.createDiv({ cls: "a4p-rw-src" });
    renderCover(src, { title: data.title, category: data.category, sourceUrl: data.sourceUrl }, "sm");

    const info = src.createDiv({ cls: "a4p-rw-src-text" });
    const titleEl = info.createDiv({ cls: "a4p-rw-title" });
    renderTextWithMarks(titleEl, data.title, terms);
    if (data.bookId !== null) {
      const bookId = data.bookId;
      titleEl.addClass("is-link");
      titleEl.setAttr("aria-label", "이 책의 밑줄을 읽은 순서대로 보기");
      titleEl.addEventListener("click", () => this.plugin.openBrowser({ bookId }));
    }
    const sub = info.createDiv({ cls: "a4p-rw-sub" });
    if (data.author) sub.createSpan({ cls: "a4p-rw-author", text: data.author });
    const when = formatRelative(data.whenIso);
    if (when && data.whenIso) {
      sub.createSpan({ cls: "a4p-rw-time", text: when }).setAttr(
        "aria-label",
        `하이라이트: ${new Date(data.whenIso).toLocaleString()}`,
      );
    }
    for (const tag of data.tags.slice(0, CARD_TAGS)) sub.createSpan({ cls: "a4p-rw-tag", text: `#${tag}` });
    if (data.deleted) {
      sub
        .createSpan({ cls: "a4p-rw-deleted-chip", text: "Readwise에서 삭제됨" })
        .setAttr("aria-label", "Readwise에서 지운 하이라이트입니다. 메모 노트가 있어 남겨 두었습니다");
    }

    const acts = src.createDiv({ cls: "a4p-rw-acts" });
    const noteBtn = iconButton(acts, "file-plus", "");
    noteBtn.addClass("a4p-rw-note-btn");
    noteBtn.dataset.highlightId = String(data.id);
    applyNoteButtonState(noteBtn, this.plugin.noteIndex.has(data.id));
    noteBtn.addEventListener("click", () => data.makeNote());

    if (data.link) {
      const link = acts.createEl("a", { href: data.link.url, cls: "a4p-rw-icon-btn a4p-rw-link" });
      setIcon(link, "external-link");
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      link.setAttr("aria-label", data.link.tip);
    }

    const insertBtn = iconButton(acts, "quote", "인용 넣기 — 마지막으로 쓰던 노트의 커서 자리에");
    insertBtn.addClass("is-primary", "a4p-rw-insert");
    insertBtn.addEventListener("click", () => data.insert());
  }

  private async runSyncFromPanel(btn: HTMLButtonElement) {
    if (this.plugin.sync.isRunning()) return;
    btn.setAttr("disabled", "true");
    btn.addClass("is-syncing");
    try {
      await this.plugin.sync.run({ full: false });
    } finally {
      btn.removeAttribute("disabled");
      btn.removeClass("is-syncing");
      this.refreshAfterSync();
    }
  }

  refreshAfterSync() {
    this.rebuildFilterOptions();
    if (this.activeTab === "search") {
      this.renderFilters();
      this.runSearch();
    } else if (this.activeTab === "related") {
      this.runRelated();
    }
  }

  /**
   * 인덱스 변경 시 보이는 카드의 버튼만 갱신 — 전체 재렌더 없이 스크롤 유지 (bodyEl에는 활성 탭만 있음).
   * 단, Readwise에서 지운 카드(노트 덕에 남은 것)는 노트가 없어지면 목록에서도 빠져야 하므로 그때만 재검색.
   */
  private refreshNoteButtons(ids: NoteIndexChange) {
    const buttons = this.bodyEl.querySelectorAll<HTMLButtonElement>(
      ".a4p-rw-note-btn[data-highlight-id]",
    );
    let dropTombstone = false;
    buttons.forEach((btn) => {
      const id = Number(btn.dataset.highlightId);
      if (ids !== null && !ids.has(id)) return;
      const exists = this.plugin.noteIndex.has(id);
      applyNoteButtonState(btn, exists);
      if (!exists && btn.closest(".a4p-rw-card")?.hasAttribute("data-deleted")) dropTombstone = true;
    });
    if (!dropTombstone) return;
    if (this.activeTab === "search") this.runSearch();
    else if (this.activeTab === "related") this.runRelated();
  }

  /** 설정의 기본 정렬이 바뀌면 열린 패널에도 즉시 반영 */
  applyDefaultSort() {
    this.sortMode = this.plugin.settings.defaultSort;
    if (this.activeTab === "search") {
      this.renderFilters();
      this.runSearch();
    }
  }

  // ───────── 관련 탭 (v0.5.0) ─────────

  private renderRelatedTab() {
    const root = this.bodyEl;
    this.relatedHeadEl = root.createDiv({ cls: "a4p-rw-related-head" });
    this.relatedTermsEl = root.createDiv({ cls: "a4p-rw-chips a4p-rw-related-terms" });
    this.relatedStatusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.relatedResultsEl = root.createDiv({ cls: "a4p-rw-results" });
    this.runRelated();
  }

  /** 지금 쓰는(마지막으로 쓰던) 노트의 제목·소제목·태그와 닿는 밑줄을 찾는다 */
  private runRelated() {
    if (this.activeTab !== "related") return;
    const headEl = this.relatedHeadEl;
    const termsEl = this.relatedTermsEl;
    const statusEl = this.relatedStatusEl;
    const resultsEl = this.relatedResultsEl;
    if (!headEl || !termsEl || !statusEl || !resultsEl) return;

    // 사이드 패널을 눌러도 마지막으로 쓰던 노트가 기준으로 남는다
    const active = this.app.workspace.getActiveFile();
    if (active && active.extension === "md") this.relatedFile = active;
    const file = this.relatedFile;
    const stillThere = file ? this.app.vault.getAbstractFileByPath(file.path) instanceof TFile : false;

    headEl.empty();
    termsEl.empty();
    statusEl.setText("");
    if (this.plugin.cache.books.length === 0) {
      this.renderEmpty(
        resultsEl,
        "book-marked",
        "아직 동기화된 데이터가 없습니다",
        "설정에서 토큰 입력 후 '전체 동기화'를 실행해주세요.",
      );
      return;
    }
    if (!file || !stillThere) {
      this.relatedFile = null;
      this.renderEmpty(
        resultsEl,
        "file-text",
        "노트를 열어 주세요",
        "지금 쓰는 노트의 제목·소제목·태그와 닿는 밑줄을 여기에 보여 줍니다.",
      );
      return;
    }

    setIcon(headEl.createSpan({ cls: "a4p-rw-related-icon" }), "file-text");
    headEl.createSpan({ cls: "a4p-rw-related-title", text: file.basename });

    const cache = this.app.metadataCache.getFileCache(file);
    const terms: NoteTerm[] = extractTerms({
      title: file.basename,
      headings: (cache?.headings ?? []).filter((h) => h.level <= 3).map((h) => h.heading),
      tags: cache ? getAllTags(cache) ?? [] : [],
      aliases: parseFrontMatterAliases(cache?.frontmatter ?? null) ?? [],
    });
    if (terms.length === 0) {
      this.renderEmpty(
        resultsEl,
        "type",
        "찾을 낱말이 없습니다",
        "노트 제목이나 소제목(##)·태그를 적으면 그 낱말로 밑줄을 찾습니다.",
      );
      return;
    }

    const skip = this.relatedSkip.get(file.path) ?? new Set<string>();
    const outcome = findRelated(this.plugin.cache.books, terms, (id) => this.plugin.noteIndex.has(id), {
      // 이 노트가 하이라이트 메모 노트면 그 하이라이트 자신은 뺀다
      excludeHighlightId: parseHighlightId(cache?.frontmatter?.highlight_id),
      skip,
    });

    // 찾는 데 쓴 낱말 — 누르면 끄고 켠다
    const shown = new Set([...outcome.used, ...skip]);
    for (const { term } of terms) {
      if (!shown.has(term)) continue;
      const off = skip.has(term);
      const chip = termsEl.createEl("button", { cls: "a4p-rw-chip a4p-rw-term", text: term });
      chip.toggleClass("is-on", !off);
      chip.setAttr("aria-label", off ? "이 낱말로 다시 찾기" : "이 낱말은 빼고 찾기");
      chip.addEventListener("click", () => {
        if (off) skip.delete(term);
        else skip.add(term);
        this.relatedSkip.set(file.path, skip);
        this.runRelated();
      });
    }
    // 못 쓴 낱말은 개수만 보이고 까닭은 말풍선으로
    const unused = outcome.common.length + outcome.missing.length;
    if (unused > 0) {
      const parts: string[] = [];
      if (outcome.common.length) parts.push(`너무 흔해서 뺀 낱말: ${outcome.common.join(", ")}`);
      if (outcome.missing.length) parts.push(`서재에 없는 낱말: ${outcome.missing.join(", ")}`);
      termsEl
        .createSpan({ cls: "a4p-rw-term-note", text: `그 밖의 낱말 ${unused}개` })
        .setAttr("aria-label", parts.join(" · "));
    }

    resultsEl.empty();
    if (outcome.hits.length === 0) {
      this.renderEmpty(
        resultsEl,
        "search-x",
        "닿는 밑줄이 없습니다",
        "소제목이나 태그를 더 적으면 찾을 낱말이 늘어납니다.",
      );
      return;
    }
    statusEl.setText(`닿는 밑줄 ${outcome.hits.length}개 · 맞은 낱말이 많은 순`);
    for (const hit of outcome.hits) this.renderCard(resultsEl, this.cardFromHit(hit), outcome.used);
  }

  // ───────── 복습 탭 ─────────

  private renderDailyTab() {
    const root = this.bodyEl;
    const head = root.createDiv({ cls: "a4p-rw-daily-head" });
    this.dailyStatusEl = head.createDiv({ cls: "a4p-rw-status" });
    this.dailyToolsEl = head.createDiv({ cls: "a4p-rw-daily-tools" });
    this.dailyResultsEl = root.createDiv({ cls: "a4p-rw-results" });
    this.dailyBarEl = root.createDiv({ cls: "a4p-rw-daily-bar" });

    this.renderDailyActions();

    if (this.dailyReview) {
      this.dailyStatusEl.setText(this.dailyStatusText(this.dailyReview));
      this.renderDailyHighlights(this.dailyReview.highlights);
    } else if (!this.dailyFetched) {
      void this.fetchDaily();
    }
  }

  private dailyStatusText(review: DailyReview): string {
    return `오늘의 복습 · 밑줄 ${review.highlights.length}개${review.review_completed ? " · 완료됨" : ""}`;
  }

  /** 머리줄의 아이콘 단추(새로 받기·Readwise에서 열기)와 바닥의 단추(복습 완료·모두 넣기) */
  private renderDailyActions() {
    const tools = this.dailyToolsEl;
    const bar = this.dailyBarEl;
    if (!tools || !bar) return;
    tools.empty();
    bar.empty();

    const refreshBtn = iconButton(tools, "rotate-cw", "오늘의 복습 새로 받기");
    refreshBtn.addEventListener("click", () => void this.fetchDaily());
    if (this.dailyReview?.review_url) {
      const link = tools.createEl("a", {
        href: this.dailyReview.review_url,
        cls: "a4p-rw-icon-btn a4p-rw-link",
      });
      setIcon(link, "external-link");
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      link.setAttr("aria-label", "Readwise에서 오늘의 복습 열기");
    }

    const review = this.dailyReview;
    const hasItems = !!review && review.highlights.length > 0;
    bar.toggleClass("is-empty", !hasItems);
    if (!review || !hasItems) return;

    // 오늘의 복습 완료 표시 (v0.3.1 — 사용자가 허용한 유일한 Readwise 쓰기)
    if (review.review_completed) {
      const done = bar.createEl("button", { cls: "a4p-rw-daily-btn is-done" });
      setIcon(done.createSpan({ cls: "a4p-rw-btn-icon" }), "check");
      done.createSpan({ text: "오늘 복습 완료됨" });
      done.setAttr("disabled", "true");
    } else {
      const completeBtn = bar.createEl("button", { cls: "a4p-rw-daily-btn is-cta" });
      setIcon(completeBtn.createSpan({ cls: "a4p-rw-btn-icon" }), "check-circle");
      completeBtn.createSpan({ text: "오늘 복습 완료" });
      completeBtn.setAttr("aria-label", "Readwise에 오늘의 복습을 마쳤다고 기록합니다");
      completeBtn.addEventListener("click", () => void this.completeDaily(completeBtn));
    }

    const insertAllBtn = bar.createEl("button", { cls: "a4p-rw-daily-btn" });
    setIcon(insertAllBtn.createSpan({ cls: "a4p-rw-btn-icon" }), "quote");
    insertAllBtn.createSpan({ text: "모두 넣기" });
    insertAllBtn.setAttr("aria-label", "오늘 복습의 밑줄을 모두 노트에 인용으로 넣습니다");
    insertAllBtn.addEventListener("click", () => {
      if (!this.dailyReview || this.dailyReview.highlights.length === 0) {
        new Notice("넣을 밑줄이 없습니다.");
        return;
      }
      const ok = insertDailyCitations(
        this.app,
        this.dailyReview.highlights,
        citationOptions(this.plugin.settings),
      );
      if (ok) new Notice(`인용 ${this.dailyReview.highlights.length}개를 넣었습니다.`);
    });
  }

  private async fetchDaily() {
    if (this.dailyLoading) return;
    if (!this.dailyStatusEl || !this.dailyResultsEl) return;

    if (!this.plugin.getToken()) {
      this.dailyStatusEl.setText(this.plugin.tokenMissingMessage());
      this.dailyResultsEl.empty();
      this.dailyFetched = true;
      return;
    }

    this.dailyLoading = true;
    this.dailyStatusEl.setText("오늘의 복습을 가져오는 중…");
    this.dailyResultsEl.empty();

    try {
      const client = new ReadwiseClient(this.plugin.getToken());
      const review = await client.getDailyReview();
      this.dailyReview = review;
      this.dailyStatusEl.setText(this.dailyStatusText(review));
      this.renderDailyActions();
      this.renderDailyHighlights(review.highlights);
    } catch (e) {
      this.dailyReview = null;
      this.dailyStatusEl.setText(this.formatDailyError(e));
      this.renderDailyActions();
    } finally {
      this.dailyLoading = false;
      this.dailyFetched = true;
    }
  }

  private async completeDaily(btn: HTMLButtonElement) {
    if (!this.dailyReview) return;
    btn.setAttr("disabled", "true");
    try {
      const client = new ReadwiseClient(this.plugin.getToken());
      const res = await client.completeDailyReview();
      this.dailyReview.review_completed = res.review_completed !== false;
      this.dailyStatusEl?.setText(this.dailyStatusText(this.dailyReview));
      new Notice("Readwise에 오늘 복습 완료를 기록했습니다.");
      this.renderDailyActions();
    } catch (e) {
      const msg =
        e instanceof ReadwiseNoReviewError
          ? "Readwise가 완료로 표시할 오늘의 복습을 찾지 못했습니다. 여기 보이는 목록이 지난번 복습일 수 있습니다 — Readwise 웹·앱에서 오늘의 Daily Review를 연 뒤 다시 눌러 주세요."
          : this.formatDailyError(e);
      new Notice(msg, 10000);
      btn.removeAttribute("disabled");
    }
  }

  private formatDailyError(e: unknown): string {
    if (e instanceof ReadwiseNoReviewError) return e.message;
    if (e instanceof ReadwiseAuthError) return `인증 실패: ${e.message}`;
    if (e instanceof ReadwiseRateLimitError)
      return `요청이 많아 잠시 쉽니다. ${e.retryAfterSec}초 뒤에 다시 시도해 주세요.`;
    if (e instanceof ReadwiseApiError) return `Readwise 응답 오류: ${e.message}`;
    if (e instanceof Error) return `오류: ${e.message}`;
    return "알 수 없는 오류";
  }

  private renderDailyHighlights(items: DailyReviewHighlight[]) {
    if (!this.dailyResultsEl) return;
    this.dailyResultsEl.empty();
    if (items.length === 0) {
      this.renderEmpty(this.dailyResultsEl, "calendar-check", "오늘의 복습에 밑줄이 없습니다", "");
      return;
    }
    for (const dh of items) this.renderCard(this.dailyResultsEl, this.cardFromDaily(dh), []);
  }

  private attachDrag(card: HTMLDivElement, getMarkdown: () => string) {
    card.draggable = true;
    card.addEventListener("dragstart", (e) => {
      if (!e.dataTransfer) return;
      const md = getMarkdown();
      e.dataTransfer.setData("text/plain", md);
      e.dataTransfer.effectAllowed = "copy";
      card.addClass("is-dragging");
    });
    card.addEventListener("dragend", () => {
      card.removeClass("is-dragging");
    });
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function categoryLabel(c: string): string {
  return CATEGORY_LABELS[c] ?? c;
}

/** 아이콘만 있는 단추 — 풀이는 말풍선(aria-label)으로 보인다 */
function iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
  const btn = parent.createEl("button", { cls: "a4p-rw-icon-btn" });
  setIcon(btn, icon);
  if (label) btn.setAttr("aria-label", label);
  return btn;
}

/** 노트 단추의 아이콘·말풍선·색을 노트 존재 여부에 맞춘다 — 있으면 "노트 열기"(강조색), 없으면 "노트 생성" */
function applyNoteButtonState(btn: HTMLButtonElement, exists: boolean) {
  btn.empty();
  setIcon(btn, exists ? "file-check" : "file-plus");
  btn.toggleClass("is-existing", exists);
  btn.setAttr(
    "aria-label",
    exists
      ? "노트 열기 — 이 하이라이트의 메모가 이미 있습니다"
      : "노트 생성 — 이 하이라이트로 새 메모를 만듭니다",
  );
}
