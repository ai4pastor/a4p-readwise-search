import { ActiveFilters } from "./filters";
import { ReadwiseBook, ReadwiseHighlight } from "./types";

export interface SearchHit {
  highlight: ReadwiseHighlight;
  book: ReadwiseBook;
  score: number;
}

export type SortMode = "relevance" | "recent" | "oldest" | "book";

/**
 * 카드 표시·시간순 정렬의 기준 시각.
 * highlighted_at(실제로 하이라이트한 시각) → created_at(Readwise 유입) → updated_at 폴백.
 * updated_at은 Readwise 공식 애플북스 앱이 DB를 재업로드할 때마다 옛 하이라이트에도 갱신되므로
 * "최근에 하이라이트한 것"의 기준으로 쓰면 옛 책이 "방금 전"으로 맨 위에 올라온다 (2026-09-05 확인).
 */
export function highlightTime(h: ReadwiseHighlight): string {
  return h.highlighted_at || h.created_at || h.updated_at || "";
}

const MAX_RESULTS = 100;

/** 검색 대상 필드 (소문자) */
interface HitFields {
  text: string;
  note: string;
  bookTitle: string;
  bookAuthor: string;
  tagsLower: string;
  bookTagsLower: string;
}

/** 책·카테고리·태그 필터와 톰스톤 규칙을 통과한 하이라이트마다 visit을 부른다 */
function forEachCandidate(
  books: ReadwiseBook[],
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
  visit: (h: ReadwiseHighlight, book: ReadwiseBook, f: HitFields) => void,
): void {
  for (const book of books) {
    if (filters.bookIds && filters.bookIds.size > 0 && !filters.bookIds.has(book.user_book_id)) {
      continue;
    }
    if (
      filters.categories &&
      filters.categories.size > 0 &&
      !filters.categories.has(book.category)
    ) {
      continue;
    }

    const bookTitle = (book.title ?? "").toLowerCase();
    const bookAuthor = (book.author ?? "").toLowerCase();
    const bookTagNames = (book.book_tags ?? []).map((t) => t.name);
    const bookTagsLower = bookTagNames.join(" ").toLowerCase();

    for (const h of book.highlights ?? []) {
      // Readwise에서 지운 하이라이트는 메모 노트를 만들어 둔 것만 보인다
      if (h.is_deleted && !hasNote?.(h.id)) continue;

      const hTagNames = (h.tags ?? []).map((t) => t.name);
      const allTagNames = [...hTagNames, ...bookTagNames];

      if (filters.tagNames && filters.tagNames.size > 0) {
        const match = allTagNames.some((n) => filters.tagNames!.has(n));
        if (!match) continue;
      }

      visit(h, book, {
        text: (h.text ?? "").toLowerCase(),
        note: (h.note ?? "").toLowerCase(),
        bookTitle,
        bookAuthor,
        tagsLower: hTagNames.join(" ").toLowerCase(),
        bookTagsLower,
      });
    }
  }
}

function haystackOf(f: HitFields): string {
  return `${f.text}\n${f.note}\n${f.bookTitle}\n${f.bookAuthor}\n${f.tagsLower}\n${f.bookTagsLower}`;
}

function scoreTerms(terms: string[], f: HitFields): number {
  let score = 0;
  for (const t of terms) {
    if (f.text.includes(t)) score += 3;
    if (f.note.includes(t)) score += 2;
    if (f.bookTitle.includes(t)) score += 1;
    if (f.bookAuthor.includes(t)) score += 1;
    if (f.tagsLower.includes(t) || f.bookTagsLower.includes(t)) score += 1;
  }
  return score;
}

/** 모든 낱말(terms)이 든 하이라이트 — 정렬·개수 제한 없음 */
function matchAll(
  books: ReadwiseBook[],
  terms: string[],
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
): SearchHit[] {
  const hits: SearchHit[] = [];
  forEachCandidate(books, filters, hasNote, (h, book, f) => {
    if (terms.length > 0) {
      const haystack = haystackOf(f);
      if (!terms.every((t) => haystack.includes(t))) return;
    }
    hits.push({ highlight: h, book, score: scoreTerms(terms, f) });
  });
  return hits;
}

