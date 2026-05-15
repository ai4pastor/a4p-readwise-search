import { ReadwiseBook } from "./types";

export interface BookOption {
  id: number;
  label: string;
}

export interface TagOption {
  name: string;
  count: number;
}

export interface FilterOptions {
  books: BookOption[];
  tags: TagOption[];
  categories: string[];
}

export interface ActiveFilters {
  bookIds?: Set<number>;
  tagNames?: Set<string>;
  categories?: Set<string>;
}

export function collectFilterOptions(books: ReadwiseBook[]): FilterOptions {
  const bookOpts: BookOption[] = books.map((b) => ({
    id: b.user_book_id,
    label: b.author ? `${b.title} — ${b.author}` : b.title || "제목 없음",
  }));
  bookOpts.sort((a, b) => a.label.localeCompare(b.label, "ko"));

  const tagCounts = new Map<string, number>();
  const categories = new Set<string>();

  for (const book of books) {
    if (book.category) categories.add(book.category);
    for (const t of book.book_tags ?? []) {
      tagCounts.set(t.name, (tagCounts.get(t.name) ?? 0) + 1);
    }
    for (const h of book.highlights ?? []) {
      for (const t of h.tags ?? []) {
        tagCounts.set(t.name, (tagCounts.get(t.name) ?? 0) + 1);
      }
    }
  }

  const tags: TagOption[] = Array.from(tagCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));

  return {
    books: bookOpts,
    tags,
    categories: Array.from(categories).sort(),
  };
}

export function hasActiveFilters(f: ActiveFilters): boolean {
  return (
    (f.bookIds?.size ?? 0) > 0 ||
    (f.tagNames?.size ?? 0) > 0 ||
    (f.categories?.size ?? 0) > 0
  );
}
