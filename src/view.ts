import { ItemView, Notice, setIcon, WorkspaceLeaf } from "obsidian";
import {
  ReadwiseApiError,
  ReadwiseAuthError,
  ReadwiseClient,
  ReadwiseRateLimitError,
} from "./api";
import { BookSuggestModal } from "./book-suggest-modal";
import {
  formatCallout,
  formatDailyCallout,
  insertCitation,
  insertDailyCitation,
  insertDailyCitations,
} from "./citation";
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
import type ReadwiseSearchPlugin from "./main";
import { searchHighlights, SearchHit, SortMode, splitQueryTerms } from "./search";
import { DailyReview, DailyReviewHighlight } from "./types";

export const VIEW_TYPE_READWISE_SEARCH = "a4p-readwise-search-view";

export type ReadwiseTab = "search" | "daily";

const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 280;
const TAG_VISIBLE_LIMIT = 20;

export class ReadwiseSearchView extends ItemView {
  private plugin: ReadwiseSearchPlugin;
  private tabsEl!: HTMLDivElement;
  private bodyEl!: HTMLDivElement;
  private activeTab: ReadwiseTab = "search";

  // Search tab state
  private inputEl: HTMLInputElement | null = null;
  private filtersEl: HTMLDivElement | null = null;
  private searchStatusEl: HTMLDivElement | null = null;
  private searchResultsEl: HTMLDivElement | null = null;
  private debounceTimer: number | null = null;
  private currentQuery = "";
  private filters: ActiveFilters = {
    bookIds: new Set(),
    tagNames: new Set(),
    categories: new Set(),
  };
  private options: FilterOptions = { books: [], tags: [], categories: [] };
  private tagsExpanded = false;
  private sortMode: SortMode = "relevance";

  // Daily tab state
  private dailyStatusEl: HTMLDivElement | null = null;
  private dailyActionsEl: HTMLDivElement | null = null;
  private dailyResultsEl: HTMLDivElement | null = null;
  private dailyReview: DailyReview | null = null;
  private dailyLoading = false;
  private dailyFetched = false;

  constructor(leaf: WorkspaceLeaf, plugin: ReadwiseSearchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_READWISE_SEARCH;
  }

  getDisplayText(): string {
    return "Readwise Search";
  }

  getIcon(): string {
    return "search";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("a4p-rw-panel");

    this.tabsEl = root.createDiv({ cls: "a4p-rw-tabs" });
    this.bodyEl = root.createDiv({ cls: "a4p-rw-body-area" });

    this.renderTabs();
    this.renderActiveTab();
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
  }

  setTab(tab: ReadwiseTab) {
    if (this.activeTab === tab) {
      if (tab === "daily" && !this.dailyFetched) void this.fetchDaily();
      return;
    }
    this.activeTab = tab;
    this.renderTabs();
    this.renderActiveTab();
  }

  private renderTabs() {
    this.tabsEl.empty();
    const tabs: { key: ReadwiseTab; label: string; icon: string }[] = [
      { key: "search", label: "검색", icon: "search" },
      { key: "daily", label: "Daily Review", icon: "calendar-days" },
    ];
    for (const t of tabs) {
      const el = this.tabsEl.createDiv({ cls: "a4p-rw-tab" });
      const iconEl = el.createSpan({ cls: "a4p-rw-tab-icon" });
      setIcon(iconEl, t.icon);
      el.createSpan({ cls: "a4p-rw-tab-label", text: t.label });
      if (t.key === this.activeTab) el.addClass("is-active");
      el.addEventListener("click", () => this.setTab(t.key));
    }
  }

  private renderActiveTab() {
    this.bodyEl.empty();
    if (this.activeTab === "search") this.renderSearchTab();
    else this.renderDailyTab();
  }

  // ───────── Search tab ─────────

