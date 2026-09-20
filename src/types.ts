export interface ReadwiseHighlight {
  id: number;
  text: string;
  note: string;
  location: number;
  location_type: string;
  highlighted_at: string | null;
  url: string | null;
  color: string;
  updated_at: string;
  book_id: number;
  tags: ReadwiseTag[];
  /** Readwise에 처음 들어온 시각 — highlighted_at이 비어 있을 때 폴백 */
  created_at?: string | null;
  /**
   * Readwise에서 지운 하이라이트(톰스톤). 동기화 시 메모 노트가 있는 것만 캐시에 남고,
   * 카드도 노트가 있을 때만 보인다 (src/sync.ts prune, src/search.ts)
   */
  is_deleted?: boolean;
  is_discard?: boolean;
  is_favorite?: boolean;
  readwise_url?: string;
  external_id?: string | null;
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
  /** Readwise에서 책째 삭제됨 — 동기화 시 소속 하이라이트를 모두 톰스톤으로 정규화 */
  is_deleted?: boolean;
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
