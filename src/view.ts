import { ItemView, WorkspaceLeaf } from "obsidian";
import type ReadwiseSearchPlugin from "./main";
import { insertCitation } from "./citation";
import { searchHighlights, SearchHit } from "./search";

export const VIEW_TYPE_READWISE_SEARCH = "a4p-readwise-search-view";

const DEBOUNCE_MS = 150;
const SNIPPET_MAX = 280;

export class ReadwiseSearchView extends ItemView {
  private plugin: ReadwiseSearchPlugin;
  private inputEl!: HTMLInputElement;
  private resultsEl!: HTMLDivElement;
  private statusEl!: HTMLDivElement;
  private debounceTimer: number | null = null;
  private currentQuery = "";

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

    this.statusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.resultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.renderEmpty();
  }

  async onClose() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
  }

  private scheduleSearch() {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.currentQuery = this.inputEl.value;
      this.runSearch();
    }, DEBOUNCE_MS);
  }

  private runSearch() {
    const books = this.plugin.cache.books;

    if (books.length === 0) {
      this.renderEmpty();
      return;
    }

    const query = this.currentQuery.trim();
    if (!query) {
      this.statusEl.setText(`캐시: ${this.plugin.settings.bookCount}권 · ${this.plugin.settings.highlightCount}건. 검색어를 입력하세요.`);
      this.resultsEl.empty();
      return;
    }

    const hits = searchHighlights(books, query);
    this.statusEl.setText(
      hits.length === 0 ? "결과 없음" : `${hits.length}건 (상위 100건까지)`,
    );
    this.renderResults(hits);
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

    const url = hit.book.source_url || hit.book.readwise_url;
    if (url) {
      const link = actions.createEl("a", { text: "Readwise", href: url });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      link.addClass("a4p-rw-link");
    }
  }

  refreshAfterSync() {
    this.runSearch();
  }
}
