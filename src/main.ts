import { Plugin } from "obsidian";
import {
  DEFAULT_SETTINGS,
  ReadwiseSearchSettings,
  ReadwiseSearchSettingTab,
} from "./settings";
import { SyncService } from "./sync";
import { CachedData, EMPTY_CACHE } from "./types";

interface PersistedState {
  settings: ReadwiseSearchSettings;
  cache: CachedData;
}

export default class ReadwiseSearchPlugin extends Plugin {
  settings!: ReadwiseSearchSettings;
  cache!: CachedData;
  sync!: SyncService;

  async onload() {
    await this.loadState();

    this.sync = new SyncService(this);
    this.addSettingTab(new ReadwiseSearchSettingTab(this.app, this));

    this.addCommand({
      id: "readwise-sync",
      name: "Readwise: 동기화 (증분)",
      callback: () => {
        void this.sync.run({ full: false });
      },
    });

    this.addCommand({
      id: "readwise-sync-full",
      name: "Readwise: 전체 다시 동기화",
      callback: () => {
        void this.sync.run({ full: true });
      },
    });
  }

  onunload() {}

  async loadState() {
    const raw = ((await this.loadData()) ?? {}) as Partial<PersistedState>;
    this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
    this.cache = { ...EMPTY_CACHE, ...(raw.cache ?? {}) };
  }

  async persist() {
    const payload: PersistedState = { settings: this.settings, cache: this.cache };
    await this.saveData(payload);
  }
}
