import { ActiveFilters, hasActiveFilters } from "./filters";
import { ReadwiseBook, ReadwiseHighlight } from "./types";

export interface SearchHit {
  highlight: ReadwiseHighlight;
  book: ReadwiseBook;
  score: number;
}

const MAX_RESULTS = 100;

export function searchHighlights(
  books: ReadwiseBook[],
  rawQuery: string,
  filters: ActiveFilters = {},
): SearchHit[] {
  const query = rawQuery.trim();
  const filtersActive = hasActiveFilters(filters);

  if (!query && !filtersActive) return [];

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
        if (tagsLower.includes(t) || bookTagsLower.includes(t)) score += 1;
      }

      hits.push({ highlight: h, book, score });
    }
  }

  if (terms.length > 0) {
    hits.sort((a, b) => b.score - a.score);
  } else {
    hits.sort((a, b) => (b.highlight.updated ?? "").localeCompare(a.highlight.updated ?? ""));
  }
  return hits.slice(0, MAX_RESULTS);
}
