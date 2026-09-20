import {
  App,
  CachedMetadata,
  EventRef,
  Events,
  normalizePath,
  Plugin,
  TAbstractFile,
  TFile,
  TFolder,
} from "obsidian";

/**
 * 프론트매터 `highlight_id` → 숫자. 프로퍼티 패널에서 값이 문자열로 바뀌어도
 * 숫자만인 문자열("123")은 같은 highlight로 인식한다.
 */
export function parseHighlightId(v: unknown): number | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v > 0 ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{1,15}$/.test(s)) return Number(s);
  }
  return null;
}

/** `null` = 전체 갱신(rebuild 뒤) — 보이는 버튼을 모두 다시 판정해야 한다 */
export type NoteIndexChange = ReadonlySet<number> | null;

/**
 * highlight_id → 노트 경로 런타임 인덱스 (볼트 전체, data.json에 저장하지 않음).
 * 카드가 "노트 생성"/"노트 열기"를 O(1)로 판정하고, 노트 삭제·이동·프론트매터 수정을
 * vault/metadataCache 이벤트로 받아 즉시 갱신한다.
 */
export class HighlightNoteIndex extends Events {
  private byId = new Map<number, Set<string>>();
  private byPath = new Map<string, number>();
  private resolvedOnce = false;
  /** 첫 rebuild()가 끝났는지 — 그 전의 has()는 "아직 모름"이라 톰스톤 정리 근거로 쓰면 안 된다 */
  private ready = false;

  constructor(
    private app: App,
    /** 노트 폴더 — 같은 id의 노트가 여럿일 때 우선순위에만 쓴다 */
    private getRoot: () => string,
  ) {
    super();
  }

  onChange(cb: (ids: NoteIndexChange) => void): EventRef {
    return this.on("change", cb as (...data: unknown[]) => unknown);
  }

  /** Plugin.onload에서 1회. registerEvent로 등록해 unload 시 자동 해제 */
  register(plugin: Plugin): void {
    const { vault, metadataCache, workspace } = this.app;
    plugin.registerEvent(
      metadataCache.on("changed", (file, _data, cache) => this.onChanged(file, cache)),
    );
    plugin.registerEvent(vault.on("delete", (file) => this.onDelete(file)));
    plugin.registerEvent(vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
    // 옵시디언 시작 시 캐시가 아직 채워지지 않았을 수 있다: 레이아웃 준비 후 1차, 첫 resolved 후 2차
    workspace.onLayoutReady(() => this.rebuild());
    plugin.registerEvent(
      metadataCache.on("resolved", () => {
        if (this.resolvedOnce) return;
        this.resolvedOnce = true;
        this.rebuild();
      }),
    );
  }

  has(id: number): boolean {
    return (this.byId.get(id)?.size ?? 0) > 0;
  }

  /** 첫 rebuild() 이후 true. false면 has()가 false여도 노트가 없다고 단정할 수 없다 */
  isReady(): boolean {
    return this.ready;
  }

  /** 같은 id의 노트가 여럿이면: 노트 폴더 안 > 짧은 경로 > 사전순 */
  getPreferredPath(id: number): string | null {
    const paths = this.byId.get(id);
    if (!paths || paths.size === 0) return null;
    const root = normalizePath(this.getRoot().trim() || "Readwise") + "/";
    return Array.from(paths).sort(
      (a, b) =>
        Number(b.startsWith(root)) - Number(a.startsWith(root)) ||
        a.length - b.length ||
        a.localeCompare(b),
    )[0];
  }

  /** 인덱스에 남은 유령 경로(파일 없음)는 정리하고 다음 후보로 넘어간다 */
  getFile(id: number): TFile | null {
    for (;;) {
      const path = this.getPreferredPath(id);
      if (!path) return null;
      const f = this.app.vault.getAbstractFileByPath(path);
      if (f instanceof TFile) return f;
      this.removePath(path);
    }
  }

  /** vault.create 직후 낙관적 등록 — metadataCache를 기다리지 않고 카드가 바로 "노트 열기"로 */
  add(path: string, id: number): void {
    this.emit(this.setPath(path, id));
  }

  rebuild(): void {
    this.byId.clear();
    this.byPath.clear();
    for (const f of this.app.vault.getMarkdownFiles()) {
      const id = parseHighlightId(
        this.app.metadataCache.getFileCache(f)?.frontmatter?.highlight_id,
      );
      if (id !== null) this.setPath(f.path, id);
    }
    this.ready = true;
    this.trigger("change", null);
  }

  private onChanged(file: TFile, cache: CachedMetadata): void {
    if (file.extension !== "md") return;
    const id = parseHighlightId(cache.frontmatter?.highlight_id);
    this.emit(id === null ? this.removePath(file.path) : this.setPath(file.path, id));
  }

  private onDelete(file: TAbstractFile): void {
    this.emit(
      file instanceof TFolder ? this.removePrefix(file.path + "/") : this.removePath(file.path),
    );
  }

  // 폴더 이름 변경 시 자식별 rename 이벤트는 보장되지 않으므로 접두사로 직접 옮긴다
  private onRename(file: TAbstractFile, oldPath: string): void {
    const moves: [string, string][] =
      file instanceof TFolder
        ? Array.from(this.byPath.keys())
            .filter((p) => p.startsWith(oldPath + "/"))
            .map((p): [string, string] => [p, file.path + p.slice(oldPath.length)])
        : [[oldPath, file.path]];
    const changed = new Set<number>();
    for (const [from, to] of moves) {
      const id = this.byPath.get(from);
      if (id === undefined) continue;
      for (const c of this.removePath(from)) changed.add(c);
      for (const c of this.setPath(to, id)) changed.add(c);
    }
    this.emit(changed);
  }

  /** 경로를 id에 연결하고, 있음/없음 판정이 바뀐 id 집합을 돌려준다 */
  private setPath(path: string, id: number): Set<number> {
    const changed = new Set<number>();
    const prev = this.byPath.get(path);
    if (prev === id) return changed;
    if (prev !== undefined) for (const c of this.removePath(path)) changed.add(c);
    this.byPath.set(path, id);
    let paths = this.byId.get(id);
    if (!paths) {
      paths = new Set();
      this.byId.set(id, paths);
      changed.add(id); // 없음 → 있음
    }
    paths.add(path);
    return changed;
  }

  private removePath(path: string): Set<number> {
    const changed = new Set<number>();
    const id = this.byPath.get(path);
    if (id === undefined) return changed;
    this.byPath.delete(path);
    const paths = this.byId.get(id);
    if (paths) {
      paths.delete(path);
      if (paths.size === 0) {
        this.byId.delete(id);
        changed.add(id); // 있음 → 없음
      }
    }
    return changed;
  }

  private removePrefix(prefix: string): Set<number> {
    const changed = new Set<number>();
    for (const p of Array.from(this.byPath.keys())) {
      if (p.startsWith(prefix)) for (const c of this.removePath(p)) changed.add(c);
    }
    return changed;
  }

  private emit(ids: Set<number>): void {
    if (ids.size > 0) this.trigger("change", ids);
  }
}
