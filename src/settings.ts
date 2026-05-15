import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import { ReadwiseAuthError, ReadwiseClient } from "./api";
import type ReadwiseSearchPlugin from "./main";

export interface ReadwiseSearchSettings {
  apiToken: string;
  lastSyncAt: string | null;
  bookCount: number;
  highlightCount: number;
}

export const DEFAULT_SETTINGS: ReadwiseSearchSettings = {
  apiToken: "",
  lastSyncAt: null,
  bookCount: 0,
  highlightCount: 0,
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

    containerEl.createEl("h2", { text: "Readwise Search" });

    new Setting(containerEl)
      .setName("Readwise API 토큰")
      .setDesc("https://readwise.io/access_token 에서 발급받은 토큰을 입력하세요.")
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
          }),
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
