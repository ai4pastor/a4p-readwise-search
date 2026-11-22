import { ActiveFilters } from "./filters";
import { qwertyToHangul } from "./korean";
import { ParsedQuery, parseQuery } from "./query";
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
  /** 하이라이트 태그 + 책 태그 (소문자) — 태그: 칸 검색용 */
  tagNames: string[];
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
        tagNames: allTagNames.map((n) => n.toLowerCase()),
      });
    }
  }
}

function haystackOf(f: HitFields): string {
  return `${f.text}\n${f.note}\n${f.bookTitle}\n${f.bookAuthor}\n${f.tagsLower}\n${f.bookTagsLower}`;
}

/** 한 하이라이트를 검사하는 데 필요한 것 */
interface Candidate {
  h: ReadwiseHighlight;
  book: ReadwiseBook;
  f: HitFields;
  haystack: string;
}

function termMatches(term: string, c: Candidate): boolean {
  return c.haystack.includes(term);
}

function fieldMatches(field: keyof ParsedQuery["fields"], value: string, c: Candidate): boolean {
  if (field === "tag") return c.f.tagNames.some((t) => t.includes(value));
  if (field === "book") return c.f.bookTitle.includes(value);
  if (field === "author") return c.f.bookAuthor.includes(value);
  return c.f.note.includes(value);
}

/** 칸 지정(책:·저자:·태그:·메모:)과 빼기(-)는 어느 단계에서든 지킨다 */
function passesQuery(q: ParsedQuery, c: Candidate): boolean {
  for (const field of Object.keys(q.fields) as Array<keyof ParsedQuery["fields"]>) {
    if (!q.fields[field].every((v) => fieldMatches(field, v, c))) return false;
    if (q.excludeFields[field].some((v) => fieldMatches(field, v, c))) return false;
  }
  return !q.excludes.some((v) => termMatches(v, c));
}

function scoreTerms(terms: string[], c: Candidate): number {
  const f = c.f;
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

/** 검색 문법을 지키는 후보마다 visit을 부른다 */
function forEachMatchingCandidate(
  books: ReadwiseBook[],
  q: ParsedQuery,
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
  visit: (c: Candidate) => void,
): void {
  forEachCandidate(books, filters, hasNote, (h, book, f) => {
    const c: Candidate = { h, book, f, haystack: haystackOf(f) };
    if (passesQuery(q, c)) visit(c);
  });
}

/** 모든 낱말(terms)이 든 하이라이트 — 정렬·개수 제한 없음 */
function matchAll(
  books: ReadwiseBook[],
  terms: string[],
  q: ParsedQuery,
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
): SearchHit[] {
  const hits: SearchHit[] = [];
  forEachMatchingCandidate(books, q, filters, hasNote, (c) => {
    if (!terms.every((t) => termMatches(t, c))) return;
    hits.push({ highlight: c.h, book: c.book, score: scoreTerms(terms, c) });
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
  const q = parseQuery(rawQuery);
  const hits = matchAll(books, q.terms, q, filters, hasNote);
  applySort(hits, sort, q.terms.length > 0);
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

/** all = 모든 낱말 포함 · qwerty = 영문 자판으로 친 것을 한글로 바꿔 찾음 · stem = 조사를 뗀 낱말 · partial = 일부 낱말만 */
export type MatchMode = "all" | "qwerty" | "stem" | "partial";

export interface SearchOutcome {
  hits: SearchHit[];
  mode: MatchMode;
  /** 화면에서 강조할 낱말 (소문자) — 칸 지정(책:·태그: 등) 값 포함 */
  terms: string[];
  /** 해석한 검색 문법 — 상태줄 설명용 */
  query: ParsedQuery;
  /** 영문 자판 복원으로 바꾼 낱말 (qwerty 단계) */
  converted: Array<{ from: string; to: string }>;
}

/** 본문·메모에서 맞았는지 (일부 일치 순위: 책 제목에서만 맞은 것은 뒤로) */
function contentMatches(term: string, c: Candidate): boolean {
  return c.f.text.includes(term) || c.f.note.includes(term);
}

/**
 * 모든 낱말이 든 결과가 없을 때 차례로 넓혀 찾는다 — 정렬·개수 제한 없이 단계와 강조 낱말을 돌려준다.
 * 1) 모든 낱말 포함 (지금까지와 같음) → 2) 영문 자판으로 친 낱말을 한글로 (v0.4.0, "rleh" → "기도")
 * → 3) 조사·어미 떼기 (v0.3.0) → 4) 낱말 절반 이상이 맞는 결과.
 * 칸 지정·빼기는 모든 단계에서 지킨다. 결과가 있으면 그 단계에서 멈추므로, 지금까지 찾히던 검색은 결과가 바뀌지 않는다.
 */
function runStages(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters,
  hasNote: ((highlightId: number) => boolean) | undefined,
): SearchOutcome {
  const q = parseQuery(rawQuery);
  const fieldTerms = [...q.fields.book, ...q.fields.author, ...q.fields.tag, ...q.fields.note];
  const done = (
    hits: SearchHit[],
    mode: MatchMode,
    terms: string[],
    converted: Array<{ from: string; to: string }> = [],
  ): SearchOutcome => ({ hits, mode, terms: [...terms, ...fieldTerms], query: q, converted });

  const terms = q.terms;
  const exact = matchAll(books, terms, q, filters, hasNote);
  if (exact.length > 0 || terms.length === 0) return done(exact, "all", terms);

  // 한영 전환을 잊고 친 낱말 — 영문만으로 된 낱말이 두 음절 이상 온전한 한글이 될 때만 바꾼다
  const converted: Array<{ from: string; to: string }> = [];
  const hangulTerms = terms.map((t, i) => {
    const raw = q.termsRaw[i] ?? t;
    const hangul = qwertyToHangul(raw);
    if (hangul && hangul.length >= 2) {
      converted.push({ from: raw, to: hangul });
      return hangul;
    }
    return t;
  });
  if (converted.length > 0) {
    const hits = matchAll(books, hangulTerms, q, filters, hasNote);
    if (hits.length > 0) return done(hits, "qwerty", hangulTerms, converted);
  }

  // 따옴표 구절은 조사를 떼지 않는다
  const stems = terms.map((t) => (t.includes(" ") ? t : stripKoreanEnding(t)));
  if (stems.some((s, i) => s !== terms[i])) {
    const stemmed = matchAll(books, stems, q, filters, hasNote);
    if (stemmed.length > 0) return done(stemmed, "stem", stems);
  }

  const keys = Array.from(new Set(stems.filter((s) => s.length >= 2 && !PARTIAL_STOPWORDS.has(s))));
  if (keys.length < 2) return done([], "all", terms);
  const need = Math.max(1, Math.floor(keys.length / 2));
  const hits: SearchHit[] = [];
  forEachMatchingCandidate(books, q, filters, hasNote, (c) => {
    const matched = keys.filter((k) => termMatches(k, c));
    if (matched.length < need) return;
    // 본문·메모에서 맞은 낱말 수가 먼저, 같으면 지금까지의 관련도 점수
    const inContent = matched.filter((k) => contentMatches(k, c)).length;
    hits.push({ highlight: c.h, book: c.book, score: inContent * 100 + scoreTerms(matched, c) });
  });
  return done(hits, "partial", keys);
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
