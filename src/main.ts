import { Notice, Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  ReadwiseSearchSettings,
  ReadwiseSearchSettingTab,
} from "./settings";

export default class ReadwiseSearchPlugin extends Plugin {
  settings!: ReadwiseSearchSettings;

  async onload() {
    await this.loadSettings();

    this.addSettingTab(new ReadwiseSearchSettingTab(this.app, this));

    this.addCommand({
      id: "readwise-search-hello",
      name: "Readwise Search: 활성화 확인",
      callback: () => {
        new Notice("Readwise Search 플러그인이 로드되었습니다.");
      },
    });
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
