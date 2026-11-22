import { setIcon } from "obsidian";

/**
 * 만든 표지 (v0.5.0) — 제목 글자와 색으로 직접 그린다.
 * Readwise가 주는 표지 주소는 책 대부분이 기본 아이콘이고(실측: 책 61권 중 50권),
 * 그림을 불러오면 Readwise 밖의 서버와 통신하게 되므로 쓰지 않는다.
 */
export type CoverSize = "sm" | "md" | "lg";

export interface CoverSource {
  title?: string | null;
  category?: string | null;
  sourceUrl?: string | null;
}

/** 제목마다 늘 같은 색이 나오게 하는 색상 값 (0~359) */
export function coverHue(title: string): number {
  let x = 7;
  for (const ch of title) x = (x * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return x;
}

/** 표지에 올릴 글자 — 띄어쓰기·문장부호를 뺀 앞 두 글자 */
export function coverLetters(title: string): string {
  const letters = Array.from(title.replace(/[\s\p{P}\p{S}]/gu, ""));
  return letters.slice(0, 2).join("") || "?";
}

function docIcon(src: CoverSource): string {
  if (src.category === "tweets") return "message-circle";
  if (src.category === "podcasts") return "mic";
  if (/youtube\.com|youtu\.be/.test(src.sourceUrl ?? "")) return "play";
  return "file-text";
}

export function renderCover(parent: HTMLElement, src: CoverSource, size: CoverSize = "md"): HTMLElement {
  const title = (src.title ?? "").trim();
  const isBook = src.category === "books" || src.category === "supplementals";
  const el = parent.createSpan({ cls: `a4p-rw-cover is-${size} ${isBook ? "is-book" : "is-doc"}` });
  el.style.setProperty("--a4p-rw-hue", String(coverHue(title)));
  el.setAttr("aria-hidden", "true");
  if (isBook) el.createSpan({ cls: "a4p-rw-cover-letters", text: coverLetters(title) });
  else setIcon(el, docIcon(src));
  return el;
}
