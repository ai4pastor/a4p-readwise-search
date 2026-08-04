import { App, Notice, normalizePath, TFile, TFolder } from "obsidian";
import { SearchHit } from "./search";
import { ReadwiseSearchSettings } from "./settings";
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

// 파일명 = 본문 첫 줄 스니펫 — 안전 상한.
// 파일시스템·동기화 계층(macOS NFD, iCloud, Obsidian Sync)의 255바이트 한계 대비
// 여유를 크게 둔 값. 한글은 NFD에서 글자당 6~9바이트라 90바이트 ≈ 한글 10~15자.
const NAME_MAX_CHARS = 25;
const NAME_MAX_NFD_BYTES = 90;

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
  return (
    sanitizeSegment(n.text.split("\n")[0] ?? "", NAME_MAX_CHARS, NAME_MAX_NFD_BYTES) ||
    "highlight"
  );
}

// 파일명 규칙과 무관하게 같은 highlight의 기존 노트를 찾는다
// (파일명 상한이 바뀌기 전 만들어진 긴 이름의 노트도 중복 생성 없이 열기 위함)
function findExistingByHighlightId(
  app: App,
  folder: string,
  highlightId: number,
): TFile | null {
  const root = app.vault.getAbstractFileByPath(normalizePath(folder));
  if (!(root instanceof TFolder)) return null;
  for (const child of root.children) {
    if (!(child instanceof TFile) || child.extension !== "md") continue;
    const fmId = app.metadataCache.getFileCache(child)?.frontmatter?.highlight_id;
    if (typeof fmId === "number" && fmId === highlightId) return child;
  }
  return null;
}

async function resolvePath(
  app: App,
  folder: string,
  baseName: string,
  highlightId: number,
): Promise<{ path: string; existing: TFile | null }> {
  const byId = findExistingByHighlightId(app, folder, highlightId);
  if (byId) return { path: byId.path, existing: byId };

  for (let i = 0; i < 50; i++) {
    const suffix = i === 0 ? "" : ` (${i + 1})`;
    const path = normalizePath(`${folder}/${baseName}${suffix}.md`);
    const file = app.vault.getAbstractFileByPath(path);
    if (!file) return { path, existing: null };
    if (file instanceof TFile) {
      const fmId = app.metadataCache.getFileCache(file)?.frontmatter?.highlight_id;
      if (typeof fmId === "number" && fmId === highlightId) {
        return { path, existing: file };
      }
    }
  }
  throw new Error("같은 이름의 노트가 너무 많아 새 파일명을 만들 수 없습니다.");
}

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

  const headline = `${n.bookTitle}${n.author ? ` — ${n.author}` : ""}`;
  const body: string[] = [];
  body.push(`## 내 생각`);
  body.push("");
  body.push("");
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
  n: NormalizedHighlight,
): Promise<void> {
  const root = (settings.noteRootFolder || "Readwise").trim().replace(/^\/+|\/+$/g, "");
  await ensureFolder(app, root);

  const baseName = buildBaseName(n);
  const { path, existing } = await resolvePath(app, root, baseName, n.highlightId);

  let file: TFile;
  if (existing) {
    file = existing;
    new Notice("이미 존재하는 메모를 엽니다");
  } else {
    const created = await app.vault.create(path, buildContent(n));
    if (!(created instanceof TFile)) throw new Error("메모 생성 결과를 확인할 수 없습니다.");
    file = created;
    new Notice("메모 생성됨");
  }

  // 새 탭에서 열어 바로 생각을 적도록
  const leaf = app.workspace.getLeaf(true);
  await leaf.openFile(file);
}

export async function createHighlightNoteFromHit(
  app: App,
  settings: ReadwiseSearchSettings,
  hit: SearchHit,
): Promise<void> {
  try {
    await createOrOpen(app, settings, fromHit(hit));
  } catch (e) {
    handleError(e);
  }
}

export async function createHighlightNoteFromDaily(
  app: App,
  settings: ReadwiseSearchSettings,
  dh: DailyReviewHighlight,
): Promise<void> {
  try {
    await createOrOpen(app, settings, fromDaily(dh));
  } catch (e) {
    handleError(e);
  }
}

function handleError(e: unknown) {
  const msg = e instanceof Error ? e.message : "알 수 없는 오류";
  new Notice(`메모 생성 실패: ${msg}`, 8000);
}
