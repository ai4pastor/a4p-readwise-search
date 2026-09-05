import { AbstractInputSuggest, App, TFile } from "obsidian";
import { getTemplaterTemplatesFolder } from "./templater";

/**
 * 마크다운 파일 경로 자동완성 (템플릿 선택용).
 * Templater의 템플릿 폴더 아래 파일을 먼저 보여주고, 그 밖의 볼트 전체 .md를 뒤에 붙인다.
 */
export class FileSuggest extends AbstractInputSuggest<TFile> {
  constructor(
    app: App,
    private inputEl: HTMLInputElement,
    private onSelectFile?: (file: TFile) => void,
  ) {
    super(app, inputEl);
    // 빈 칸을 클릭(focus)만 해도 목록이 보이도록 input 이벤트를 한 번 흘려준다.
    inputEl.addEventListener("focus", () => {
      inputEl.dispatchEvent(new Event("input"));
    });
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase();
    const byPath = (a: TFile, b: TFile) => a.path.localeCompare(b.path);
    const pool = this.app.vault
      .getMarkdownFiles()
      .filter((f) => !q || f.path.toLowerCase().includes(q));

    const prefer = getTemplaterTemplatesFolder(this.app);
    if (!prefer) return pool.sort(byPath).slice(0, 100);

    const prefix = prefer + "/";
    const inTemplates = pool.filter((f) => f.path.startsWith(prefix)).sort(byPath);
    const others = pool.filter((f) => !f.path.startsWith(prefix)).sort(byPath);
    return [...inTemplates, ...others].slice(0, 100);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.setText(file.path);
  }

  selectSuggestion(file: TFile): void {
    this.inputEl.value = file.path;
    this.inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    this.close();
    this.onSelectFile?.(file);
  }
}
