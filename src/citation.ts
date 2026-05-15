import { App, MarkdownView, Notice } from "obsidian";
import { SearchHit } from "./search";

export function formatCallout(hit: SearchHit): string {
  const { highlight, book } = hit;
  const title = book.title?.trim() || "Untitled";
  const author = book.author?.trim();
  const url = book.source_url || book.readwise_url || "";
  const text = (highlight.text ?? "").trim();
  const note = (highlight.note ?? "").trim();

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

export function insertCitation(app: App, hit: SearchHit): boolean {
  const view = app.workspace.getActiveViewOfType(MarkdownView);
  if (!view) {
    new Notice("인용을 삽입할 마크다운 노트를 먼저 열어주세요.");
    return false;
  }
  const editor = view.editor;
  const callout = formatCallout(hit);
  const cursor = editor.getCursor();
  const needsLeadingNewline = cursor.ch > 0;
  editor.replaceRange(needsLeadingNewline ? `\n${callout}` : callout, cursor);
  return true;
}