  private renderSearchTab() {
    const root = this.bodyEl;

    const header = root.createDiv({ cls: "a4p-rw-header" });
    this.inputEl = header.createEl("input", {
      cls: "a4p-rw-search-input",
      attr: { type: "search", placeholder: "highlights 검색..." },
    });
    this.inputEl.value = this.currentQuery;
    this.inputEl.addEventListener("input", () => this.scheduleSearch());

    this.filtersEl = root.createDiv({ cls: "a4p-rw-filters" });
    this.searchStatusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.searchResultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.rebuildFilterOptions();
    this.renderFilters();
    this.runSearch();
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

  private renderFilters() {
    if (!this.filtersEl) return;
    const el = this.filtersEl;
    el.empty();

    if (this.plugin.cache.books.length === 0) return;

    const row = el.createDiv({ cls: "a4p-rw-filter-row" });

    const currentBookId =
      this.filters.bookIds && this.filters.bookIds.size > 0
        ? Array.from(this.filters.bookIds)[0]
        : null;
    const currentBookLabel =
      currentBookId !== null
        ? this.options.books.find((b) => b.id === currentBookId)?.label ?? "..."
        : "(전체)";

    const bookBtn = row.createEl("button", { cls: "a4p-rw-filter-trigger" });
    bookBtn.createSpan({ cls: "a4p-rw-filter-trigger-label", text: "책:" });
    bookBtn.createSpan({
      cls: "a4p-rw-filter-trigger-value",
      text: truncate(currentBookLabel, 28),
    });
    bookBtn.addEventListener("click", () => {
      new BookSuggestModal(this.app, this.options.books, (id) => {
        this.filters.bookIds = id !== null ? new Set([id]) : new Set();
        this.renderFilters();
        this.runSearch();
      }).open();
    });

    const catSel = row.createEl("select", { cls: "a4p-rw-filter-select" });
    catSel.createEl("option", { value: "", text: "카테고리: (전체)" });
    for (const c of this.options.categories) {
      catSel.createEl("option", { value: c, text: this.categoryLabel(c) });
    }
    const currentCat = this.filters.categories && this.filters.categories.size > 0
      ? Array.from(this.filters.categories)[0]
      : "";
    if (currentCat) catSel.value = currentCat;
    catSel.addEventListener("change", () => {
      const v = catSel.value;
      this.filters.categories = v ? new Set([v]) : new Set();
      this.runSearch();
    });

    const sortSel = row.createEl("select", { cls: "a4p-rw-filter-select a4p-rw-sort-select" });
    const sorts: { v: SortMode; label: string }[] = [
      { v: "relevance", label: "정렬: 관련도" },
      { v: "recent", label: "정렬: 최근" },
      { v: "book", label: "정렬: 책별" },
    ];
    for (const s of sorts) {
      sortSel.createEl("option", { value: s.v, text: s.label });
    }
    sortSel.value = this.sortMode;
    sortSel.addEventListener("change", () => {
      this.sortMode = sortSel.value as SortMode;
      this.runSearch();
    });

    const clearBtn = row.createEl("button", {
      cls: "a4p-rw-filter-clear",
      text: "초기화",
    });
    clearBtn.addEventListener("click", () => {
      this.filters = { bookIds: new Set(), tagNames: new Set(), categories: new Set() };
      this.tagsExpanded = false;
      this.sortMode = "relevance";
      this.renderFilters();
      this.runSearch();
    });

    if (this.options.tags.length > 0) {
      const tagsRow = el.createDiv({ cls: "a4p-rw-tag-row" });
      const limit = this.tagsExpanded ? this.options.tags.length : TAG_VISIBLE_LIMIT;
      const visible = this.options.tags.slice(0, limit);
      for (const t of visible) {
        const chip = tagsRow.createSpan({
          cls: "a4p-rw-tag-toggle",
          text: `#${t.name}`,
        });
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
        const more = tagsRow.createSpan({
          cls: "a4p-rw-tag-more",
          text: this.tagsExpanded
            ? "접기"
            : `+${this.options.tags.length - TAG_VISIBLE_LIMIT} 더보기`,
        });
        more.addEventListener("click", () => {
          this.tagsExpanded = !this.tagsExpanded;
          this.renderFilters();
        });
      }
    }
  }

  private categoryLabel(c: string): string {
    const map: Record<string, string> = {
      books: "책",
      articles: "아티클",
      tweets: "트윗",
      podcasts: "팟캐스트",
      supplementals: "보조자료",
    };
    return map[c] ?? c;
  }

  private runSearch() {
    if (!this.searchStatusEl || !this.searchResultsEl) return;
    const books = this.plugin.cache.books;

    if (books.length === 0) {
      this.renderSearchEmpty();
      return;
    }

    const query = this.currentQuery.trim();
    const filtersActive = hasActiveFilters(this.filters);

    if (!query && !filtersActive) {
      this.searchStatusEl.setText(
        `캐시: ${this.plugin.settings.bookCount}권 · ${this.plugin.settings.highlightCount}건. 검색어 또는 필터를 선택하세요.`,
      );
      this.searchResultsEl.empty();
      return;
    }

    const hits = searchHighlights(books, query, this.filters, this.sortMode);
    const filterSummary = this.summarizeFilters();
    const base =
      hits.length === 0 ? "결과 없음" : `${hits.length}건 (상위 100건까지)`;
    this.searchStatusEl.setText(filterSummary ? `${base} · ${filterSummary}` : base);
    this.renderSearchResults(hits);
  }

  private summarizeFilters(): string {
    const parts: string[] = [];
    if (this.filters.bookIds && this.filters.bookIds.size > 0) {
      const id = Array.from(this.filters.bookIds)[0];
      const opt = this.options.books.find((b) => b.id === id);
      if (opt) parts.push(`책: ${truncate(opt.label, 30)}`);
    }
    if (this.filters.categories && this.filters.categories.size > 0) {
      parts.push(`카테고리: ${this.categoryLabel(Array.from(this.filters.categories)[0])}`);
    }
    if (this.filters.tagNames && this.filters.tagNames.size > 0) {
      parts.push(`태그: ${Array.from(this.filters.tagNames).map((n) => `#${n}`).join(", ")}`);
    }
    return parts.join(" · ");
  }

  private renderSearchEmpty() {
    if (!this.searchResultsEl || !this.searchStatusEl) return;
    this.searchResultsEl.empty();
    this.searchStatusEl.setText("");
    const empty = this.searchResultsEl.createDiv({ cls: "a4p-rw-empty" });
    empty.createEl("p", { text: "아직 동기화된 데이터가 없습니다." });
    empty.createEl("p", {
      text: "설정 → Readwise Search 에서 토큰 입력 후 '전체 동기화'를 실행해주세요.",
    });
  }

  private renderSearchResults(hits: SearchHit[]) {
    if (!this.searchResultsEl) return;
    this.searchResultsEl.empty();
    for (const hit of hits) this.renderSearchCard(hit);
  }

  private renderSearchCard(hit: SearchHit) {
    if (!this.searchResultsEl) return;
    const card = this.searchResultsEl.createDiv({ cls: "a4p-rw-card" });

    this.attachDrag(card, () => formatCallout(hit));
    this.addDragHandle(card);

    const terms = splitQueryTerms(this.currentQuery);

    const meta = card.createDiv({ cls: "a4p-rw-meta" });
    const titleText = hit.book.title || "Untitled";
    const author = hit.book.author?.trim();
    const titleEl = meta.createSpan({ cls: "a4p-rw-title" });
    renderTextWithMarks(titleEl, titleText, terms);
    if (author) meta.createSpan({ cls: "a4p-rw-author", text: ` — ${author}` });

    const body = card.createDiv({ cls: "a4p-rw-body" });
    const text = hit.highlight.text ?? "";
    const truncated = text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text;
    renderTextWithMarks(body, truncated, terms);

    const note = (hit.highlight.note ?? "").trim();
    if (note) {
      const noteEl = card.createDiv({ cls: "a4p-rw-note" });
      renderTextWithMarks(noteEl, note, terms);
    }

    const tags = [
      ...(hit.highlight.tags ?? []),
      ...(hit.book.book_tags ?? []),
    ];
    if (tags.length > 0) {
      const tagsEl = card.createDiv({ cls: "a4p-rw-tags" });
      const seen = new Set<string>();
      for (const tag of tags) {
        if (seen.has(tag.name)) continue;
        seen.add(tag.name);
        tagsEl.createSpan({ cls: "a4p-rw-tag", text: `#${tag.name}` });
      }
    }

    const actions = card.createDiv({ cls: "a4p-rw-actions" });
    const insertBtn = actions.createEl("button", {
      cls: "a4p-rw-insert",
      text: "노트에 인용 삽입",
    });
    insertBtn.addEventListener("click", () => insertCitation(this.app, hit));

    const createBtn = actions.createEl("button", {
      cls: "a4p-rw-btn",
      text: "노트 생성",
    });
    createBtn.addEventListener("click", () => {
      void createHighlightNoteFromHit(this.app, this.plugin.settings, hit);
    });

    const rwUrl = `https://readwise.io/bookreview/${hit.book.user_book_id}`;
    const rwLink = actions.createEl("a", { text: "Readwise에서 보기", href: rwUrl });
    rwLink.setAttr("target", "_blank");
    rwLink.setAttr("rel", "noopener");
    rwLink.addClass("a4p-rw-link");
    rwLink.setAttr(
      "aria-label",
      "Readwise 책 페이지로 이동 (그곳에서 'Find similar highlights' 사용 가능)",
    );
  }

  refreshAfterSync() {
    this.rebuildFilterOptions();
    if (this.activeTab === "search") {
      this.renderFilters();
      this.runSearch();
    }
  }

  // ───────── Daily tab ─────────

  private renderDailyTab() {
    const root = this.bodyEl;
    const header = root.createDiv({ cls: "a4p-rw-header" });
    header.createEl("h3", { text: "Daily Review" });

    this.dailyActionsEl = root.createDiv({ cls: "a4p-rw-daily-actions" });
    this.dailyStatusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.dailyResultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.renderDailyActions();

    if (this.dailyReview) {
      this.dailyStatusEl.setText(
        `${this.dailyReview.highlights.length}개 항목${this.dailyReview.review_completed ? " · 오늘 review 완료됨" : ""}`,
      );
      this.renderDailyHighlights(this.dailyReview.highlights);
    } else if (!this.dailyFetched) {
      void this.fetchDaily();
    }
  }

  private renderDailyActions() {
    if (!this.dailyActionsEl) return;
    const el = this.dailyActionsEl;
    el.empty();

    const refreshBtn = el.createEl("button", {
      cls: "a4p-rw-daily-btn",
      text: "새로고침",
    });
    refreshBtn.addEventListener("click", () => void this.fetchDaily());

    const insertAllBtn = el.createEl("button", {
      cls: "a4p-rw-daily-btn",
      text: "오늘 review 전체 인용 삽입",
    });
    insertAllBtn.addEventListener("click", () => {
      if (!this.dailyReview || this.dailyReview.highlights.length === 0) {
        new Notice("삽입할 항목이 없습니다.");
        return;
      }
      const ok = insertDailyCitations(this.app, this.dailyReview.highlights);
      if (ok) new Notice(`${this.dailyReview.highlights.length}개 인용 삽입 완료`);
    });

    if (this.dailyReview?.review_url) {
      const link = el.createEl("a", {
        text: "Readwise에서 열기",
        href: this.dailyReview.review_url,
        cls: "a4p-rw-link",
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
  }

  private async fetchDaily() {
    if (this.dailyLoading) return;
    if (!this.dailyStatusEl || !this.dailyResultsEl) return;

    if (!this.plugin.settings.apiToken) {
      this.dailyStatusEl.setText("설정에서 Readwise 토큰을 먼저 입력해주세요.");
      this.dailyResultsEl.empty();
      this.dailyFetched = true;
      return;
    }

    this.dailyLoading = true;
    this.dailyStatusEl.setText("Daily Review 가져오는 중...");
    this.dailyResultsEl.empty();

    try {
      const client = new ReadwiseClient(this.plugin.settings.apiToken);
      const review = await client.getDailyReview();
      this.dailyReview = review;
      this.dailyStatusEl.setText(
        `${review.highlights.length}개 항목${review.review_completed ? " · 오늘 review 완료됨" : ""}`,
      );
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

  private formatDailyError(e: unknown): string {
    if (e instanceof ReadwiseAuthError) return `인증 실패: ${e.message}`;
    if (e instanceof ReadwiseRateLimitError)
      return `Rate limit. ${e.retryAfterSec}초 후 다시 시도해주세요.`;
    if (e instanceof ReadwiseApiError) return `API 오류: ${e.message}`;
    if (e instanceof Error) return `오류: ${e.message}`;
    return "알 수 없는 오류";
  }

  private renderDailyHighlights(items: DailyReviewHighlight[]) {
    if (!this.dailyResultsEl) return;
    this.dailyResultsEl.empty();
    if (items.length === 0) {
      const empty = this.dailyResultsEl.createDiv({ cls: "a4p-rw-empty" });
      empty.createEl("p", { text: "오늘의 Daily Review 항목이 없습니다." });
      return;
    }
    for (const dh of items) this.renderDailyCard(dh);
  }

  private renderDailyCard(dh: DailyReviewHighlight) {
    if (!this.dailyResultsEl) return;
    const card = this.dailyResultsEl.createDiv({ cls: "a4p-rw-card" });

    this.attachDrag(card, () => formatDailyCallout(dh));
    this.addDragHandle(card);

    const meta = card.createDiv({ cls: "a4p-rw-meta" });
    meta.createSpan({ cls: "a4p-rw-title", text: dh.title || "Untitled" });
    if (dh.author) meta.createSpan({ cls: "a4p-rw-author", text: ` — ${dh.author}` });

    const body = card.createDiv({ cls: "a4p-rw-body" });
    const text = dh.text ?? "";
    body.setText(text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text);

    const note = (dh.note ?? "").trim();
    if (note) card.createDiv({ cls: "a4p-rw-note" }).setText(note);

    const actions = card.createDiv({ cls: "a4p-rw-actions" });
    const insertBtn = actions.createEl("button", {
      cls: "a4p-rw-insert",
      text: "노트에 인용 삽입",
    });
    insertBtn.addEventListener("click", () => insertDailyCitation(this.app, dh));

    const createBtn = actions.createEl("button", {
      cls: "a4p-rw-btn",
      text: "노트 생성",
    });
    createBtn.addEventListener("click", () => {
      void createHighlightNoteFromDaily(this.app, this.plugin.settings, dh);
    });

    const url = dh.highlight_url || dh.source_url || dh.url;
    if (url) {
      const link = actions.createEl("a", { text: "Readwise/원문", href: url });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      link.addClass("a4p-rw-link");
    }
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

  private addDragHandle(card: HTMLDivElement) {
    const handle = card.createSpan({ cls: "a4p-rw-drag-handle" });
    setIcon(handle, "grip-vertical");
    handle.setAttr("aria-label", "드래그하여 노트에 삽입");
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

function renderTextWithMarks(el: HTMLElement, text: string, terms: string[]) {
  if (terms.length === 0 || !text) {
    el.setText(text);
    return;
  }
  const lower = text.toLowerCase();
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (const t of terms) {
    if (!t) continue;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + t.length });
      from = idx + t.length;
    }
  }
  if (ranges.length === 0) {
    el.setText(text);
    return;
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let cursor = 0;
  for (const r of merged) {
    if (cursor < r.start) el.appendText(text.slice(cursor, r.start));
    el.createEl("mark", { text: text.slice(r.start, r.end) });
    cursor = r.end;
  }
  if (cursor < text.length) el.appendText(text.slice(cursor));
}
