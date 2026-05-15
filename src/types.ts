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
