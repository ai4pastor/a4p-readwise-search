import type { SearchHit } from "./search";
import type { DailyReviewHighlight } from "./types";

/**
 * 인용 형식 (v0.3.0). callout이 기본값이며 v0.2.x까지의 유일한 형식과 똑같은 출력을 낸다.
 * 이 파일은 obsidian을 import하지 않는다 — 형식 규칙을 노드에서 바로 시험하기 위해서.
 */
export type CitationFormat = "callout" | "inline" | "footnote" | "custom";

export const CITATION_FORMAT_LABELS: Record<CitationFormat, string> = {
  callout: "콜아웃 (기본)",
  inline: "짧은 인용 — “…” (저자, 『책』)",
  footnote: "각주 — “…”^[저자, 『책』.]",
  custom: "사용자 정의 템플릿",
};

/**
 * 사용자 정의 템플릿의 처음 값 — 콜아웃과 같은 모양.
 * 변수가 모두 빈 줄은 빠지고, 연달아 남은 빈 인용 줄(">")은 하나로 줄어든다 (renderTemplate).
 */
export const DEFAULT_CUSTOM_TEMPLATE = [
  "> [!quote] {{title}}{{#author}} — {{author}}{{/author}}",
  "> {{text}}",
  ">",
  "> _{{note}}_",
  ">",
  "> [Readwise]({{url}})",
].join("\n");

/** 템플릿에서 쓸 수 있는 변수 — 설정 화면 안내와 미리보기에 같이 쓴다 */
export const TEMPLATE_VARIABLES: Array<[string, string]> = [
  ["text", "하이라이트 본문"],
  ["note", "Readwise 메모"],
  ["title", "책·글 제목 (book도 같음)"],
  ["author", "저자"],
  ["location", "쪽수·위치 (예: p. 12, 없으면 빈 값)"],
  ["date", "하이라이트한 날짜 (YYYY-MM-DD)"],
  ["category", "종류 (책·아티클·트윗·팟캐스트)"],
  ["url", "원문 링크 (없으면 Readwise 링크)"],
  ["source_url", "원문 링크"],
  ["readwise_url", "Readwise 링크"],
  ["id", "하이라이트 번호"],
];

export interface CitationOptions {
  format: CitationFormat;
  template: string;
}

/** 검색 결과와 Daily Review 항목을 같은 모양으로 맞춘 인용 재료 */
export interface CitationSource {
  title: string;
  author: string | null | undefined;
  category: string | null | undefined;
  text: string;
  note: string;
  /** 콜아웃 맨 아래 링크 — v0.2.x와 같은 우선순위 */
  link: string;
  sourceUrl: string;
  readwiseUrl: string;
  location: number | null | undefined;
  locationType: string | null | undefined;
  highlightedAt: string | null | undefined;
  highlightId: number;
}

export function sourceFromHit(hit: SearchHit): CitationSource {
  return {
    title: hit.book.title ?? "",
    author: hit.book.author,
    category: hit.book.category,
    text: hit.highlight.text ?? "",
    note: hit.highlight.note ?? "",
    link: hit.book.source_url || hit.book.readwise_url || "",
    sourceUrl: hit.book.source_url ?? "",
    readwiseUrl: hit.highlight.readwise_url || hit.book.readwise_url || "",
    location: hit.highlight.location,
    locationType: hit.highlight.location_type,
    highlightedAt: hit.highlight.highlighted_at,
    highlightId: hit.highlight.id,
  };
}

export function sourceFromDaily(dh: DailyReviewHighlight): CitationSource {
  return {
    title: dh.title ?? "",
    author: dh.author,
    category: dh.category,
    text: dh.text ?? "",
    note: dh.note ?? "",
    link: dh.highlight_url || dh.source_url || dh.url || "",
    sourceUrl: dh.source_url || dh.url || "",
    readwiseUrl: dh.highlight_url ?? "",
    location: dh.location,
    locationType: dh.location_type,
    highlightedAt: dh.highlighted_at,
    highlightId: dh.id,
  };
}

/** 형식대로 인용 문자열을 만든다. 블록 형식은 끝에 줄바꿈 하나, 문장 안 형식은 줄바꿈 없음 */
export function formatCitation(src: CitationSource, opts: CitationOptions): string {
  let out: string;
  switch (opts.format) {
    case "inline":
      out = formatInline(src);
      break;
    case "footnote":
      out = formatFootnote(src);
      break;
    case "custom":
      out = renderTemplate(opts.template.trim() ? opts.template : DEFAULT_CUSTOM_TEMPLATE, templateVars(src));
      break;
    default:
      out = formatCallout(src);
  }
  return isBlockCitation(out) ? out.replace(/\n*$/, "\n") : out.trimEnd();
}

/** 여러 줄이거나 인용 블록(>)으로 시작하면 블록 — 커서가 줄 중간이면 새 줄에서 시작해야 한다 */
export function isBlockCitation(text: string): boolean {
  return text.trimEnd().includes("\n") || /^\s*>/.test(text);
}

/** 여러 인용을 한 번에 넣을 때 — 블록은 빈 줄 하나, 문장 안 형식은 문단으로 나눈다 */
export function joinCitations(parts: string[]): string {
  if (parts.length === 0) return "";
  if (parts.every(isBlockCitation)) return parts.join("\n");
  return parts.map((p) => p.trimEnd()).join("\n\n") + "\n";
}

