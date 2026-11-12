import { App, Editor, EditorPosition, MarkdownView, Notice, Plugin } from "obsidian";
import {
  CitationOptions,
  formatCitation,
  isBlockCitation,
  joinCitations,
  sourceFromDaily,
  sourceFromHit,
} from "./citation-format";
import { SearchHit } from "./search";
import type { ReadwiseSearchSettings } from "./settings";
import { DailyReviewHighlight } from "./types";

let lastMarkdownView: MarkdownView | null = null;

export function registerCitationTracker(plugin: Plugin): void {
  const app = plugin.app;
  const seed = app.workspace.getActiveViewOfType(MarkdownView);
  if (seed) lastMarkdownView = seed;
  plugin.registerEvent(
    app.workspace.on("active-leaf-change", (leaf) => {
      if (leaf && leaf.view instanceof MarkdownView) {
        lastMarkdownView = leaf.view;
      }
    }),
  );
}

export function citationOptions(settings: ReadwiseSearchSettings): CitationOptions {
  return { format: settings.citationFormat, template: settings.citationTemplate };
}

export function formatHitCitation(hit: SearchHit, opts: CitationOptions): string {
  return formatCitation(sourceFromHit(hit), opts);
}

export function formatDailyCitation(dh: DailyReviewHighlight, opts: CitationOptions): string {
  return formatCitation(sourceFromDaily(dh), opts);
}

export function insertCitation(app: App, hit: SearchHit, opts: CitationOptions): boolean {
  return insertAtCursor(app, formatHitCitation(hit, opts));
}

export function insertDailyCitations(
  app: App,
  items: DailyReviewHighlight[],
  opts: CitationOptions,
): boolean {
  if (items.length === 0) return false;
  return insertAtCursor(app, joinCitations(items.map((dh) => formatDailyCitation(dh, opts))));
}

export function insertDailyCitation(app: App, dh: DailyReviewHighlight, opts: CitationOptions): boolean {
  return insertAtCursor(app, formatDailyCitation(dh, opts));
}

/** 이미 만든 인용 문자열을 마지막으로 쓰던 노트의 커서 자리에 넣는다 (큰 검색 창의 여러 개 넣기) */
export function insertCitationText(app: App, text: string): boolean {
  return insertAtCursor(app, text);
}

/**
 * from~to를 인용으로 바꾸고 커서를 인용 뒤에 둔다 (노트 안 자동완성은 시작 글자부터 커서까지를 바꾼다).
 * 블록 인용은 줄 중간이면 새 줄에서 시작하고, 뒤에 글이 남아 있으면 빈 줄을 하나 두어
 * 남은 글이 콜아웃에 이어 붙지 않게 한다.
 */
export function replaceWithCitation(
  editor: Editor,
  text: string,
  from: EditorPosition,
  to: EditorPosition = from,
): void {
  let insert = text;
  if (isBlockCitation(text)) {
    if (from.ch > 0) insert = `\n${insert}`;
    if (editor.getLine(to.line).slice(to.ch).trim() !== "") insert = `${insert}\n`;
  }
  editor.replaceRange(insert, from, to);
  editor.setCursor(editor.offsetToPos(editor.posToOffset(from) + insert.length));
}

function findTargetMarkdownView(app: App): MarkdownView | null {
  const leaves = app.workspace.getLeavesOfType("markdown");
  if (lastMarkdownView) {
    const stillOpen = leaves.some((l) => l.view === lastMarkdownView);
    if (stillOpen) return lastMarkdownView;
    lastMarkdownView = null;
  }
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active) return active;
  for (const leaf of leaves) {
    if (leaf.view instanceof MarkdownView) return leaf.view;
  }
  return null;
}

function insertAtCursor(app: App, text: string): boolean {
  const view = findTargetMarkdownView(app);
  if (!view) {
    new Notice("인용을 삽입할 마크다운 노트를 먼저 열어주세요.");
    return false;
  }
  replaceWithCitation(view.editor, text, view.editor.getCursor());
  return true;
}
