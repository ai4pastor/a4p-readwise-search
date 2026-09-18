import { App, MarkdownView, Notice, normalizePath, TFile, TFolder, WorkspaceLeaf } from "obsidian";
import { HighlightNoteIndex, parseHighlightId } from "./note-index";
import { SearchHit } from "./search";
import { ReadwiseSearchSettings } from "./settings";
import { applyNoteTemplate } from "./templater";
import { DailyReviewHighlight } from "./types";

interface NormalizedHighlight {
  highlightId: number;
  bookTitle: string;
  author: string | null;
  category: string | null;
  text: string;
  note: string;
  sourceUrl: string;
  readwiseUrl: string;
  tags: string[];
}

function fromHit(hit: SearchHit): NormalizedHighlight {
  return {
    highlightId: hit.highlight.id,
    bookTitle: hit.book.title || "제목 없음",
    author: hit.book.author,
    category: hit.book.category,
    text: hit.highlight.text ?? "",
    note: hit.highlight.note ?? "",
    sourceUrl: hit.book.source_url ?? "",
    readwiseUrl: hit.book.readwise_url ?? "",
    tags: dedupe([
      ...(hit.highlight.tags ?? []).map((t) => t.name),
      ...(hit.book.book_tags ?? []).map((t) => t.name),
    ]),
  };
}

function fromDaily(dh: DailyReviewHighlight): NormalizedHighlight {
  return {
    highlightId: dh.id,
    bookTitle: dh.title || "제목 없음",
    author: dh.author,
    category: dh.category ?? null,
    text: dh.text ?? "",
    note: dh.note ?? "",
    sourceUrl: dh.source_url ?? dh.url ?? "",
    readwiseUrl: dh.highlight_url ?? "",
    tags: [],
  };
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

// 분류 템플릿 실행으로 생성이 수 초 걸릴 수 있어, 같은 highlight의 재클릭으로 " (2)" 중복이 생기는 것을 막는다
const inFlight = new Set<number>();

// 파일명 = "{원본 제목} — {본문 스니펫}" — 부분별 안전 상한.
// 노트가 지정 폴더에 평평하게 저장되므로(책별 하위폴더 없음) 파일명이
// 출처(책/아티클)를 스스로 식별해야 한다 — 제목을 앞에 두는 이유.
// (v0.1.6 도입 → v0.1.7에서 되돌림 → 2026-09-02 사용자 결정으로 재적용)
// 파일시스템·동기화 계층(macOS NFD, iCloud, Obsidian Sync)의 255바이트 한계 대비
// 최악(제목 100 + " — " 3 + 스니펫 60 + " (50).md" 8 ≈ 171바이트)에도 여유가 크다.
// 한글은 NFD에서 글자당 6~9바이트 → 제목 ≈ 11~16자, 스니펫 ≈ 7~10자.
const TITLE_MAX_CHARS = 30;
const TITLE_MAX_NFD_BYTES = 100;
const SNIPPET_MAX_CHARS = 20;
const SNIPPET_MAX_NFD_BYTES = 60;

// Obsidian/OS가 파일명에 허용하지 않거나 링크를 깨뜨리는 문자 → 유사 전각 문자
const CHAR_MAP: Record<string, string> = {
  "\\": "＼",
  "/": "／",
  ":": "：",
  "*": "＊",
  "?": "？",
  '"': "˝",
  "<": "＜",
  ">": "＞",
  "|": "｜",
  "#": "＃",
  "^": "ˆ",
  "[": "〔",
  "]": "〕",
};

function nfdByteLength(s: string): number {
  return new TextEncoder().encode(s.normalize("NFD")).length;
}

function truncateFileName(s: string, maxChars: number, maxNfdBytes: number): string {
  let out = "";
  let chars = 0;
  for (const ch of s) {
    if (chars + 1 > maxChars) break;
    if (nfdByteLength(out + ch) > maxNfdBytes) break;
    out += ch;
    chars++;
  }
  if (out.length < s.length) {
    // 잘렸으면 자연스러운 지점까지 되돌린다: 문장 끝(.!?…) 우선, 없으면 단어 끝(공백)
    let sentenceEnd = -1;
    for (const m of out.matchAll(/[.!?…]/g)) sentenceEnd = (m.index ?? -1) + 1;
    if (sentenceEnd >= Math.floor(out.length * 0.3)) {
      out = out.slice(0, sentenceEnd);
    } else {
      const lastSpace = out.lastIndexOf(" ");
      if (lastSpace >= Math.floor(out.length * 0.5)) out = out.slice(0, lastSpace);
    }
  }
  // 선행 마침표는 숨김 파일 취급, 끝의 공백·마침표는 Windows에서 불가 (끝의 쉼표도 정리)
  return out.replace(/^\.+/, "").replace(/[\s.,]+$/g, "");
}

function sanitizeSegment(s: string, maxChars: number, maxNfdBytes: number): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]]/g, (c) => CHAR_MAP[c] ?? " ")
    .replace(/\s+/g, " ")
    .trim();
  return truncateFileName(cleaned, maxChars, maxNfdBytes);
}

