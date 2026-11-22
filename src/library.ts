import { highlightTime, SearchHit } from "./search";
import type { ReadwiseBook, ReadwiseHighlight } from "./types";

/**
 * 서재 홈·읽기 달력용 집계 (v0.5.0). obsidian을 import하지 않는다 — 노드에서 바로 시험할 수 있게.
 * 날짜는 모두 이 기기의 시간대 기준 (밤 11시에 친 밑줄이 다음 날로 넘어가지 않게).
 */

type HasNote = (highlightId: number) => boolean;

/** ISO 시각 → 이 기기 시간대의 "YYYY-MM-DD" (알 수 없으면 "") */
export function dayKey(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return localKey(d);
}

export function localKey(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

/** 목록에 보이는 하이라이트인지 — Readwise에서 지운 것은 메모 노트가 있을 때만 */
export function isVisible(h: ReadwiseHighlight, hasNote?: HasNote): boolean {
  return !h.is_deleted || !!hasNote?.(h.id);
}

export interface LibraryStats {
  total: number;
  bookCount: number;
  /** "YYYY-MM-DD" → 그날 밑줄 수 */
  byDay: Map<string, number>;
}

export function collectStats(books: ReadwiseBook[], hasNote?: HasNote): LibraryStats {
  const byDay = new Map<string, number>();
  let total = 0;
  let bookCount = 0;
  for (const book of books) {
    let any = false;
    for (const h of book.highlights ?? []) {
      if (!isVisible(h, hasNote)) continue;
      any = true;
      total++;
      const key = dayKey(highlightTime(h));
      if (key) byDay.set(key, (byDay.get(key) ?? 0) + 1);
    }
    if (any) bookCount++;
  }
  return { total, bookCount, byDay };
}

export interface MonthCount {
  /** "YYYY-MM" */
  key: string;
  year: number;
  month: number;
  count: number;
}

/** 이번 달까지 최근 n달의 밑줄 수 (오래된 달 → 이번 달) */
export function monthCounts(byDay: Map<string, number>, n: number, now = new Date()): MonthCount[] {
  const sums = new Map<string, number>();
  for (const [day, count] of byDay) {
    const key = day.slice(0, 7);
    sums.set(key, (sums.get(key) ?? 0) + count);
  }
  const out: MonthCount[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ key, year: d.getFullYear(), month: d.getMonth() + 1, count: sums.get(key) ?? 0 });
  }
  return out;
}

export interface CalendarDay {
  key: string;
  count: number;
  /** 오늘보다 뒤의 칸 (마지막 주의 남은 요일) */
  future: boolean;
}

/** 읽기 달력 — 이번 주까지 최근 n주, 주마다 일요일~토요일 7칸 */
export function calendarWeeks(byDay: Map<string, number>, weeks: number, now = new Date()): CalendarDay[][] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
  const out: CalendarDay[][] = [];
  for (let w = 0; w < weeks; w++) {
    const week: CalendarDay[] = [];
    for (let d = 0; d < 7; d++) {
      const day = new Date(start);
      day.setDate(start.getDate() + w * 7 + d);
      const key = localKey(day);
      week.push({ key, count: byDay.get(key) ?? 0, future: day.getTime() > today.getTime() });
    }
    out.push(week);
  }
  return out;
}

/** 달력 칸의 진하기 0~3 — 그 기간에서 가장 많이 친 날을 기준으로 */
export function heatLevel(count: number, max: number): 0 | 1 | 2 | 3 {
  if (count <= 0 || max <= 0) return 0;
  const r = count / max;
  if (r > 0.66) return 3;
  if (r > 0.33) return 2;
  return 1;
}

/** 가장 최근에 밑줄 친 책·글 n개 (최근 밑줄 순) */
export function recentBooks(books: ReadwiseBook[], n: number, hasNote?: HasNote): ReadwiseBook[] {
  const latest: Array<{ book: ReadwiseBook; at: string }> = [];
  for (const book of books) {
    let at = "";
    for (const h of book.highlights ?? []) {
      if (!isVisible(h, hasNote)) continue;
      const t = highlightTime(h);
      if (t > at) at = t;
    }
    if (at) latest.push({ book, at });
  }
  latest.sort((a, b) => b.at.localeCompare(a.at));
  return latest.slice(0, n).map((e) => e.book);
}

/**
 * 다시 만날 밑줄 하나를 무작위로 고른다.
 * 너무 짧은 것(낱말 몇 개)과 너무 긴 것(전사 덩어리)은 피하고, 없으면 아무거나.
 */
export function pickRandomHit(
  books: ReadwiseBook[],
  hasNote?: HasNote,
  random: () => number = Math.random,
  excludeId?: number,
): SearchHit | null {
  const good: SearchHit[] = [];
  const rest: SearchHit[] = [];
  for (const book of books) {
    for (const h of book.highlights ?? []) {
      if (!isVisible(h, hasNote) || h.id === excludeId) continue;
      const len = (h.text ?? "").trim().length;
      if (len === 0) continue;
      (len >= 30 && len <= 420 ? good : rest).push({ highlight: h, book, score: 0 });
    }
  }
  const pool = good.length > 0 ? good : rest;
  if (pool.length === 0) return null;
  return pool[Math.floor(random() * pool.length)] ?? pool[0];
}

/** "2026-10-31" → "10월 31일" (올해가 아니면 "2025년 10월 31일") */
export function formatDayLabel(key: string, now = new Date()): string {
  const [y, m, d] = key.split("-").map(Number);
  if (!y || !m || !d) return key;
  return y === now.getFullYear() ? `${m}월 ${d}일` : `${y}년 ${m}월 ${d}일`;
}
