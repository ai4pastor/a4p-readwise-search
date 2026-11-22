import { App, MarkdownView, Notice, normalizePath, TFile } from "obsidian";
import { locationLabel } from "./citation-format";
import { ensureFolder, sanitizeSegment, yamlString } from "./highlight-note";
import { dayKey, localKey } from "./library";
import { highlightTime } from "./search";
import type { ReadwiseSearchSettings } from "./settings";
import type { ReadwiseBook, ReadwiseHighlight } from "./types";

/**
 * 책 한 권의 밑줄을 노트 한 장으로 (v0.5.0).
 * 노트 폴더에 "{제목} — 밑줄 모음.md"로 만든다. 같은 이름의 노트가 이미 있으면 덮어쓰지 않고 그 노트를 연다
 * ("기존 노트를 자동으로 덮어쓰지 않는다" 원칙). 프론트매터에 highlight_id를 넣지 않으므로
 * 하이라이트별 메모 노트 인덱스(HighlightNoteIndex)와 섞이지 않는다.
 */
const SUFFIX = " — 밑줄 모음";
// 파일명 = "{책 제목} — 밑줄 모음.md". 제목만으로 이름을 이루므로 하이라이트 메모 노트(30자·100바이트)보다 넉넉히 둔다.
// 최악에도 제목 190 + 접미사·확장자 약 45 = 약 235바이트 — 255바이트 한계 안.
const BOOK_TITLE_MAX_CHARS = 60;
const BOOK_TITLE_MAX_NFD_BYTES = 190;

export function bookNoteContent(book: ReadwiseBook, highlights: ReadwiseHighlight[], today = new Date()): string {
  const title = book.title || "제목 없음";
  const fm: string[] = ["---"];
  fm.push(`book: ${yamlString(title)}`);
  if (book.author) fm.push(`author: ${yamlString(book.author)}`);
  if (book.category) fm.push(`category: ${book.category}`);
  fm.push(`readwise_book_id: ${book.user_book_id}`);
  if (book.source_url) fm.push(`source_url: ${yamlString(book.source_url)}`);
  if (book.readwise_url) fm.push(`readwise_url: ${yamlString(book.readwise_url)}`);
  fm.push(`highlight_count: ${highlights.length}`);
  fm.push(`created: ${localKey(today)}`);
  const tags = Array.from(new Set((book.book_tags ?? []).map((t) => t.name)));
  if (tags.length > 0) {
    fm.push("tags:");
    for (const t of tags) fm.push(`  - ${yamlString(t)}`);
  }
  fm.push("created_via: a4p-readwise-search");
  fm.push("---");

  const body: string[] = [];
  body.push(`# ${title}`);
  body.push("");
  const byline = [book.author?.trim(), `밑줄 ${highlights.length}개`].filter(Boolean).join(" · ");
  const links: string[] = [];
  if (book.readwise_url) links.push(`[Readwise](${book.readwise_url})`);
  if (book.source_url) links.push(`[원문](${book.source_url})`);
  body.push([byline, ...links].join(" · "));
  body.push("");

  for (const h of highlights) {
    for (const line of (h.text ?? "").trim().split("\n")) body.push(`> ${line}`);
    const tail = [
      locationLabel({ location: h.location, locationType: h.location_type }),
      dayKey(highlightTime(h)),
      h.readwise_url ? `[Readwise](${h.readwise_url})` : "",
    ].filter(Boolean);
    if (tail.length > 0) {
      body.push(">");
      body.push(`> — ${tail.join(" · ")}`);
    }
    body.push("");
    // 블록 ID — [[노트#^rw123]]처럼 밑줄 하나를 가리켜 링크할 수 있다
    body.push(`^rw${h.id}`);
    body.push("");
    const memo = (h.note ?? "").trim();
    if (memo) {
      body.push(`**메모** ${memo.replace(/\n+/g, " ")}`);
      body.push("");
    }
  }
  return fm.join("\n") + "\n\n" + body.join("\n");
}

export function bookNotePath(settings: ReadwiseSearchSettings, book: ReadwiseBook): string {
  const root = (settings.noteRootFolder || "Readwise").trim().replace(/^\/+|\/+$/g, "");
  const name =
    sanitizeSegment(book.title || "제목 없음", BOOK_TITLE_MAX_CHARS, BOOK_TITLE_MAX_NFD_BYTES) || "제목 없음";
  return normalizePath(`${root}/${name}${SUFFIX}.md`);
}

export async function createBookNote(
  app: App,
  settings: ReadwiseSearchSettings,
  book: ReadwiseBook,
  highlights: ReadwiseHighlight[],
): Promise<void> {
  try {
    if (highlights.length === 0) {
      new Notice("이 책에는 내보낼 밑줄이 없습니다.");
      return;
    }
    const path = bookNotePath(settings, book);
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      new Notice("이 책의 밑줄 모음 노트가 이미 있어 그 노트를 엽니다. 새로 만들려면 그 노트의 이름을 바꾼 뒤 다시 눌러 주세요.", 8000);
      await openFile(app, existing);
      return;
    }
    if (existing) throw new Error(`같은 이름의 폴더가 있습니다: ${path}`);
    const root = path.split("/").slice(0, -1).join("/");
    if (root) await ensureFolder(app, root);
    const created = await app.vault.create(path, bookNoteContent(book, highlights));
    new Notice(`밑줄 ${highlights.length}개를 노트 한 장으로 만들었습니다.`);
    await openFile(app, created);
  } catch (e) {
    new Notice(`밑줄 모음 노트를 만들지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function openFile(app: App, file: TFile): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) {
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await app.workspace.revealLeaf(leaf);
      return;
    }
  }
  await app.workspace.getLeaf("tab").openFile(file);
}
