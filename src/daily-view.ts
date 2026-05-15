import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import {
  ReadwiseApiError,
  ReadwiseAuthError,
  ReadwiseClient,
  ReadwiseRateLimitError,
} from "./api";
import { insertDailyCitation, insertDailyCitations } from "./citation";
import type ReadwiseSearchPlugin from "./main";
import { DailyReview, DailyReviewHighlight } from "./types";

export const VIEW_TYPE_READWISE_DAILY = "a4p-readwise-daily-view";

const SNIPPET_MAX = 280;

export class ReadwiseDailyView extends ItemView {
  private plugin: ReadwiseSearchPlugin;
  private statusEl!: HTMLDivElement;
  private actionsEl!: HTMLDivElement;
  private resultsEl!: HTMLDivElement;
  private current: DailyReview | null = null;
  private loading = false;

  constructor(leaf: WorkspaceLeaf, plugin: ReadwiseSearchPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_READWISE_DAILY;
  }

  getDisplayText(): string {
    return "Readwise Daily Review";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen() {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("a4p-rw-panel");

    const header = root.createDiv({ cls: "a4p-rw-header" });
    header.createEl("h3", { text: "Daily Review" });

    this.actionsEl = root.createDiv({ cls: "a4p-rw-daily-actions" });
    this.statusEl = root.createDiv({ cls: "a4p-rw-status" });
    this.resultsEl = root.createDiv({ cls: "a4p-rw-results" });

    this.renderActions();
    await this.fetch();
  }

  private renderActions() {
    const el = this.actionsEl;
    el.empty();

    const refreshBtn = el.createEl("button", {
      cls: "a4p-rw-daily-btn",
      text: "새로고침",
    });
    refreshBtn.addEventListener("click", () => void this.fetch());

    const insertAllBtn = el.createEl("button", {
      cls: "a4p-rw-daily-btn",
      text: "오늘 review 전체 인용 삽입",
    });
    insertAllBtn.addEventListener("click", () => {
      if (!this.current || this.current.highlights.length === 0) {
        new Notice("삽입할 항목이 없습니다.");
        return;
      }
      const ok = insertDailyCitations(this.app, this.current.highlights);
      if (ok) new Notice(`${this.current.highlights.length}개 인용 삽입 완료`);
    });

    if (this.current?.review_url) {
      const link = el.createEl("a", {
        text: "Readwise에서 열기",
        href: this.current.review_url,
        cls: "a4p-rw-link",
      });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
    }
  }

  private async fetch() {
    if (this.loading) return;
    if (!this.plugin.settings.apiToken) {
      this.statusEl.setText("설정에서 Readwise 토큰을 먼저 입력해주세요.");
      this.resultsEl.empty();
      return;
    }

    this.loading = true;
    this.statusEl.setText("Daily Review 가져오는 중...");
    this.resultsEl.empty();

    try {
      const client = new ReadwiseClient(this.plugin.settings.apiToken);
      const review = await client.getDailyReview();
      this.current = review;
      this.statusEl.setText(
        `${review.highlights.length}개 항목${review.review_completed ? " · 오늘 review 완료됨" : ""}`,
      );
      this.renderActions();
      this.renderHighlights(review.highlights);
    } catch (e) {
      this.current = null;
      if (e instanceof ReadwiseAuthError) {
        this.statusEl.setText(`인증 실패: ${e.message}`);
      } else if (e instanceof ReadwiseRateLimitError) {
        this.statusEl.setText(`Rate limit. ${e.retryAfterSec}초 후 다시 시도해주세요.`);
      } else if (e instanceof ReadwiseApiError) {
        this.statusEl.setText(`API 오류: ${e.message}`);
      } else if (e instanceof Error) {
        this.statusEl.setText(`오류: ${e.message}`);
      } else {
        this.statusEl.setText("알 수 없는 오류");
      }
      this.renderActions();
    } finally {
      this.loading = false;
    }
  }

  private renderHighlights(items: DailyReviewHighlight[]) {
    this.resultsEl.empty();
    if (items.length === 0) {
      const empty = this.resultsEl.createDiv({ cls: "a4p-rw-empty" });
      empty.createEl("p", { text: "오늘의 Daily Review 항목이 없습니다." });
      return;
    }
    for (const dh of items) this.renderCard(dh);
  }

  private renderCard(dh: DailyReviewHighlight) {
    const card = this.resultsEl.createDiv({ cls: "a4p-rw-card" });

    const meta = card.createDiv({ cls: "a4p-rw-meta" });
    meta.createSpan({ cls: "a4p-rw-title", text: dh.title || "Untitled" });
    if (dh.author) meta.createSpan({ cls: "a4p-rw-author", text: ` — ${dh.author}` });

    const body = card.createDiv({ cls: "a4p-rw-body" });
    const text = dh.text ?? "";
    body.setText(text.length > SNIPPET_MAX ? text.slice(0, SNIPPET_MAX) + "…" : text);

    const note = (dh.note ?? "").trim();
    if (note) {
      card.createDiv({ cls: "a4p-rw-note" }).setText(note);
    }

    const actions = card.createDiv({ cls: "a4p-rw-actions" });
    const insertBtn = actions.createEl("button", {
      cls: "a4p-rw-insert",
      text: "노트에 인용 삽입",
    });
    insertBtn.addEventListener("click", () => insertDailyCitation(this.app, dh));

    const url = dh.highlight_url || dh.source_url || dh.url;
    if (url) {
      const link = actions.createEl("a", { text: "Readwise/원문", href: url });
      link.setAttr("target", "_blank");
      link.setAttr("rel", "noopener");
      link.addClass("a4p-rw-link");
    }
  }
}
