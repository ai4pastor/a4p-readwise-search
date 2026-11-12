import { EditorView, ViewUpdate } from "@codemirror/view";
import { App, editorInfoField, TFile } from "obsidian";
import type ReadwiseSearchPlugin from "./main";

/**
 * 노트에서 시작 글자(기본 ,,)를 치면 큰 검색 창을 연다 (v0.3.0).
 * 타이핑(input.type)으로 시작 글자가 막 완성됐을 때만 연다 — 붙여넣기·되돌리기·다른 플러그인의 변경으로는 열리지 않는다.
 * 창에서 고른 밑줄은 시작 글자 자리에 들어간다. 창을 닫기만 하면 시작 글자는 그대로 남는다.
 */
export function triggerExtension(plugin: ReadwiseSearchPlugin) {
  return EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.docChanged) return;
    if (!update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
    const trigger = plugin.settings.suggestTrigger;
    if (!trigger || plugin.cache.books.length === 0) return;

    const state = update.state;
    const head = state.selection.main.head;
    const line = state.doc.lineAt(head);
    const before = line.text.slice(0, head - line.from);
    if (!before.endsWith(trigger)) return;
    const idx = before.length - trigger.length;
    // 인라인 코드(`…`)·코드 블록·프론트매터 안에서는 열지 않는다
    if (countChar(before.slice(0, idx), "`") % 2 === 1) return;
    const info = state.field(editorInfoField, false);
    const editor = info?.editor;
    if (!editor) return;
    const file = info?.file;
    if (file && inCodeOrFrontmatter(plugin.app, file, line.number - 1)) return;

    const from = { line: line.number - 1, ch: idx };
    const to = { line: line.number - 1, ch: before.length };
    // 편집기 갱신이 끝난 뒤 창을 연다 (갱신 중에 포커스를 옮기지 않기 위해)
    window.setTimeout(() => plugin.openBrowser({ target: { editor, from, to } }), 0);
  });
}

function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

function inCodeOrFrontmatter(app: App, file: TFile, line: number): boolean {
  const sections = app.metadataCache.getFileCache(file)?.sections;
  if (!sections) return false;
  return sections.some(
    (s) =>
      (s.type === "code" || s.type === "yaml") &&
      s.position.start.line <= line &&
      line <= s.position.end.line,
  );
}
