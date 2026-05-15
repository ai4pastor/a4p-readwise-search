import { ItemView, WorkspaceLeaf } from "obsidian";
import type ReadwiseSearchPlugin from "./main";
import { insertCitation } from "./citation";
import {
  ActiveFilters,
  collectFilterOptions,
  FilterOptions,
  hasActiveFilters,
} from "./filters";
import { searchHighlights, SearchHit } from "./search";

export const VIEW_TYPE_READWISE_SEARCH = "a4p-readwise-search-view";

const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 280;
const TAG_VISIBLE_LIMIT = 20;

export class ReadwiseSearchView extends ItemView {
  private plugin: ReadwiseSearchPlugin;
  private inputEl!: HTMLInputElement;
  private filtersEl!: HTMLDivElement;
  private resultsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private debounceTimer: number | null = null;
  private currentQuery = "";
  private filters: ActiveFilters = {
    bookIds: new Set(),
    tagNames: new Set(),
    categories: new Set(),
  };
  private options: FilterOptions = { books: [], tags: [], categories: [] };
  private tagsExpanded = false;

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

    const header = root.createDiv({ cls: "a4p-rw-header" });
    header.createEl("h3", { text: "Readwise Search" });

    this.inputEl = header.createEl("input", {
      cls: "a4p-rw-search-input",
      attr: { type: "search", placeholder: "highlights 검색..." },
    });
    this.inputEl.addEventListener("input", () => this.scheduleSearch());

    this.filtersEl = root.createDiv({ cls: "a4p-rw-filters" });
    this.statusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.resultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.rebuildFilterOptions();
    this.renderFilters();
    this.runSearch();
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
  }

  private rebuildFilterOptions() {
    this.options = collectFilterOptions(this.plugin.cache.books);
  }

  private scheduleSearch() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.currentQuery = this.inputEl.value;
      this.runSearch();
    }, DEBOUNCE_MS);
  }

  private renderFilters() {
    const el = this.filtersEl;
    el.empty();

    if (this.plugin.cache.books.length === 0) return;

    const row = el.createDiv({ cls: "a4p-rw-filter-row" });

    const bookSel = row.createEl("select", { cls: "a4p-rw-filter-select" });
    bookSel.createEl("option", { value: "", text: "책: (전체)" });
    for (const b of this.options.books) {
      bookSel.createEl("option", { value: String(b.id), text: b.label });
    }
    const currentBook = this.filters.bookIds && this.filters.bookIds.size > 0
      ? Array.from(this.filters.bookIds)[0]
      : null;
    if (currentBook !== null) bookSel.value = String(currentBook);
    bookSel.addEventListener("change", () => {
      const v = bookSel.value;
      this.filters.bookIds = v ? new Set([parseInt(v, 10)]) : new Set();
      this.runSearch();
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

    const clearBtn = row.createEl("button", {
      cls: "a4p-rw-filter-clear",
      text: "초기화",
    });
    clearBtn.addEventListener("click", () => {
      this.filters = { bookIds: new Set(), tagNames: new Set(), categories: new Set() };
      this.tagsExpanded = false;
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
    const books = this.plugin.cache.books;

    if (books.length === 0) {
      this.renderEmpty();
      return;
    }

    const query = this.currentQuery.trim();
    const filtersActive = hasActiveFilters(this.filters);

    if (!query && !filtersActive) {
      this.statusEl.setText(
        `캐시: ${this.plugin.settings.bookCount}권 · ${this.plugin.settings.highlightCount}건. 검색어 또는 필터를 선택하세요.`,
      );
      this.resultsEl.empty();
      return;
    }

    const hits = searchHighlights(books, query, this.filters);
    const filterSummary = this.summarizeFilters();
    const base =
      hits.length === 0 ? "결과 없음" : `${hits.length}건 (상위 100건까지)`;
    this.statusEl.setText(filterSummary ? `${base} · ${filterSummary}` : base);
    this.renderResults(hits);
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

  private renderEmpty() {
    this.resultsEl.empty();
    this.statusEl.setText("");
    const empty = this.resultsEl.createDiv({ cls: "a4p-rw-empty" });
    empty.createEl("p", { text: "아직 동기화된 데이터가 없습니다." });
    empty.createEl("p", {
      text: "설정 → Readwise Search 에서 토큰 입력 후 '전체 동기화'를 실행해주세요.",
    });
  }

  private renderResults(hits: SearchHit[]) {
    this.resultsEl.empty();
    for (const hit of hits) this.renderCard(hit);
  }

  private renderCard(hit: SearchHit) {
    const card = this.resultsEl.createDiv({ cls: "a4p-rw-card" });

    const meta = card.createDiv({ cls: "a4p-rw-meta" });
    const titleText = hit.book.title || "Untitled";
    const author = hit.book.author?.trim();
    meta.createSpan({ cls: "a4p-rw-title", text: titleText });
    if (author) meta.createSpan({ cls: "a4p-rw-author", text: ` — ${author}` });

    const body = card.createDiv({ cls: "a4p-rw-body" });
    const text = hit.highlight.text ?? "";
    body.setText(text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text);

    const note = (hit.highlight.note ?? "").trim();
    if (note) {
      const noteEl = card.createDiv({ cls: "a4p-rw-note" });
      noteEl.setText(note);
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
    this.renderFilters();
    this.runSearch();
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
