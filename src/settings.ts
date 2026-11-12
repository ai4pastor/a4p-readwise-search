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
import {
  CITATION_FORMAT_LABELS,
  CitationFormat,
  CitationSource,
  DEFAULT_CUSTOM_TEMPLATE,
  formatCitation,
  SAMPLE_SOURCE,
  sourceFromHit,
  TEMPLATE_VARIABLES,
} from "./citation-format";
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
  /** 캐시 형식 버전 — sync.ts의 CACHE_VERSION보다 낮으면 다음 동기화를 한 번 전체로 강제 (v0.2.4 삭제 반영) */
  cacheVersion: number;
  /** 인용 형식 (v0.3.0) — 기본 콜아웃은 v0.2.x와 같은 출력 */
  citationFormat: CitationFormat;
  /** citationFormat이 custom일 때 쓰는 템플릿 */
  citationTemplate: string;
  /** 큰 검색 창 여는 글자 (빈 값 = 끔) */
  suggestTrigger: string;
  /** 토큰 보관 위치 (v0.3.1) — settings: data.json(기본, 기기 간 그대로) · keychain: Obsidian 키체인(data.json에 안 남음, 기기마다 입력) */
  tokenStorage: "settings" | "keychain";
  /** 자동 동기화 간격(분), 0 = 끔 (v0.3.1) */
  autoSyncMinutes: number;
  /** Obsidian을 켤 때 한 번 동기화 (v0.3.1) */
  syncOnStartup: boolean;
  /** 큰 검색 창의 최근 검색어 — 최근 것이 앞 (v0.4.0) */
  recentQueries: string[];
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
  cacheVersion: 0,
  citationFormat: "callout",
  citationTemplate: DEFAULT_CUSTOM_TEMPLATE,
  suggestTrigger: ",,",
  tokenStorage: "settings",
  autoSyncMinutes: 60,
  syncOnStartup: true,
  recentQueries: [],
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

    const keychain = this.plugin.keychainAvailable();
    const inKeychain = this.plugin.settings.tokenStorage === "keychain";
    let tokenInput: TextComponent | null = null;
    new Setting(containerEl)
      .setName("Readwise API 토큰")
      .setDesc(tokenDesc)
      .addText((text) => {
        tokenInput = text;
        // 강의 화면 공유 때 토큰이 보이지 않게 가려 둔다 (눈 단추로 잠깐 보기)
        text.inputEl.type = "password";
        text
          .setPlaceholder(inKeychain ? "토큰을 붙여넣으세요 (이 기기 키체인에 저장)" : "Token...")
          .setValue(this.plugin.getToken())
          .onChange(async (value) => {
            await this.plugin.setToken(value);
          });
      })
      .addExtraButton((btn) =>
        btn
          .setIcon("eye")
          .setTooltip("토큰 보기·가리기")
          .onClick(() => {
            if (!tokenInput) return;
            tokenInput.inputEl.type = tokenInput.inputEl.type === "password" ? "text" : "password";
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
            const token = this.plugin.getToken();
            if (!token) {
              new Notice(this.plugin.tokenMissingMessage(), 8000);
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

    // 키체인을 쓸 수 있거나, 다른 기기에서 키체인으로 바꿔 둔 설정이 넘어온 경우에만 보인다
    if (keychain || inKeychain) {
      const storageDesc = document.createDocumentFragment();
      storageDesc.appendText("플러그인 설정 파일: 지금처럼 data.json에 저장되어 휴대폰 등 여러 기기에서 그대로 씁니다. ");
      storageDesc.createEl("br");
      storageDesc.appendText(
        "Obsidian 키체인: 이 기기에만 암호화해 보관하고 data.json에는 남기지 않습니다. 볼트를 남과 공유하거나 백업·GitHub에 올린다면 이쪽이 안전합니다. 다른 기기에서는 토큰을 한 번 더 넣어야 합니다.",
      );
      new Setting(containerEl)
        .setName("토큰 보관 위치")
        .setDesc(storageDesc)
        .addDropdown((dd) =>
          dd
            .addOption("settings", "플러그인 설정 파일 (기본)")
            .addOption("keychain", keychain ? "Obsidian 키체인" : "Obsidian 키체인 (이 기기에서는 못 씀)")
            .setValue(this.plugin.settings.tokenStorage)
            .onChange(async (value) => {
              if (value === "keychain" && !keychain) {
                new Notice("이 기기의 Obsidian은 키체인을 지원하지 않습니다 (1.11.4 이상 필요).", 6000);
                dd.setValue(this.plugin.settings.tokenStorage);
                return;
              }
              await this.plugin.moveToken(value === "keychain" ? "keychain" : "settings");
              new Notice(
                value === "keychain"
                  ? "토큰을 이 기기의 Obsidian 키체인으로 옮기고 data.json에서 지웠습니다. 휴대폰 등 다른 기기에서는 설정에서 토큰을 한 번 더 넣어 주세요."
                  : "토큰을 플러그인 설정 파일(data.json)로 되돌렸습니다.",
                9000,
              );
              this.display();
            }),
        );
    }

    containerEl.createEl("h3", { text: "동기화" });

    const status = containerEl.createDiv();
    this.renderStatus(status);

    new Setting(containerEl)
      .setName("지금 동기화")
      .setDesc(
        "마지막 동기화 이후 변경된 항목만 받아옵니다. Readwise에서 지운 하이라이트도 목록에서 빠집니다 (메모 노트를 만든 것은 남습니다).",
      )
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

    new Setting(containerEl)
      .setName("자동 동기화")
      .setDesc(
        "Obsidian이 켜져 있는 동안 이 간격으로 바뀐 것만 받아옵니다. 새 하이라이트나 삭제 반영이 있을 때만 알림이 뜹니다. 처음 한 번은 위의 '전체 동기화'를 직접 눌러야 시작됩니다. (기본 1시간)",
      )
      .addDropdown((dd) =>
        dd
          .addOptions({ "0": "끔", "15": "15분마다", "30": "30분마다", "60": "1시간마다", "180": "3시간마다" })
          .setValue(String(this.plugin.settings.autoSyncMinutes))
          .onChange(async (value) => {
            this.plugin.settings.autoSyncMinutes = Number(value);
            await this.plugin.persist();
            this.plugin.setupAutoSync();
          }),
      );

    new Setting(containerEl)
      .setName("시작할 때 동기화")
      .setDesc("Obsidian을 켜고 15초 뒤 한 번 바뀐 것만 받아옵니다. (기본 켬)")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
          this.plugin.settings.syncOnStartup = value;
          await this.plugin.persist();
        }),
      );

    containerEl.createEl("h3", { text: "인용 넣기" });

    new Setting(containerEl)
      .setName("인용 형식")
      .setDesc(
        "인용 삽입 버튼, 드래그, Daily Review, 큰 검색 창에 모두 적용됩니다. 각주는 옵시디언 인라인 각주(^[…])로 들어가서 읽기 화면에서 번호 각주로 보입니다.",
      )
      .addDropdown((dd) =>
        dd
          .addOptions(CITATION_FORMAT_LABELS)
          .setValue(this.plugin.settings.citationFormat)
          .onChange(async (value) => {
            this.plugin.settings.citationFormat = value as CitationFormat;
            await this.plugin.persist();
            this.renderCitationArea(citationArea);
          }),
      );

    const citationArea = containerEl.createDiv();
    this.renderCitationArea(citationArea);

    new Setting(containerEl)
      .setName("큰 검색 창 여는 글자")
      .setDesc(
        "노트에서 이 글자를 치면 큰 검색 창이 열리고, 창에서 고른 밑줄이 그 자리에 인용으로 들어갑니다. 비워 두면 끕니다. 다른 플러그인과 겹치지 않는 두 글자를 쓰세요 — a4p 성경구절 플러그인은 ;; 와 ;;; 를 씁니다. (기본 ,,)",
      )
      .addText((text) =>
        text
          .setPlaceholder(",,")
          .setValue(this.plugin.settings.suggestTrigger)
          .onChange(async (value) => {
            this.plugin.settings.suggestTrigger = value.replace(/\s/g, "");
            await this.plugin.persist();
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

  /** 형식이 사용자 정의면 템플릿 입력란을 보이고, 어떤 형식이든 미리보기를 그린다 */
  private renderCitationArea(el: HTMLElement): void {
    el.empty();
    const settings = this.plugin.settings;
    let preview: HTMLElement | null = null;
    const updatePreview = () => {
      preview?.setText(
        formatCitation(this.previewSource(), {
          format: settings.citationFormat,
          template: settings.citationTemplate,
        }),
      );
    };

    if (settings.citationFormat === "custom") {
      const desc = document.createDocumentFragment();
      desc.appendText("쓸 수 있는 변수: ");
      TEMPLATE_VARIABLES.forEach(([key, label], i) => {
        if (i > 0) desc.appendText(" · ");
        desc.createEl("code", { text: `{{${key}}}` });
        desc.appendText(` ${label}`);
      });
      desc.createEl("br");
      desc.appendText("값이 모두 빈 줄은 빠집니다. ");
      desc.createEl("code", { text: "{{#author}} — {{author}}{{/author}}" });
      desc.appendText("처럼 쓰면 값이 있을 때만 들어갑니다.");

      new Setting(el)
        .setName("사용자 정의 템플릿")
        .setDesc(desc)
        .setClass("a4p-rw-template-setting")
        .addTextArea((ta) => {
          ta.setValue(settings.citationTemplate).onChange(async (value) => {
            settings.citationTemplate = value;
            await this.plugin.persist();
            updatePreview();
          });
          ta.inputEl.rows = 7;
          ta.inputEl.addClass("a4p-rw-template-input");
        })
        .addExtraButton((btn) =>
          btn
            .setIcon("rotate-ccw")
            .setTooltip("기본 템플릿으로 되돌리기")
            .onClick(async () => {
              settings.citationTemplate = DEFAULT_CUSTOM_TEMPLATE;
              await this.plugin.persist();
              this.renderCitationArea(el);
            }),
        );
    }

    const previewSetting = new Setting(el)
      .setName("미리보기")
      .setDesc("캐시에 있는 하이라이트 하나(없으면 예시)로 만든 모양입니다.");
    previewSetting.settingEl.addClass("a4p-rw-preview-setting");
    preview = el.createEl("pre", { cls: "a4p-rw-citation-preview" });
    updatePreview();
  }

  /** 미리보기 재료 — 쪽수가 있는 책 하이라이트 → 아무 하이라이트 → 예시 순 */
  private previewSource(): CitationSource {
    let fallback: CitationSource | null = null;
    for (const book of this.plugin.cache.books) {
      for (const highlight of book.highlights ?? []) {
        if (highlight.is_deleted) continue;
        const src = sourceFromHit({ highlight, book, score: 0 });
        if (book.category === "books" && highlight.location_type === "page" && highlight.location > 0) {
          return src;
        }
        if (!fallback) fallback = src;
      }
    }
    return fallback ?? SAMPLE_SOURCE;
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