function formatCallout(src: CitationSource): string {
  const title = src.title.trim() || "제목 없음";
  const author = src.author?.trim();
  const text = (src.text ?? "").trim();
  const note = (src.note ?? "").trim();
  const url = src.link?.trim() ?? "";

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

function formatInline(src: CitationSource): string {
  return `“${oneLine(src.text)}” (${citeParts(src)})`;
}

function formatFootnote(src: CitationSource): string {
  let body = `${citeParts(src)}.`;
  // 아티클 등은 원문 주소가 출처 구실을 한다. 책은 Readwise 주소를 각주에 넣지 않는다
  if (src.category !== "books" && src.sourceUrl) body += ` ${src.sourceUrl}`;
  // 각주 안의 대괄호는 ^[…]를 일찍 닫을 수 있어 전각으로 바꾼다 (예: "[한글더빙] …" 제목)
  body = body.replace(/\[/g, "［").replace(/\]/g, "］");
  return `“${oneLine(src.text)}”^[${body}]`;
}

/** "저자, 『책』, p. 12" — 책은 『』, 나머지(아티클·트윗 등)는 「」 */
function citeParts(src: CitationSource): string {
  const title = oneLine(src.title) || "제목 없음";
  const bracketed = src.category === "books" ? `『${title}』` : `「${title}」`;
  return [src.author?.trim(), bracketed, locationLabel(src)].filter(Boolean).join(", ");
}

/** 쪽수(page)와 킨들 위치(location)만 인용에 쓸 만하다. order·offset은 기기 내부 순번이라 뺀다 */
export function locationLabel(src: Pick<CitationSource, "location" | "locationType">): string {
  const loc = src.location;
  if (typeof loc !== "number" || !(loc > 0)) return "";
  if (src.locationType === "page") return `p. ${loc}`;
  if (src.locationType === "location") return `위치 ${loc}`;
  return "";
}

function oneLine(s: string | null | undefined): string {
  return (s ?? "").replace(/\s*\n+\s*/g, " ").trim();
}

const CATEGORY_LABELS: Record<string, string> = {
  books: "책",
  articles: "아티클",
  tweets: "트윗",
  podcasts: "팟캐스트",
  supplementals: "보조자료",
};

function templateVars(src: CitationSource): Record<string, string> {
  const title = src.title.trim() || "제목 없음";
  const date = src.highlightedAt ? src.highlightedAt.slice(0, 10) : "";
  return {
    text: (src.text ?? "").trim(),
    note: (src.note ?? "").trim(),
    title,
    book: title,
    author: src.author?.trim() ?? "",
    location: locationLabel(src),
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "",
    category: CATEGORY_LABELS[src.category ?? ""] ?? (src.category ?? ""),
    url: src.link?.trim() ?? "",
    source_url: src.sourceUrl?.trim() ?? "",
    readwise_url: src.readwiseUrl?.trim() ?? "",
    id: String(src.highlightId),
  };
}

/**
 * {{변수}} 치환 템플릿.
 * - {{#변수}}…{{/변수}}: 값이 있을 때만 안쪽을 넣는다 (여러 줄 가능)
 * - 여러 줄 값은 그 줄의 인용 접두어(">")를 다음 줄에도 붙인다 — 콜아웃이 끊기지 않게
 * - 변수가 들어 있는데 값이 모두 비어 있는 줄은 뺀다
 * - 연달아 남은 빈 줄·빈 인용 줄은 하나로 줄이고, 끝의 빈 줄은 지운다
 * - 모르는 변수는 글자 그대로 둔다
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  const sectioned = template.replace(
    /\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (_m, key: string, inner: string) => ((vars[key] ?? "").trim() ? inner : ""),
  );

  const kept: string[] = [];
  for (const line of sectioned.split("\n")) {
    const quotePrefix = line.match(/^\s*(?:>\s?)*/)?.[0] ?? "";
    const continuation = quotePrefix.includes(">") ? quotePrefix.replace(/>\s?$/, "> ") : "";
    let sawVar = false;
    let allEmpty = true;
    const replaced = line.replace(/\{\{(\w+)\}\}/g, (m, key: string) => {
      if (!(key in vars)) return m;
      sawVar = true;
      const value = vars[key] ?? "";
      if (value.trim()) allEmpty = false;
      return value.split("\n").join(`\n${continuation}`);
    });
    if (sawVar && allEmpty) continue;
    kept.push(replaced);
  }

  const isBlank = (l: string) => /^\s*(?:>\s*)*$/.test(l);
  const collapsed: string[] = [];
  for (const line of kept) {
    const prev = collapsed[collapsed.length - 1];
    if (prev !== undefined && isBlank(prev) && isBlank(line)) continue;
    collapsed.push(line);
  }
  while (collapsed.length > 0 && isBlank(collapsed[collapsed.length - 1])) collapsed.pop();
  return collapsed.join("\n");
}

/** 설정 미리보기용 예시 — 캐시가 비어 있을 때 쓴다 */
export const SAMPLE_SOURCE: CitationSource = {
  title: "예시 책 제목",
  author: "저자 이름",
  category: "books",
  text: "여기에 하이라이트 본문이 들어갑니다.",
  note: "Readwise에 남긴 메모",
  link: "https://readwise.io/bookreview/1",
  sourceUrl: "",
  readwiseUrl: "https://readwise.io/open/1",
  location: 42,
  locationType: "page",
  highlightedAt: "2026-11-12T09:00:00Z",
  highlightId: 1,
};
