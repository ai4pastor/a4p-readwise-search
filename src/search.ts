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

export function searchHighlights(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters = {},
  sort: SortMode = "relevance",
): SearchHit[] {
  const query = rawQuery.trim();

  const terms = query
    ? query.toLowerCase().split(/\s+/).filter((t) => t.length > 0)
    : [];

  const hits: SearchHit[] = [];

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
      if (h.is_deleted) continue; // Readwise 삭제 톰스톤
      const hTagNames = (h.tags ?? []).map((t) => t.name);
      const allTagNames = [...hTagNames, ...bookTagNames];

      if (filters.tagNames && filters.tagNames.size > 0) {
        const match = allTagNames.some((n) => filters.tagNames!.has(n));
        if (!match) continue;
      }

      const text = (h.text ?? "").toLowerCase();
      const note = (h.note ?? "").toLowerCase();
      const tagsLower = hTagNames.join(" ").toLowerCase();

      if (terms.length > 0) {
        const haystack = `${text}\n${note}\n${bookTitle}\n${bookAuthor}\n${tagsLower}\n${bookTagsLower}`;
        const allMatch = terms.every((t) => haystack.includes(t));
        if (!allMatch) continue;
      }

      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += 3;
        if (note.includes(t)) score += 2;
        if (bookTitle.includes(t)) score += 1;
        if (bookAuthor.includes(t)) score += 1;
        if (tagsLower.includes(t) || bookTagsLower.includes(t)) score += 1;
      }

      hits.push({ highlight: h, book, score });
    }
  }

  applySort(hits, sort, terms.length > 0);
  return hits.slice(0, MAX_RESULTS);
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
