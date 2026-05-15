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
    bookTitle: hit.book.title || "Untitled",
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
    bookTitle: dh.title || "Untitled",
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

function sanitizeSegment(s: string, max = 80): string {
  const cleaned = s
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max).trim() : cleaned;
}

function buildPath(root: string, n: NormalizedHighlight): string {
  const folder = `${root}/${sanitizeSegment(n.bookTitle, 100)}`;
  const snippet = sanitizeSegment(n.text.split("\n")[0] ?? "", 40) || "highlight";
  const file = `${n.highlightId} - ${snippet}.md`;
  return normalizePath(`${folder}/${file}`);
}

function buildContent(n: NormalizedHighlight): string {
  const fmLines: string[] = ["---"];
  fmLines.push(`source: ${yamlString(n.bookTitle)}`);
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

  const body: string[] = [];
  body.push(`# ${n.bookTitle}${n.author ? ` — ${n.author}` : ""}`);
  body.push("");
  body.push(n.text.trim());
  if (n.note.trim()) {
    body.push("");
    body.push(`> [!note] 메모`);
    for (const line of n.note.trim().split("\n")) body.push(`> ${line}`);
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
  const path = buildPath(root, n);

  const folderPath = path.substring(0, path.lastIndexOf("/"));
  await ensureFolder(app, folderPath);

  let file = app.vault.getAbstractFileByPath(path);
  if (!file) {
    const content = buildContent(n);
    file = await app.vault.create(path, content);
    new Notice("Highlight 노트 생성됨");
  } else {
    new Notice("이미 존재하는 노트를 엽니다");
  }

  if (file instanceof TFile) {
    const leaf = app.workspace.getLeaf(true);
    await leaf.openFile(file);
  }
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
  new Notice(`노트 생성 실패: ${msg}`, 8000);
}
