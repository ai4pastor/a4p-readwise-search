export interface ReadwiseHighlight {
  id: number;
  text: string;
  note: string;
  location: number;
  location_type: string;
  highlighted_at: string | null;
  url: string | null;
  color: string;
  updated: string;
  book_id: number;
  tags: ReadwiseTag[];
}

export interface ReadwiseTag {
  id: number;
  name: string;
}

export interface ReadwiseBook {
  user_book_id: number;
  title: string;
  author: string | null;
  readable_title: string;
  source: string;
  cover_image_url: string | null;
  unique_url: string | null;
  category: "books" | "articles" | "tweets" | "podcasts" | "supplementals";
  document_note: string | null;
  readwise_url: string;
  source_url: string | null;
  book_tags: ReadwiseTag[];
  highlights: ReadwiseHighlight[];
}

export interface CachedData {
  books: ReadwiseBook[];
}

export const EMPTY_CACHE: CachedData = { books: [] };

export interface DailyReviewHighlight {
  id: number;
  text: string;
  title: string;
  author: string | null;
  url: string | null;
  source_url: string | null;
  source_type: string;
  category: string;
  location_type: string;
  location: number | null;
  note: string;
  highlighted_at: string | null;
  highlight_url: string | null;
  image_url: string | null;
  api_source: string | null;
}

export interface DailyReview {
  review_id: number;
  review_url: string;
  review_completed: boolean;
  highlights: DailyReviewHighlight[];
}
