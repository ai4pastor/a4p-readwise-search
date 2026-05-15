import { ReadwiseBook, ReadwiseHighlight } from "./types";

export interface SearchHit {
  highlight: ReadwiseHighlight;
  book: ReadwiseBook;
  score: number;
}

const MAX_RESULTS = 100;

export function searchHighlights(books: ReadwiseBook[], rawQuery: string): SearchHit[] {
  const query = rawQuery.trim();
  if (!query) return [];

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (terms.length === 0) return [];

  const hits: SearchHit[] = [];

  for (const book of books) {
    const bookTitle = (book.title ?? "").toLowerCase();
    const bookAuthor = (book.author ?? "").toLowerCase();
    const bookTags = book.book_tags?.map((t) => t.name.toLowerCase()).join(" ") ?? "";

    for (const h of book.highlights ?? []) {
      const text = (h.text ?? "").toLowerCase();
      const note = (h.note ?? "").toLowerCase();
      const tags = h.tags?.map((t) => t.name.toLowerCase()).join(" ") ?? "";

      const haystack = `${text}\n${note}\n${bookTitle}\n${bookAuthor}\n${tags}\n${bookTags}`;

      const allMatch = terms.every((t) => haystack.includes(t));
      if (!allMatch) continue;

      let score = 0;
      for (const t of terms) {
        if (text.includes(t)) score += 3;
        if (note.includes(t)) score += 2;
        if (bookTitle.includes(t)) score += 1;
        if (tags.includes(t) || bookTags.includes(t)) score += 1;
      }

      hits.push({ highlight: h, book, score });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, MAX_RESULTS);
}
