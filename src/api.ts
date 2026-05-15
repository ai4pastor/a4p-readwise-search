import { requestUrl, RequestUrlResponse } from "obsidian";
import { DailyReview, ReadwiseBook } from "./types";

const BASE_URL = "https://readwise.io/api/v2";

export class ReadwiseAuthError extends Error {}
export class ReadwiseRateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`Readwise API rate limit (재시도까지 ${retryAfterSec}s)`);
  }
}
export class ReadwiseApiError extends Error {}

export type ProgressCallback = (info: {
  pages: number;
  books: number;
  highlights: number;
}) => void;

export class ReadwiseClient {
  constructor(private token: string) {}

  private headers() {
    return { Authorization: `Token ${this.token}` };
  }

  async verifyToken(): Promise<boolean> {
    if (!this.token) {
      throw new ReadwiseAuthError("토큰이 비어 있습니다. 설정에서 입력해주세요.");
    }
    const res = await this.request(`${BASE_URL}/auth/`, "GET");
    if (res.status === 204) return true;
    if (res.status === 401) {
      throw new ReadwiseAuthError("토큰이 올바르지 않습니다.");
    }
    throw new ReadwiseApiError(`예상치 못한 응답: ${res.status}`);
  }

  async exportAll(
    updatedAfter: string | null,
    onProgress?: ProgressCallback,
  ): Promise<ReadwiseBook[]> {
    const collected: ReadwiseBook[] = [];
    let pageCursor: string | null = null;
    let pages = 0;
    let highlightCount = 0;

    while (true) {
      const url = new URL(`${BASE_URL}/export/`);
      if (updatedAfter) url.searchParams.set("updatedAfter", updatedAfter);
      if (pageCursor) url.searchParams.set("pageCursor", pageCursor);

      const res = await this.request(url.toString(), "GET");

      if (res.status === 429) {
        const retryAfter = parseInt(res.headers["retry-after"] ?? "60", 10);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 401) {
        throw new ReadwiseAuthError("토큰이 올바르지 않습니다.");
      }
      if (res.status < 200 || res.status >= 300) {
        throw new ReadwiseApiError(
          `Readwise API 오류 (${res.status}): ${res.text?.slice(0, 200) ?? ""}`,
        );
      }

      const data = res.json as { results: ReadwiseBook[]; nextPageCursor: string | null };
      collected.push(...data.results);
      pages += 1;
      highlightCount += data.results.reduce(
        (sum, book) => sum + (book.highlights?.length ?? 0),
        0,
      );

      onProgress?.({ pages, books: collected.length, highlights: highlightCount });

      if (!data.nextPageCursor) break;
      pageCursor = data.nextPageCursor;
    }

    return collected;
  }

  async getDailyReview(): Promise<DailyReview> {
    if (!this.token) {
      throw new ReadwiseAuthError("토큰이 설정되지 않았습니다.");
    }
    const res = await this.request(`${BASE_URL}/review/`, "GET");
    if (res.status === 401) {
      throw new ReadwiseAuthError("토큰이 올바르지 않습니다.");
    }
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers["retry-after"] ?? "60", 10);
      throw new ReadwiseRateLimitError(retryAfter);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new ReadwiseApiError(
        `Daily Review 가져오기 실패 (${res.status}): ${res.text?.slice(0, 200) ?? ""}`,
      );
    }
    return res.json as DailyReview;
  }

  private async request(url: string, method: "GET"): Promise<RequestUrlResponse> {
    return requestUrl({
      url,
      method,
      headers: this.headers(),
      throw: false,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
