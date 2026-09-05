import {
  App,
  Notice,
  normalizePath,
  PluginSettingTab,
  Setting,
  TextComponent,
  TFile,
  TFolder,
} from "obsidian";
import { ReadwiseAuthError, ReadwiseClient } from "./api";
import { FileSuggest } from "./file-suggest";
import { FolderSuggest } from "./folder-suggest";
import type ReadwiseSearchPlugin from "./main";
import type { SortMode } from "./search";
import { isTemplaterReady, parseFrontmatterEntries, splitTemplate } from "./templater";

export interface ReadwiseSearchSettings {
  apiToken: string;
  lastSyncAt: string | null;
  bookCount: number;
  highlightCount: number;
  noteRootFolder: string;
  /** 결과 카드 글자 크기 (%) — 패널 CSS 변수로 반영 */
  fontScale: number;
  /** 검색 패널을 열 때·초기화 시 적용되는 정렬 (기본 최신순) */
  defaultSort: SortMode;
  /** 노트 생성 직후 새 노트에 실행할 Templater 템플릿 경로 (빈 값 = 사용 안 함) */
  noteTemplatePath: string;
}

export const DEFAULT_SETTINGS: ReadwiseSearchSettings = {
  apiToken: "",
  lastSyncAt: null,
  bookCount: 0,
  highlightCount: 0,
  noteRootFolder: "Readwise",
  fontScale: 90,
  defaultSort: "recent",
  noteTemplatePath: "",
};

export class ReadwiseSearchSettingTab extends PluginSettingTab {
  plugin: ReadwiseSearchPlugin;

