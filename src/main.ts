import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { registerCitationTracker } from "./citation";
import { BrowserOpenOptions, HighlightBrowserModal } from "./browser-modal";
import { triggerExtension } from "./trigger";
import {
  DEFAULT_SETTINGS,
  ReadwiseSearchSettings,
  ReadwiseSearchSettingTab,
} from "./settings";
import { HighlightNoteIndex } from "./note-index";
import { SyncService } from "./sync";
import { CachedData, EMPTY_CACHE } from "./types";
import {
  ReadwiseSearchView,
  ReadwiseTab,
  VIEW_TYPE_READWISE_SEARCH,
} from "./view";

interface PersistedState {
  settings: ReadwiseSearchSettings;
  cache: CachedData;
}

export default class ReadwiseSearchPlugin extends Plugin {
  settings!: ReadwiseSearchSettings;
  cache!: CachedData;
  sync!: SyncService;
  noteIndex!: HighlightNoteIndex;

  async onload() {
    await this.loadState();

    // highlight_id → 노트 경로 인덱스 (카드 버튼 "노트 생성"/"노트 열기" 판정, 삭제·이동 즉시 반영)
    this.noteIndex = new HighlightNoteIndex(this.app, () => this.settings.noteRootFolder);
    this.noteIndex.register(this);

    this.sync = new SyncService(this);
    registerCitationTracker(this);
    this.addSettingTab(new ReadwiseSearchSettingTab(this.app, this));

    // 노트에서 시작 글자(기본 ,,)를 치면 큰 검색 창이 열린다
    this.registerEditorExtension(triggerExtension(this));

    this.registerView(
      VIEW_TYPE_READWISE_SEARCH,
      (leaf) => new ReadwiseSearchView(leaf, this),
    );

    this.addRibbonIcon("bookmark", "A4P Readwise Search", () => {
      void this.activateView("search");
    });

    this.addCommand({
      id: "readwise-open-search",
      name: "검색 패널 열기",
      callback: () => {
        void this.activateView("search");
      },
    });

    this.addCommand({
      id: "readwise-quick-quote",
      name: "큰 검색 창 열기 (하이라이트 찾아 인용)",
      callback: () => this.openBrowser(),
    });

    this.addCommand({
      id: "readwise-open-daily",
      name: "Daily Review 열기",
      callback: () => {
        void this.activateView("daily");
      },
    });

    this.addCommand({
      id: "readwise-sync",
      name: "동기화 (증분)",
      callback: async () => {
        await this.sync.run({ full: false });
        this.notifyViews();
      },
    });

    // 전체 다시 동기화는 실수 방지를 위해 커맨드 팔레트에 노출하지 않고
    // 설정 탭의 "전체 동기화" 버튼에서만 실행한다.
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

  async activateView(tab: ReadwiseTab) {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH);
    let leaf: WorkspaceLeaf | null = existing[0] ?? null;
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_READWISE_SEARCH, active: true });
      }
    }
    if (!leaf) return;
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof ReadwiseSearchView) view.setTab(tab);
  }

  /** 큰 검색 창 — 명령·노트의 ,,·사이드 패널 "크게 보기"가 모두 여기로 온다 */
  openBrowser(opts: BrowserOpenOptions = {}) {
    if (this.cache.books.length === 0) {
      new Notice("아직 동기화된 데이터가 없습니다. 설정에서 토큰 입력 후 '전체 동기화'를 실행해주세요.");
      return;
    }
    new HighlightBrowserModal(this, opts).open();
  }

  notifyViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH)) {
      const view = leaf.view;
      if (view instanceof ReadwiseSearchView) view.refreshAfterSync();
    }
  }

  applyDefaultSortToViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH)) {
      const view = leaf.view;
      if (view instanceof ReadwiseSearchView) view.applyDefaultSort();
    }
  }

  applyFontScaleToViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_READWISE_SEARCH)) {
      const view = leaf.view;
      if (view instanceof ReadwiseSearchView) view.applyFontScale();
    }
  }
}
