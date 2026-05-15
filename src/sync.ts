import { Notice } from "obsidian";
import {
  ReadwiseApiError,
  ReadwiseAuthError,
  ReadwiseClient,
} from "./api";
import type ReadwiseSearchPlugin from "./main";
import { ReadwiseBook } from "./types";

export interface SyncResult {
  ok: boolean;
  books: number;
  highlights: number;
  message: string;
}

export class SyncService {
  private running = false;

  constructor(private plugin: ReadwiseSearchPlugin) {}

  isRunning(): boolean {
    return this.running;
  }

  async run(options: { full: boolean }): Promise<SyncResult> {
    if (this.running) {
      const msg = "이미 동기화가 진행 중입니다.";
      new Notice(msg);
      return { ok: false, books: 0, highlights: 0, message: msg };
    }

    const token = this.plugin.settings.apiToken;
    if (!token) {
      const msg = "Readwise 토큰이 설정되지 않았습니다. 설정 탭에서 입력해주세요.";
      new Notice(msg);
      return { ok: false, books: 0, highlights: 0, message: msg };
    }

    this.running = true;
    const client = new ReadwiseClient(token);
    const updatedAfter = options.full ? null : this.plugin.settings.lastSyncAt;
    const progressNotice = new Notice("Readwise 동기화 시작...", 0);

    try {
      const fetched = await client.exportAll(updatedAfter, (info) => {
        progressNotice.setMessage(
          `Readwise 동기화 중... ${info.pages}p · ${info.books}권 · ${info.highlights}건`,
        );
      });

      const merged = this.merge(this.plugin.cache.books, fetched, options.full);
      this.plugin.cache.books = merged;

      const highlightCount = merged.reduce(
        (sum, b) => sum + (b.highlights?.length ?? 0),
        0,
      );

      this.plugin.settings.lastSyncAt = new Date().toISOString();
      this.plugin.settings.bookCount = merged.length;
      this.plugin.settings.highlightCount = highlightCount;

      await this.plugin.persist();

      const msg = `Readwise 동기화 완료 · ${merged.length}권 · ${highlightCount}건`;
      progressNotice.hide();
      new Notice(msg);
      return { ok: true, books: merged.length, highlights: highlightCount, message: msg };
    } catch (e) {
      progressNotice.hide();
      const msg = this.formatError(e);
      new Notice(msg, 8000);
      return { ok: false, books: 0, highlights: 0, message: msg };
    } finally {
      this.running = false;
    }
  }

  private merge(existing: ReadwiseBook[], incoming: ReadwiseBook[], full: boolean): ReadwiseBook[] {
    if (full || existing.length === 0) return incoming;
    const byId = new Map(existing.map((b) => [b.user_book_id, b]));
    for (const book of incoming) byId.set(book.user_book_id, book);
    return Array.from(byId.values());
  }

  private formatError(e: unknown): string {
    if (e instanceof ReadwiseAuthError) return `인증 실패: ${e.message}`;
    if (e instanceof ReadwiseApiError) return `Readwise API 오류: ${e.message}`;
    if (e instanceof Error) return `동기화 실패: ${e.message}`;
    return "동기화 실패 (알 수 없는 오류)";
  }
}
