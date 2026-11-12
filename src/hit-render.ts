/** terms(소문자)가 나오는 곳을 <mark>로 감싸 그린다 */
export function renderTextWithMarks(el: HTMLElement, text: string, terms: string[]) {
  if (terms.length === 0 || !text) {
    el.setText(text);
    return;
  }
  const lower = text.toLowerCase();
  type Range = { start: number; end: number };
  const ranges: Range[] = [];
  for (const t of terms) {
    if (!t) continue;
    let from = 0;
    while (true) {
      const idx = lower.indexOf(t, from);
      if (idx === -1) break;
      ranges.push({ start: idx, end: idx + t.length });
      from = idx + t.length;
    }
  }
  if (ranges.length === 0) {
    el.setText(text);
    return;
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  let cursor = 0;
  for (const r of merged) {
    if (cursor < r.start) el.appendText(text.slice(cursor, r.start));
    el.createEl("mark", { text: text.slice(r.start, r.end) });
    cursor = r.end;
  }
  if (cursor < text.length) el.appendText(text.slice(cursor));
}

/** 긴 하이라이트는 처음 맞은 낱말 앞뒤만 잘라 보여 준다 — 목록에서 맞은 곳이 보이게 */
export function snippetAround(text: string, terms: string[], max = 140): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const lower = flat.toLowerCase();
  let idx = -1;
  for (const t of terms) {
    const i = t ? lower.indexOf(t) : -1;
    if (i !== -1 && (idx === -1 || i < idx)) idx = i;
  }
  if (idx <= 40) return flat.slice(0, max) + "…";
  const start = idx - 40;
  const end = Math.min(flat.length, start + max);
  return "…" + flat.slice(start, end) + (end < flat.length ? "…" : "");
}

/** "N분 전" · "어제" · "3주 전" 같은 상대 시간 (카드 표시용) */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return "방금 전";
  if (diffSec < 60 * 60) return `${Math.floor(diffSec / 60)}분 전`;
  const day = 24 * 60 * 60;
  if (diffSec < day) return `${Math.floor(diffSec / 3600)}시간 전`;
  if (diffSec < 2 * day) return "어제";
  if (diffSec < 7 * day) return `${Math.floor(diffSec / day)}일 전`;
  if (diffSec < 30 * day) return `${Math.floor(diffSec / (7 * day))}주 전`;
  if (diffSec < 365 * day) return `${Math.floor(diffSec / (30 * day))}달 전`;
  return `${Math.floor(diffSec / (365 * day))}년 전`;
}