function buildBaseName(n: NormalizedHighlight): string {
  const title = sanitizeSegment(n.bookTitle, TITLE_MAX_CHARS, TITLE_MAX_NFD_BYTES);
  const snippet = sanitizeSegment(
    n.text.split("\n")[0] ?? "",
    SNIPPET_MAX_CHARS,
    SNIPPET_MAX_NFD_BYTES,
  );
  if (title && snippet) return `${title} — ${snippet}`;
  return title || snippet || "highlight";
}

// 같은 highlight의 기존 노트는 HighlightNoteIndex(볼트 전체)가 먼저 찾는다.
// 여기서는 빈 파일명을 고르되, 인덱스가 놓친 같은 id의 노트가 그 이름에 있으면 그것을 돌려준다.
function resolvePath(
  app: App,
  folder: string,
  baseName: string,
  highlightId: number,
): { path: string; existing: TFile | null } {
  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : ` (${i + 1})`;
    const path = normalizePath(`${folder}/${baseName}${suffix}.md`);
    const file = app.vault.getAbstractFileByPath(path);
    if (!file) return { path, existing: null };
    if (file instanceof TFile) {
      const fmId = parseHighlightId(
        app.metadataCache.getFileCache(file)?.frontmatter?.highlight_id,
      );
      if (fmId === highlightId) return { path, existing: file };
    }
  }
  throw new Error("같은 이름의 노트가 너무 많아 새 파일명을 만들 수 없습니다.");
}

/** 사용자가 생각을 적는 섹션 제목 — 본문 맨 아래에 두고, 생성 직후 커서가 이 아래로 간다 */
export const THOUGHTS_HEADING = "## 내 생각";

function buildContent(n: NormalizedHighlight): string {
  const fmLines: string[] = ["---"];
  fmLines.push(`book: ${yamlString(n.bookTitle)}`);
  if (n.author) fmLines.push(`author: ${yamlString(n.author)}`);
  if (n.category) fmLines.push(`category: ${n.category}`);
  fmLines.push(`highlight_id: ${n.highlightId}`);
  if (n.sourceUrl) fmLines.push(`source_url: ${yamlString(n.sourceUrl)}`);
  if (n.readwiseUrl) fmLines.push(`readwise_url: ${yamlString(n.readwiseUrl)}`);
  if (n.tags.length > 0) {
    fmLines.push(`tags:`);
    for (const t of n.tags) fmLines.push(`  - ${yamlString(t)}`);
  }
  fmLines.push(`created_via: a4p-readwise-search`);
  fmLines.push("---");

  // 출처(인용)를 먼저 읽고 바로 아래에 생각을 이어 쓰는 흐름 (v0.2.3, 사용자 요청)
  const headline = `${n.bookTitle}${n.author ? ` — ${n.author}` : ""}`;
  const body: string[] = [];
  body.push(`## 출처`);
  body.push(`> [!quote] ${headline}`);
  for (const line of n.text.trim().split("\n")) body.push(`> ${line}`);
  if (n.note.trim()) {
    body.push(`> `);
    for (const line of n.note.trim().split("\n")) body.push(`> _${line}_`);
  }
  if (n.readwiseUrl || n.sourceUrl) {
    body.push("");
    const links: string[] = [];
    if (n.readwiseUrl) links.push(`[Readwise](${n.readwiseUrl})`);
    if (n.sourceUrl) links.push(`[원문](${n.sourceUrl})`);
    body.push(links.join(" · "));
  }
  body.push("");
  body.push(THOUGHTS_HEADING);
  body.push(""); // 커서 자리

  return fmLines.join("\n") + "\n\n" + body.join("\n") + "\n";
}

