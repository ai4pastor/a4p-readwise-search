import { App, MarkdownView, Notice } from "obsidian";
import { SearchHit } from "./search";
import { DailyReviewHighlight } from "./types";

interface CalloutInput {
  title: string;
  author: string | null | undefined;
  text: string;
  note: string;
  url: string;
}

function buildCallout(input: CalloutInput): string {
  const title = input.title.trim() || "제목 없음";
  const author = input.author?.trim();
  const text = (input.text ?? "").trim();
  const note = (input.note ?? "").trim();
  const url = input.url?.trim() ?? "";

  const headline = author ? `${title} — ${author}` : title;

  const lines: string[] = [];
  lines.push(`> [!quote] ${headline}`);
  for (const t of text.split("\n")) lines.push(`> ${t}`);
  if (note) {
    lines.push(`> `);
    for (const n of note.split("\n")) lines.push(`> _${n}_`);
  }
  if (url) {
    lines.push(`> `);
    lines.push(`> [Readwise](${url})`);
  }
  return lines.join("\n") + "\n";
}

export function formatCallout(hit: SearchHit): string {
  return buildCallout({
    title: hit.book.title ?? "",
    author: hit.book.author,
    text: hit.highlight.text ?? "",
    note: hit.highlight.note ?? "",
    url: hit.book.source_url || hit.book.readwise_url || "",
  });
}

export function formatDailyCallout(dh: DailyReviewHighlight): string {
  return buildCallout({
    title: dh.title ?? "",
    author: dh.author,
    text: dh.text ?? "",
    note: dh.note ?? "",
    url: dh.highlight_url || dh.source_url || dh.url || "",
  });
}

export function insertCitation(app: App, hit: SearchHit): boolean {
  return insertBlock(app, formatCallout(hit));
}

export function insertDailyCitations(app: App, items: DailyReviewHighlight[]): boolean {
  if (items.length === 0) return false;
  const block = items.map(formatDailyCallout).join("\n");
  return insertBlock(app, block);
}

export function insertDailyCitation(app: App, dh: DailyReviewHighlight): boolean {
  return insertBlock(app, formatDailyCallout(dh));
}

function findTargetMarkdownView(app: App): MarkdownView | null {
  const active = app.workspace.getActiveViewOfType(MarkdownView);
  if (active) return active;
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    if (leaf.view instanceof MarkdownView) return leaf.view;
  }
  return null;
}

function insertBlock(app: App, block: string): boolean {
  const view = findTargetMarkdownView(app);
  if (!view) {
    new Notice("인용을 삽입할 마크다운 노트를 먼저 열어주세요.");
    return false;
  }
  const editor = view.editor;
  const cursor = editor.getCursor();
  const needsLeadingNewline = cursor.ch > 0;
  editor.replaceRange(needsLeadingNewline ? `\n${block}` : block, cursor);
  return true;
}
