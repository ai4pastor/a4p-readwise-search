import { Plugin, WorkspaceLeaf } from "obsidian";
import {
  DEFAULT_SETTINGS,
  ReadwiseSearchSettings,
  ReadwiseSearchSettingTab,
} from "./settings";
import { SyncService } from "./sync";
import { CachedData, EMPTY_CACHE } from "./types";
import { ReadwiseSearchView, VIEW_TYPE_READWISE_SEARCH } from "./view";

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

    this.registerView(
      VIEW_TYPE_READWISE_SEARCH,
      (leaf) => new ReadwiseSearchView(leaf, this),
    );

    this.addRibbonIcon("search", "Readwise Search", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "readwise-open-search",
      name: "Readwise: 검색 패널 열기",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "readwise-sync",
      name: "Readwise: 동기화 (증분)",
      callback: async () => {
        await this.sync.run({ full: false });
        this.notifyViews();
      },
    });

    this.addCommand({
      id: "readwise-sync-full",
      name: "Readwise: 전체 다시 동기화",
      callback: async () => {
        await this.sync.run({ full: true });
        this.notifyViews();
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

  async activateView() {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: VIEW_TYPE_READWISE_SEARCH, active: true });
    }
    if (leaf) workspace.revealLeaf(leaf);
  }

  notifyViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH)) {
      const view = leaf.view;
      if (view instanceof ReadwiseSearchView) view.refreshAfterSync();
    }
  }
}
