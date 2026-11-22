import { PARTIAL_STOPWORDS, SearchHit, stripKoreanEnding } from "./search";
import { isVisible } from "./library";
import type { ReadwiseBook } from "./types";

/**
 * 지금 쓰는 노트와 닿는 밑줄 (v0.5.0). obsidian을 import하지 않는다 — 노드에서 바로 시험할 수 있게.
 * 노트의 제목·소제목·태그에서 낱말을 뽑고, 그 낱말이 든 밑줄을 "드문 낱말일수록 높게" 점수 매긴다.
 * 뜻이 비슷한 다른 낱말까지 찾는 의미 검색은 아니다 (CLAUDE.md "의미 검색 — 보류").
 */

export interface NoteSignals {
  title: string;
  headings: string[];
  tags: string[];
  aliases?: string[];
}

export interface NoteTerm {
  term: string;
  /** 어디서 나온 낱말인지에 따른 무게 — 제목 3 · 태그 2.5 · 소제목·별칭 2 */
  weight: number;
}

/** 노트 틀에서 흔히 쓰는 소제목 낱말 — 주제가 아니라 구조라서 뺀다 */
const STRUCTURE_WORDS = new Set([
  "서론", "본론", "결론", "정리", "요약", "출처", "참고", "메모", "노트", "초안", "개요", "목차",
  "도입", "마무리", "적용", "예화", "질문", "나눔", "기도", "제목", "주제", "내용", "대지", "소지",
  "readwise", "untitled", "무제", "daily", "note", "notes", "todo",
  // 조사·어미를 떼고 남는, 뜻이 옅은 낱말
  "사이", "대하", "대한", "위한", "통한", "관한", "따른", "향한", "대해", "관해", "어떻", "그리", "이런", "그런",
  "중의", "중에", "속의", "안의", "위의", "앞의", "뒤의", "때의", "것의", "나의", "너의", "우리의",
]);

const MAX_TERMS = 14;

function tokens(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!raw || /^\d+$/.test(raw)) continue;
    const t = stripKoreanEnding(raw);
    if (t.length < 2) continue;
    // 영문·숫자만으로 된 두 글자(rw, v2 같은 파일 이름 조각)는 낱말로 보지 않는다
    if (t.length < 3 && /^[a-z0-9]+$/.test(t)) continue;
    if (PARTIAL_STOPWORDS.has(t) || STRUCTURE_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/** 노트의 제목·소제목·태그에서 찾을 낱말을 뽑는다 (무게 큰 순, 최대 14개) */
export function extractTerms(sig: NoteSignals, max = MAX_TERMS): NoteTerm[] {
  const weights = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of tokens(text)) weights.set(t, Math.max(weights.get(t) ?? 0, weight));
  };
  add(sig.title, 3);
  for (const tag of sig.tags) add(tag.replace(/^#/, ""), 2.5);
  for (const alias of sig.aliases ?? []) add(alias, 2);
  for (const heading of sig.headings) add(heading, 2);
  return Array.from(weights.entries())
    .map(([term, weight]) => ({ term, weight }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, max);
}

export interface RelatedHit extends SearchHit {
  /** 본문·메모에서 맞은 낱말 */
  matched: string[];
}

export interface RelatedOutcome {
  hits: RelatedHit[];
  /** 실제로 찾는 데 쓴 낱말 (서재에 있는 것) — 무게 큰 순 */
  used: string[];
  /** 서재 어디에도 없어 못 쓴 낱말 */
  missing: string[];
  /** 너무 흔해서 뺀 낱말 (서재 밑줄 다섯 중 하나 넘게 나옴) */
  common: string[];
}

/** 이 비율보다 많은 밑줄에 나오는 낱말은 가려내는 힘이 없어 뺀다 */
const COMMON_RATIO = 0.2;

export function findRelated(
  books: ReadwiseBook[],
  terms: NoteTerm[],
  hasNote?: (highlightId: number) => boolean,
  opts: { excludeHighlightId?: number | null; skip?: ReadonlySet<string>; limit?: number } = {},
): RelatedOutcome {
  const active = terms.filter((t) => !opts.skip?.has(t.term));
  const empty: RelatedOutcome = { hits: [], used: [], missing: [], common: [] };
  if (active.length === 0) return empty;

  interface Row {
    hit: SearchHit;
    content: string;
    meta: string;
  }
  const rows: Row[] = [];
  for (const book of books) {
    const meta = [
      book.title ?? "",
      book.author ?? "",
      ...(book.book_tags ?? []).map((t) => t.name),
    ].join("\n").toLowerCase();
    for (const h of book.highlights ?? []) {
      if (!isVisible(h, hasNote) || h.id === opts.excludeHighlightId) continue;
      rows.push({
        hit: { highlight: h, book, score: 0 },
        content: `${h.text ?? ""}\n${h.note ?? ""}`.toLowerCase(),
        meta: `${meta}\n${(h.tags ?? []).map((t) => t.name).join("\n").toLowerCase()}`,
      });
    }
  }
  if (rows.length === 0) return empty;

  // 낱말마다 몇 개의 밑줄에 나오는지 — 드문 낱말일수록 무게가 크다
  const df = new Map<string, number>();
  for (const { term } of active) {
    let n = 0;
    for (const r of rows) if (r.content.includes(term) || r.meta.includes(term)) n++;
    df.set(term, n);
  }
  const missing = active.filter((t) => (df.get(t.term) ?? 0) === 0).map((t) => t.term);
  let usable = active.filter((t) => (df.get(t.term) ?? 0) > 0);
  let common: string[] = [];
  if (rows.length >= 50) {
    const rare = usable.filter((t) => (df.get(t.term) ?? 0) / rows.length <= COMMON_RATIO);
    // 모두 흔한 낱말뿐이면 그중 가장 드문 둘은 남긴다
    if (rare.length > 0) {
      common = usable.filter((t) => !rare.includes(t)).map((t) => t.term);
      usable = rare;
    } else {
      const sorted = [...usable].sort((a, b) => (df.get(a.term) ?? 0) - (df.get(b.term) ?? 0));
      usable = sorted.slice(0, 2);
      common = sorted.slice(2).map((t) => t.term);
    }
  }
  if (usable.length === 0) return { hits: [], used: [], missing, common };

  const idf = new Map<string, number>();
  for (const t of usable) idf.set(t.term, Math.log(1 + rows.length / (df.get(t.term) ?? 1)));

  const hits: RelatedHit[] = [];
  for (const r of rows) {
    let score = 0;
    const matched: string[] = [];
    for (const t of usable) {
      const w = t.weight * (idf.get(t.term) ?? 0);
      if (r.content.includes(t.term)) {
        score += w;
        matched.push(t.term);
      } else if (r.meta.includes(t.term)) {
        // 책 제목·저자·태그에서만 맞은 것은 약하게 (책 한 권이 통째로 올라오지 않게)
        score += w * 0.3;
      }
    }
    if (score > 0) hits.push({ ...r.hit, score: matched.length * 1000 + score, matched });
  }
  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, opts.limit ?? 40), used: usable.map((t) => t.term), missing, common };
}
