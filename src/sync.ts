import { Notice } from "obsidian";
import {
  ReadwiseApiError,
  ReadwiseAuthError,
  ReadwiseClient,
} from "./api";
import type ReadwiseSearchPlugin from "./main";
import { ReadwiseBook } from "./types";

/**
 * 캐시 형식 버전. settings.cacheVersion이 이보다 낮으면 다음 동기화를 한 번 전체로 강제한다.
 * 1 (v0.2.4): includeDeleted 톰스톤 도입 — 그 전 캐시에는 Readwise에서 지운 항목이 그대로 남아 있다.
 */
export const CACHE_VERSION = 1;

export interface SyncResult {
  ok: boolean;
  books: number;
  highlights: number;
  /** 이번 동기화로 목록에서 빠진(Readwise에서 지워진) 하이라이트 수 */
  deleted: number;
  /** 이번 동기화로 새로 생긴 하이라이트 수 (자동 동기화 알림 기준) */
  added: number;
  message: string;
}

export class SyncService {
  private running = false;
  /** 자동 동기화에서 마지막으로 알린 오류 — 같은 오류를 반복해서 띄우지 않기 위해 */
  private lastQuietError = "";

  constructor(private plugin: ReadwiseSearchPlugin) {}

  isRunning(): boolean {
    return this.running;
  }

  /**
   * quiet = 자동 동기화(v0.3.1): 진행 알림 없이 돌고, 새 하이라이트·삭제 반영이 있을 때만 알린다.
   * 오류는 인증 실패만 알리고(같은 내용은 한 번만), 네트워크 오류 등은 콘솔에만 남긴다.
   */
  async run(options: { full: boolean; quiet?: boolean }): Promise<SyncResult> {
    const quiet = options.quiet === true;
    if (this.running) {
      const msg = "이미 동기화가 진행 중입니다.";
      if (!quiet) new Notice(msg);
      return fail(msg);
    }

    const token = this.plugin.getToken();
    if (!token) {
      const msg = this.plugin.tokenMissingMessage();
      if (!quiet) new Notice(msg, 8000);
      return fail(msg);
    }

    // 톰스톤 없이 만들어진 옛 캐시는 한 번 전체로 받아야 Readwise에서 지운 항목이 정리된다
    const needsUpgrade = this.plugin.settings.cacheVersion < CACHE_VERSION;
    const full = options.full || needsUpgrade;
    if (needsUpgrade && !options.full && this.plugin.cache.books.length > 0 && !quiet) {
      new Notice("삭제 반영을 위해 이번 한 번은 전체 동기화합니다.", 6000);
    }

    this.running = true;
    const client = new ReadwiseClient(token);
    const updatedAfter = full ? null : this.plugin.settings.lastSyncAt;
    const progressNotice = quiet ? null : new Notice("Readwise 동기화 시작...", 0);

    try {
      const fetched = await client.exportAll(updatedAfter, (info) => {
        progressNotice?.setMessage(
          `Readwise 동기화 중... ${info.pages}p · ${info.books}권 · ${info.highlights}건`,
        );
      });

      const before = this.plugin.cache.books;
      const merged = this.prune(this.merge(before, fetched, full));
      const deleted = countNewlyDeleted(before, merged);
      const added = countNewlyAdded(before, merged);
      this.plugin.cache.books = merged;

      const highlightCount = countAlive(merged);

      this.plugin.settings.lastSyncAt = new Date().toISOString();
      this.plugin.settings.bookCount = merged.length;
      this.plugin.settings.highlightCount = highlightCount;
      this.plugin.settings.cacheVersion = CACHE_VERSION;

      await this.plugin.persist();

      let msg = `Readwise 동기화 완료 · ${merged.length}권 · ${highlightCount}건`;
      if (deleted > 0) msg += ` · 삭제 반영 ${deleted}건`;
      progressNotice?.hide();
      if (!quiet) {
        new Notice(msg);
      } else if (added > 0 || deleted > 0) {
        const parts: string[] = [];
        if (added > 0) parts.push(`새 하이라이트 ${added}건`);
        if (deleted > 0) parts.push(`삭제 반영 ${deleted}건`);
        new Notice(`Readwise 자동 동기화 · ${parts.join(" · ")}`);
      }
      this.lastQuietError = "";
      return { ok: true, books: merged.length, highlights: highlightCount, deleted, added, message: msg };
    } catch (e) {
      progressNotice?.hide();
      const msg = this.formatError(e);
      if (!quiet) {
        new Notice(msg, 8000);
      } else if (e instanceof ReadwiseAuthError && msg !== this.lastQuietError) {
        // 자동 동기화에서는 토큰 문제만 알린다 — 같은 알림을 매시간 반복하지 않게 한 번만
        new Notice(`Readwise 자동 동기화 · ${msg}`, 8000);
        this.lastQuietError = msg;
      } else {
        console.warn("[A4P Readwise] 자동 동기화 실패:", msg);
      }
      return fail(msg);
    } finally {
      this.running = false;
    }
  }