export function searchHighlights(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters = {},
  sort: SortMode = "relevance",
  /** Readwise에서 지운 하이라이트(톰스톤)를 보여줄지 판정 — 메모 노트가 있으면 true */
  hasNote?: (highlightId: number) => boolean,
): SearchHit[] {
  const terms = splitQueryTerms(rawQuery.toLowerCase());
  const hits = matchAll(books, terms, filters, hasNote);
  applySort(hits, sort, terms.length > 0);
  return hits.slice(0, MAX_RESULTS);
}

/**
 * 검색어 끝의 조사·어미를 떼어 낸다 ("소망을" → "소망", "준비하는" → "준비").
 * 남는 글자가 2자 이상일 때만 떼고, 두 번까지 반복한다 ("말씀으로부터" → "말씀").
 * 뗀 낱말은 원래 낱말의 앞부분이라, 원래 낱말로 찾은 결과는 모두 그대로 찾힌다.
 */
const KOREAN_ENDINGS = [
  "하였던", "하였다", "되었던", "되었다", "스러운", "스럽게", "적으로", "이라는",
  "에서는", "에서도", "에게서", "으로서", "으로써", "으로는",
  "하기", "하는", "하고", "하며", "하면", "하여", "해서", "했던", "했다", "한다", "하다",
  "되는", "되지", "되기", "되어", "된다", "됐다", "이라", "라는", "이란", "이나", "이다",
  "들의", "들은", "들이", "들을", "들에", "에서", "에게", "께서", "으로", "부터", "까지",
  "처럼", "보다", "마저", "조차",
  "을", "를", "이", "가", "은", "는", "의", "에", "로", "와", "과", "도", "만", "란",
].sort((a, b) => b.length - a.length);

export function stripKoreanEnding(word: string): string {
  let w = word;
  for (let pass = 0; pass < 2; pass++) {
    if (!/[가-힣]$/.test(w)) break;
    const ending = KOREAN_ENDINGS.find((e) => w.endsWith(e) && w.length - e.length >= 2);
    if (!ending) break;
    w = w.slice(0, -ending.length);
  }
  return w;
}

/** 일부 일치 단계에서 버리는 흔한 낱말 (조사를 뗀 뒤 기준) */
const PARTIAL_STOPWORDS = new Set([
  "않는", "않은", "않고", "있는", "있다", "없는", "없다", "같은", "것처럼", "것은", "것이", "것을",
  "때문", "위해", "위해서", "통해", "통해서", "대한", "대해", "어떻게", "무엇", "그리고", "하지만",
  "그러나", "정말", "너무", "어떤", "모든", "우리", "나의", "내가", "당신", "그것", "이것", "여기",
  "거기", "가장", "매우", "항상", "다시", "함께", "속에서", "속에", "안에서", "안에", "가운데",
  "앞에서", "앞에", "방법", "이유", "생각", "정도", "부분", "경우", "자신",
]);

/** all = 모든 낱말 포함 · stem = 조사를 뗀 낱말로 모두 포함 · partial = 일부 낱말만 포함 */
export type MatchMode = "all" | "stem" | "partial";

export interface SearchOutcome {
  hits: SearchHit[];
  mode: MatchMode;
  /** 화면에서 강조할 낱말 (소문자) */
  terms: string[];
}

/**
 * 모든 낱말이 든 결과가 없을 때 차례로 넓혀 찾는다 (v0.3.0) — 정렬·개수 제한 없이 단계와 강조 낱말을 돌려준다.
 * 1) 지금까지와 같은 "모든 낱말 포함" → 2) 조사·어미를 뗀 낱말로 다시 → 3) 낱말 절반 이상이 맞는 결과.
 * 결과가 있으면 그 단계에서 멈추므로, 지금까지 찾히던 검색은 결과가 바뀌지 않는다.
 */