  constructor(app: App, plugin: ReadwiseSearchPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "A4P Readwise Search" });

    const tokenDesc = document.createDocumentFragment();
    tokenDesc.appendText("토큰이 없다면 ");
    const tokenLink = tokenDesc.createEl("a", {
      text: "readwise.io/access_token",
      href: "https://readwise.io/access_token",
    });
    tokenLink.setAttr("target", "_blank");
    tokenLink.setAttr("rel", "noopener");
    tokenDesc.appendText(" 에서 발급받아 아래에 붙여넣으세요.");

    new Setting(containerEl)
      .setName("Readwise API 토큰")
      .setDesc(tokenDesc)
      .addText((text) =>
        text
          .setPlaceholder("Token...")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.persist();
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("토큰 발급")
          .onClick(() => {
            window.open("https://readwise.io/access_token", "_blank");
          }),
      )
      .addButton((btn) =>
        btn
          .setButtonText("토큰 검증")
          .onClick(async () => {
            const token = this.plugin.settings.apiToken;
            if (!token) {
              new Notice("토큰을 먼저 입력해주세요.");
              return;
            }
            const client = new ReadwiseClient(token);
            try {
              await client.verifyToken();
              new Notice("토큰 검증 성공");
            } catch (e) {
              if (e instanceof ReadwiseAuthError) new Notice(`인증 실패: ${e.message}`);
              else if (e instanceof Error) new Notice(`검증 실패: ${e.message}`);
              else new Notice("검증 실패 (알 수 없는 오류)");
            }
          }),
      );

    containerEl.createEl("h3", { text: "동기화" });

    const status = containerEl.createDiv();
    this.renderStatus(status);

    new Setting(containerEl)
      .setName("지금 동기화")
      .setDesc("마지막 동기화 이후 변경된 항목만 받아옵니다.")
      .addButton((btn) =>
        btn
          .setButtonText("동기화")
          .setCta()
          .onClick(async () => {
            btn.setDisabled(true);
            await this.plugin.sync.run({ full: false });
            btn.setDisabled(false);
            this.renderStatus(status);
            this.plugin.notifyViews(); // 열린 검색 패널도 새 캐시로 갱신
          }),
      );

    new Setting(containerEl)
      .setName("전체 다시 동기화")
      .setDesc("로컬 캐시를 무시하고 모든 highlights를 다시 받아옵니다. 시간이 오래 걸릴 수 있습니다.")
      .addButton((btn) =>
        btn
          .setButtonText("전체 동기화")
          .setWarning()
          .onClick(async () => {
            btn.setDisabled(true);
            await this.plugin.sync.run({ full: true });
            btn.setDisabled(false);
            this.renderStatus(status);
            this.plugin.notifyViews();
          }),
      );

    containerEl.createEl("h3", { text: "Highlight 노트 생성" });

    new Setting(containerEl)
      .setName("노트 폴더")
      .setDesc(
        "Highlight → 메모 생성 시 노트가 저장될 폴더. 하위 폴더 없이 이 폴더에 바로 들어갑니다. 예: Readwise",
      )
      .addText((text) => {
        text
          .setPlaceholder("Readwise")
          .setValue(this.plugin.settings.noteRootFolder)
          .onChange(async (value) => {
            // FolderSuggest는 선택 시 후행 슬래시를 붙이므로 저장 전에 정리한다
            this.plugin.settings.noteRootFolder = value.trim().replace(/\/+$/, "") || "Readwise";
            await this.plugin.persist();
          });
        new FolderSuggest(this.app, text.inputEl);
      })
      .addButton((btn) =>
        btn.setButtonText("검증").onClick(() => {
          const path = normalizePath(this.plugin.settings.noteRootFolder);
          const folder = this.app.vault.getAbstractFileByPath(path);
          if (!(folder instanceof TFolder)) {
            new Notice(`⚠️ 폴더가 없습니다: ${path} (첫 노트 생성 시 자동으로 만들어집니다)`, 6000);
            return;
          }
          const count = folder.children.filter(
            (c) => c instanceof TFile && c.extension === "md",
          ).length;
          new Notice(`✅ 폴더 확인: ${path} · 노트 ${count}개`, 6000);
        }),
      );

    let templateInput: TextComponent | null = null;
    new Setting(containerEl)
      .setName("분류 템플릿 (Templater)")
      .setDesc(
        "노트 생성 직후 이 Templater 템플릿을 새 노트에 실행합니다 (예: WORD 분류법 — 템플릿의 프론트매터 키가 노트에 추가되고 <%* … %> 스크립트가 실행됩니다). 비워 두면 적용하지 않습니다. Templater 플러그인이 필요합니다.",
      )
      .addText((text) => {
        templateInput = text;
        text
          .setPlaceholder("Templater 템플릿 .md 경로 (비우면 사용 안 함)")
          .setValue(this.plugin.settings.noteTemplatePath)
          .onChange(async (value) => {
            const v = value.trim();
            this.plugin.settings.noteTemplatePath = v ? normalizePath(v) : "";
            await this.plugin.persist();
          });
        new FileSuggest(this.app, text.inputEl);
      })
      .addButton((btn) =>
        btn.setButtonText("검증").onClick(async () => {
          await this.verifyTemplate();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText("비우기").onClick(async () => {
          this.plugin.settings.noteTemplatePath = "";
          await this.plugin.persist();
          templateInput?.setValue("");
          new Notice("분류 템플릿을 사용하지 않습니다.");
        }),
      );

    containerEl.createEl("h3", { text: "보기" });

    new Setting(containerEl)
      .setName("기본 정렬")
      .setDesc(
        "검색 패널을 열 때와 '초기화'를 눌렀을 때 적용되는 정렬입니다. 최신순·오래된순은 실제로 하이라이트한 날짜 기준입니다. (기본 최신순)",
      )
      .addDropdown((dd) =>
        dd
          .addOptions({
            recent: "최신순",
            oldest: "오래된순",
            relevance: "관련도",
            book: "책별",
          })
          .setValue(this.plugin.settings.defaultSort)
          .onChange(async (value) => {
            this.plugin.settings.defaultSort = value as SortMode;
            await this.plugin.persist();
            this.plugin.applyDefaultSortToViews();
          }),
      );

    new Setting(containerEl)
      .setName("결과 카드 글자 크기")
      .setDesc("하이라이트 카드의 제목·본문 글자 크기입니다. (기본 90%)")
      .addSlider((slider) =>
        slider
          .setLimits(70, 110, 5)
          .setValue(this.plugin.settings.fontScale)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.fontScale = value;
            await this.plugin.persist();
            this.plugin.applyFontScaleToViews();
          }),
      );
  }

  private async verifyTemplate(): Promise<void> {
    const path = this.plugin.settings.noteTemplatePath;
    if (!path) {
      new Notice("분류 템플릿이 설정되지 않았습니다 (사용 안 함).");
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!(file instanceof TFile) || file.extension !== "md") {
      new Notice(`⚠️ 템플릿 파일을 찾을 수 없습니다: ${path}`, 8000);
      return;
    }
    const { fmText, body } = splitTemplate(await this.app.vault.read(file));
    const keys = fmText ? parseFrontmatterEntries(fmText).length : 0;
    const hasScript = /<%/.test(body) || /<%/.test(fmText ?? "");
    const ready = isTemplaterReady(this.app);
    new Notice(
      `${ready.ok ? "✅" : "⚠️"} 템플릿 확인: 프론트매터 키 ${keys}개 · 스크립트 ${hasScript ? "있음" : "없음"} · ${ready.ok ? "Templater 활성" : ready.reason}`,
      8000,
    );
  }

  private renderStatus(el: HTMLElement): void {
    el.empty();
    const s = this.plugin.settings;
    const line = el.createEl("p");
    if (!s.lastSyncAt) {
      line.setText("아직 동기화한 적 없음.");
      return;
    }
    const when = new Date(s.lastSyncAt).toLocaleString();
    line.setText(`마지막 동기화: ${when} · ${s.bookCount}권 · ${s.highlightCount}건`);
  }
}
