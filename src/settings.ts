import { App, PluginSettingTab, Setting } from "obsidian";
import type ReadwiseSearchPlugin from "./main";

export interface ReadwiseSearchSettings {
  apiToken: string;
}

export const DEFAULT_SETTINGS: ReadwiseSearchSettings = {
  apiToken: "",
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

    new Setting(containerEl)
      .setName("Readwise API 토큰")
      .setDesc("https://readwise.io/access_token 에서 발급받은 토큰을 입력하세요.")
      .addText((text) =>
        text
          .setPlaceholder("Token...")
          .setValue(this.plugin.settings.apiToken)
          .onChange(async (value) => {
            this.plugin.settings.apiToken = value.trim();
            await this.plugin.saveSettings();
          }),
      );
  }
}