function runStages(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
): SearchOutcome {
  const terms = splitQueryTerms(rawQuery.toLowerCase());
  const exact = matchAll(books, terms, filters, hasNote);
  if (exact.length > 0 || terms.length === 0) return { hits: exact, mode: "all", terms };

  const stems = terms.map(stripKoreanEnding);
  if (stems.some((s, i) => s !== terms[i])) {
    const stemmed = matchAll(books, stems, filters, hasNote);
    if (stemmed.length > 0) return { hits: stemmed, mode: "stem", terms: stems };
  }

  const keys = Array.from(new Set(stems.filter((s) => s.length >= 2 && !PARTIAL_STOPWORDS.has(s))));
  if (keys.length < 2) return { hits: [], mode: "all", terms };
  const need = Math.max(1, Math.floor(keys.length / 2));
  const hits: SearchHit[] = [];
  forEachCandidate(books, filters, hasNote, (h, book, f) => {
    const haystack = haystackOf(f);
    const matched = keys.filter((k) => haystack.includes(k));
    if (matched.length < need) return;
    // 본문·메모에서 맞은 낱말 수가 먼저 (책 제목에서만 맞은 것은 뒤로), 같으면 지금까지의 관련도 점수
    const inContent = matched.filter((k) => f.text.includes(k) || f.note.includes(k)).length;
    hits.push({ highlight: h, book, score: inContent * 100 + scoreTerms(matched, f) });
  });
  return { hits, mode: "partial", terms: keys };
}

/** 사이드 패널용 — 단계별로 넓혀 찾고 정렬한 뒤 상위 100건 */
export function searchWithFallback(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters = {},
  sort: SortMode = "relevance",
  hasNote?: (highlightId: number) => boolean,
): SearchOutcome {
  const outcome = runStages(books, rawQuery, filters, hasNote);
  sortHits(outcome.hits, outcome.mode, sort, outcome.terms.length > 0);
  return { ...outcome, hits: outcome.hits.slice(0, MAX_RESULTS) };
}

/** 큰 검색 창용 — 필터·정렬·개수 제한 없이 검색어로만 찾는다 (필터 건수는 창이 이 결과로 센다) */
export function queryAll(
  books: ReadwiseBook[],
  rawQuery: string,
  hasNote?: (highlightId: number) => boolean,
): SearchOutcome {
  return runStages(books, rawQuery, {}, hasNote);
}

/** 일부 일치 결과는 맞은 낱말 수 순서가 의미라서 정렬 설정과 관계없이 관련도 순으로 둔다 */
export function sortHits(hits: SearchHit[], mode: MatchMode, sort: SortMode, hasQuery: boolean): void {
  applySort(hits, mode === "partial" ? "relevance" : sort, hasQuery);
}

function applySort(hits: SearchHit[], sort: SortMode, hasQuery: boolean) {
  // 최근 하이라이트 순 (ISO 8601 문자열 비교)
  const newestFirst = (a: SearchHit, b: SearchHit) =>
    highlightTime(b.highlight).localeCompare(highlightTime(a.highlight));

  if (sort === "relevance" && hasQuery) {
    // 점수 동점이면 최근 하이라이트 순 — 캐시 순서에 따른 임의 배열 방지
    hits.sort((a, b) => b.score - a.score || newestFirst(a, b));
    return;
  }
  if (sort === "recent" || (sort === "relevance" && !hasQuery)) {
    hits.sort(newestFirst);
    return;
  }
  if (sort === "oldest") {
    hits.sort((a, b) => highlightTime(a.highlight).localeCompare(highlightTime(b.highlight)));
    return;
  }
  if (sort === "book") {
    hits.sort((a, b) => {
      const t = (a.book.title ?? "").localeCompare(b.book.title ?? "", "ko");
      if (t !== 0) return t;
      const al = a.highlight.location ?? 0;
      const bl = b.highlight.location ?? 0;
      if (al !== bl) return al - bl;
      return newestFirst(a, b);
    });
    return;
  }
}

export function splitQueryTerms(rawQuery: string): string[] {
  return rawQuery
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
}