  /**
   * 하이라이트 id 단위 upsert. `updatedAfter` 응답은 대체로 책의 전체 하이라이트를 담지만,
   * 삭제만 일어난 책은 톰스톤만 오고 살아있는 하이라이트가 빠질 수 있다(2026-09-20 실측).
   * 책을 통째로 바꾸면 그 하이라이트를 잃으므로, 안 온 것은 그대로 두고 온 것만 덮어쓴다.
   * 삭제는 includeDeleted 톰스톤으로 오므로 통째 교체 없이도 반영된다.
   */
  private merge(existing: ReadwiseBook[], incoming: ReadwiseBook[], full: boolean): ReadwiseBook[] {
    if (full || existing.length === 0) return incoming;
    const byId = new Map(existing.map((b) => [b.user_book_id, b]));
    for (const book of incoming) {
      const prev = byId.get(book.user_book_id);
      if (!prev) {
        byId.set(book.user_book_id, book);
        continue;
      }
      const highlights = new Map((prev.highlights ?? []).map((h) => [h.id, h]));
      for (const h of book.highlights ?? []) highlights.set(h.id, h);
      byId.set(book.user_book_id, { ...book, highlights: Array.from(highlights.values()) });
    }
    return Array.from(byId.values());
  }

  /**
   * 톰스톤 정리. 책째 삭제(book.is_deleted)는 하이라이트마다 is_deleted로 정규화하고,
   * 메모 노트가 없는 톰스톤은 캐시에서 버린다(data.json 비대 방지). 노트가 있는 톰스톤은
   * 카드로 계속 보여야 하므로 남긴다. 하이라이트가 하나도 안 남은 책은 책 필터 목록에서 빠지도록 뺀다.
   * 노트 인덱스가 아직 준비 전이면(옵시디언 시작 직후) 잘못 버리지 않도록 이번엔 모두 남긴다.
   */
  private prune(books: ReadwiseBook[]): ReadwiseBook[] {
    const index = this.plugin.noteIndex;
    const keepAll = !index.isReady();
    const result: ReadwiseBook[] = [];
    for (const book of books) {
      const highlights = (book.highlights ?? [])
        .map((h) => (book.is_deleted && !h.is_deleted ? { ...h, is_deleted: true } : h))
        .filter((h) => !h.is_deleted || keepAll || index.has(h.id));
      if (highlights.length === 0) continue;
      result.push({ ...book, highlights });
    }
    return result;
  }

  private formatError(e: unknown): string {
    if (e instanceof ReadwiseAuthError) return `인증 실패: ${e.message}`;
    if (e instanceof ReadwiseApiError) return `Readwise API 오류: ${e.message}`;
    if (e instanceof Error) return `동기화 실패: ${e.message}`;
    return "동기화 실패 (알 수 없는 오류)";
  }
}

function fail(message: string): SyncResult {
  return { ok: false, books: 0, highlights: 0, deleted: 0, added: 0, message };
}

/** 직전 캐시에 없었는데 이번 결과에서 살아 있는 하이라이트 수 */
function countNewlyAdded(before: ReadwiseBook[], after: ReadwiseBook[]): number {
  const known = new Set<number>();
  for (const b of before) for (const h of b.highlights ?? []) known.add(h.id);
  let n = 0;
  for (const b of after) for (const h of b.highlights ?? []) if (!h.is_deleted && !known.has(h.id)) n += 1;
  return n;
}

/** 살아있는(톰스톤 아닌) 하이라이트 수 — 설정 탭 상태·완료 Notice 기준 */
function countAlive(books: ReadwiseBook[]): number {
  let n = 0;
  for (const b of books) for (const h of b.highlights ?? []) if (!h.is_deleted) n += 1;
  return n;
}

/** 직전 캐시에서 살아 있었는데 이번 결과에서 사라졌거나 톰스톤이 된 하이라이트 수 */
function countNewlyDeleted(before: ReadwiseBook[], after: ReadwiseBook[]): number {
  const aliveAfter = new Set<number>();
  for (const b of after) for (const h of b.highlights ?? []) if (!h.is_deleted) aliveAfter.add(h.id);
  let n = 0;
  for (const b of before) {
    for (const h of b.highlights ?? []) if (!h.is_deleted && !aliveAfter.has(h.id)) n += 1;
  }
  return n;
}
