import { Notice, Plugin, requireApiVersion, WorkspaceLeaf } from "obsidian";
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

/** Obsidian 키체인에서 Readwise 토큰을 담는 항목 이름 (소문자·숫자·대시만 쓸 수 있다) */
export const KEYCHAIN_ENTRY_ID = "a4p-readwise-token";
/** 시작할 때 동기화는 노트 인덱스가 준비되고 앱이 다 뜬 뒤에 */
const STARTUP_SYNC_DELAY_MS = 15_000;

interface PersistedState {
  settings: ReadwiseSearchSettings;
  cache: CachedData;
}

export default class ReadwiseSearchPlugin extends Plugin {
  settings!: ReadwiseSearchSettings;
  cache!: CachedData;
  sync!: SyncService;
  noteIndex!: HighlightNoteIndex;
  private autoSyncTimer: number | null = null;

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

    // 자동 동기화 (v0.3.1): 설정한 간격마다 + 시작할 때 한 번, 바뀐 것만 조용히 받아온다
    this.setupAutoSync();
    this.app.workspace.onLayoutReady(() => {
      if (!this.settings.syncOnStartup) return;
      const timer = window.setTimeout(() => void this.autoSync(), STARTUP_SYNC_DELAY_MS);
      this.register(() => window.clearTimeout(timer));
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

  // ───────── 토큰 (v0.3.1) ─────────

  /** Obsidian 키체인(비밀 저장소)을 쓸 수 있는지 — 1.11.4 이상 */
  keychainAvailable(): boolean {
    return requireApiVersion("1.11.4") && !!this.app.secretStorage;
  }

  /** 설정한 보관 위치에서 토큰을 읽는다. 키체인은 기기마다 따로라 이 기기에 없으면 빈 값 */
  getToken(): string {
    if (this.settings.tokenStorage === "keychain") {
      if (!this.keychainAvailable()) return "";
      return this.app.secretStorage.getSecret(KEYCHAIN_ENTRY_ID) ?? "";
    }
    return this.settings.apiToken;
  }

  /** 토큰이 없을 때의 안내 — 보관 위치에 따라 할 일이 다르다 */
  tokenMissingMessage(): string {
    if (this.settings.tokenStorage === "keychain") {
      return this.keychainAvailable()
        ? "이 기기의 Obsidian 키체인에 Readwise 토큰이 없습니다. 설정에서 토큰을 한 번 넣어 주세요. (키체인은 기기마다 따로 보관됩니다)"
        : "이 기기의 Obsidian은 키체인을 지원하지 않습니다(1.11.4 이상 필요). 설정에서 토큰 보관 위치를 '플러그인 설정 파일'로 바꾸고 토큰을 넣어 주세요.";
    }
    return "Readwise 토큰이 설정되지 않았습니다. 설정 탭에서 입력해주세요.";
  }

  /** 토큰 저장 — 보관 위치가 키체인이면 data.json에는 남기지 않는다 */
  async setToken(value: string): Promise<void> {
    const token = value.trim();
    if (this.settings.tokenStorage === "keychain" && this.keychainAvailable()) {
      this.app.secretStorage.setSecret(KEYCHAIN_ENTRY_ID, token);
      this.settings.apiToken = "";
    } else {
      this.settings.apiToken = token;
    }
    await this.persist();
  }

  /** 보관 위치를 바꾸며 지금 토큰을 옮긴다. 옛 자리에는 남기지 않는다 */
  async moveToken(to: "settings" | "keychain"): Promise<void> {
    const token = this.getToken();
    if (to === "keychain") {
      if (!this.keychainAvailable()) return;
      if (token) this.app.secretStorage.setSecret(KEYCHAIN_ENTRY_ID, token);
      this.settings.apiToken = "";
    } else {
      this.settings.apiToken = token;
      // 키체인 사본은 빈 값으로 덮는다 (지우기는 공개 API에 없다)
      if (this.keychainAvailable() && this.app.secretStorage.getSecret(KEYCHAIN_ENTRY_ID) !== null) {
        this.app.secretStorage.setSecret(KEYCHAIN_ENTRY_ID, "");
      }
    }
    this.settings.tokenStorage = to;
    await this.persist();
  }

  // ───────── 자동 동기화 (v0.3.1) ─────────

  /** 설정한 간격으로 타이머를 다시 건다 — 설정을 바꾸면 다시 부른다 */
  setupAutoSync() {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    const minutes = this.settings.autoSyncMinutes;
    if (minutes > 0) {
      this.autoSyncTimer = window.setInterval(() => void this.autoSync(), minutes * 60_000);
      this.registerInterval(this.autoSyncTimer);
    }
  }

  /** 처음 한 번(전체 동기화)은 사용자가 직접 해야 돈다. 이미 돌고 있으면 건너뛴다 */
  private async autoSync() {
    if (!this.settings.lastSyncAt || this.sync.isRunning() || !this.getToken()) return;
    const result = await this.sync.run({ full: false, quiet: true });
    // 바뀐 게 없으면 패널을 다시 그리지 않는다 (읽던 자리가 튀지 않게)
    if (result.ok && (result.added > 0 || result.deleted > 0)) this.notifyViews();
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