function yamlString(s: string): string {
  if (/[:#\-?&*,\[\]{}|>!%@`'"\n]/.test(s) || /^\s|\s$/.test(s)) {
    return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return s;
}

async function ensureFolder(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let cur = "";
  for (const seg of segments) {
    cur = cur ? `${cur}/${seg}` : seg;
    const existing = app.vault.getAbstractFileByPath(cur);
    if (!existing) {
      await app.vault.createFolder(cur);
    } else if (!(existing instanceof TFolder)) {
      throw new Error(`경로가 폴더가 아닙니다: ${cur}`);
    }
  }
}

async function createOrOpen(
  app: App,
  settings: ReadwiseSearchSettings,
  index: HighlightNoteIndex,
  n: NormalizedHighlight,
): Promise<void> {
  if (inFlight.has(n.highlightId)) {
    new Notice("이미 생성 중입니다");
    return;
  }
  inFlight.add(n.highlightId);
  try {
    await createOrOpenInner(app, settings, index, n);
  } finally {
    inFlight.delete(n.highlightId);
  }
}

async function createOrOpenInner(
  app: App,
  settings: ReadwiseSearchSettings,
  index: HighlightNoteIndex,
  n: NormalizedHighlight,
): Promise<void> {
  // 이미 있으면 바로 연다 — 카드 버튼이 "노트 열기"로 보이던 경우 (Notice 불필요)
  const existing = index.getFile(n.highlightId);
  if (existing) {
    await openNote(app, existing);
    return;
  }

  const root = (settings.noteRootFolder || "Readwise").trim().replace(/^\/+|\/+$/g, "");
  await ensureFolder(app, root);

  const baseName = buildBaseName(n);
  const { path, existing: probed } = resolvePath(app, root, baseName, n.highlightId);
  if (probed) {
    // 인덱스가 아직 못 본 노트(드묾) — 인덱스에 올리고 연다
    index.add(probed.path, n.highlightId);
    new Notice("이미 존재하는 메모를 엽니다");
    await openNote(app, probed);
    return;
  }

  const created = await app.vault.create(path, buildContent(n));
  if (!(created instanceof TFile)) throw new Error("메모 생성 결과를 확인할 수 없습니다.");
  // metadataCache를 기다리지 않고 카드를 즉시 "노트 열기"로
  index.add(created.path, n.highlightId);

  if (settings.noteTemplatePath) {
    new Notice("메모 생성됨 · 분류 템플릿 적용 중… (수 초 걸릴 수 있습니다)");
    // 분류가 끝난 뒤 열어야 입력 중인 내용이 덮어써지지 않는다 (실패해도 노트는 그대로 열림)
    await applyNoteTemplate(app, created, settings.noteTemplatePath, {
      readwiseTags: n.tags,
      highlightId: n.highlightId,
      insertBodyAbove: THOUGHTS_HEADING,
    });
  } else {
    new Notice("메모 생성됨");
  }

  // 템플릿 실행 중 사용자가 노트를 지웠을 수 있다
  if (!(app.vault.getAbstractFileByPath(created.path) instanceof TFile)) {
    new Notice("노트가 생성 도중 삭제되어 열지 않습니다");
    return;
  }
  await openNote(app, created, { cursorAtThoughts: true });
}

/** 이미 열린 탭이 있으면 그 탭으로, 없으면 새 탭(편집 모드)에서 열어 바로 생각을 적도록 */
async function openNote(
  app: App,
  file: TFile,
  opts: { cursorAtThoughts?: boolean } = {},
): Promise<void> {
  for (const leaf of app.workspace.getLeavesOfType("markdown")) {
    const view = leaf.view;
    if (view instanceof MarkdownView && view.file?.path === file.path) {
      app.workspace.setActiveLeaf(leaf, { focus: true });
      await app.workspace.revealLeaf(leaf);
      return;
    }
  }
  const leaf = app.workspace.getLeaf(true);
  // 읽기 모드가 기본인 사용자도 바로 입력할 수 있게 편집 모드로 연다
  await leaf.openFile(file, { state: { mode: "source" } });
  if (opts.cursorAtThoughts) await placeCursorBelowHeading(leaf, THOUGHTS_HEADING);
}

/** 제목 바로 아래 빈 줄에 커서를 둔다. 에디터 내용이 아직 안 올라왔으면 잠시 기다려 재시도 */
async function placeCursorBelowHeading(leaf: WorkspaceLeaf, heading: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return;
    const lines = view.editor.getValue().split("\n");
    const idx = lines.findIndex((l) => l.trim() === heading);
    if (idx >= 0) {
      const line = Math.min(idx + 1, lines.length - 1);
      view.editor.setCursor({ line, ch: 0 });
      view.editor.focus();
      return;
    }
    // 내용은 올라왔는데 제목이 없으면(사용자 편집 등) 건드리지 않는다
    if (lines.join("").trim() !== "") return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function createHighlightNoteFromHit(
  app: App,
  settings: ReadwiseSearchSettings,
  index: HighlightNoteIndex,
  hit: SearchHit,
): Promise<void> {
  try {
    await createOrOpen(app, settings, index, fromHit(hit));
  } catch (e) {
    handleError(e);
  }
}

export async function createHighlightNoteFromDaily(
  app: App,
  settings: ReadwiseSearchSettings,
  index: HighlightNoteIndex,
  dh: DailyReviewHighlight,
): Promise<void> {
  try {
    await createOrOpen(app, settings, index, fromDaily(dh));
  } catch (e) {
    handleError(e);
  }
}

function handleError(e: unknown) {
  const msg = e instanceof Error ? e.message : "알 수 없는 오류";
  new Notice(`메모 생성 실패: ${msg}`, 8000);
}
