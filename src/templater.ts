import { App, Notice, normalizePath, TFile } from "obsidian";

/**
 * Templater 브리지 — 노트 생성 직후 사용자의 분류 템플릿(예: WORD 분류법)을 새 노트 기준으로 실행한다.
 *
 * 방식: Templater 내부 API `create_running_config(templateFile, noteFile, OverwriteFile)` + `parse_template(config, text)`를
 * 두 번 호출한다 (Templater 2.23.1 main.js에서 확인, 2026-09-05).
 *   Pass A — 템플릿 프론트매터 텍스트만 렌더(`<% tp.file.creation_date() %>` 등) → 노트 프론트매터에 없는 키만 줄 단위로 병합
 *   Pass B — 템플릿 본문(`<%_* … _%>` 스크립트) 렌더 = 실행. 스크립트는 `tp.config.target_file`(= 새 노트)을 보고
 *            `tp.file.content`(= 디스크의 깨끗한 노트 내용)를 읽어 AI 분류 후 processFrontMatter로 직접 기록한다.
 *
 * `overwrite_file_commands`(Plaud 방식)를 쓰지 않는 이유: 파일 전체를 다시 쓰므로 실행 중의 processFrontMatter 결과가
 * 유실되고, 템플릿 스크립트 코드 자체가 `tp.file.content`에 섞여 AI 프롬프트를 오염시킨다.
 * `write_template_to_file`을 쓰지 않는 이유: 2025-07 이전 빌드는 대상 내용을 통째로 교체한다.
 *
 * 원칙: 어떤 단계가 실패해도 생성된 노트는 그대로 둔다(삭제·되돌리기 없음). 프론트매터는 YAML 파서 없이 줄 단위로 다룬다.
 */

interface TemplaterRunningConfig {
  template_file?: TFile;
  target_file: TFile;
  run_mode: number;
  active_file?: TFile | null;
}

interface TemplaterCore {
  create_running_config?: (
    templateFile: TFile | undefined,
    targetFile: TFile,
    runMode: number,
  ) => TemplaterRunningConfig;
  parse_template?: (config: TemplaterRunningConfig, content: string) => Promise<unknown>;
  start_templater_task?: (path: string) => void;
  end_templater_task?: (path: string) => Promise<void> | void;
}

interface TemplaterPluginLike {
  templater?: TemplaterCore;
  settings?: { templates_folder?: string };
}

const RUN_MODE_OVERWRITE_FILE = 2; // Templater RunMode.OverwriteFile — 커서 이동·에디터 의존 없음
const TEMPLATE_TIMEOUT_MS = 90_000;
const LOG = "[A4P Readwise]";

export interface TemplateFill {
  /** 플러그인이 프론트매터에 쓴 Readwise 태그 — 템플릿이 tags를 덮어써도 합집합으로 복원 */
  readwiseTags: string[];
  highlightId: number;
}

// ── Templater 접근 ────────────────────────────────────────────────

function getTemplaterPlugin(app: App): TemplaterPluginLike | null {
  const plugins = (
    app as unknown as { plugins?: { plugins?: Record<string, TemplaterPluginLike> } }
  ).plugins?.plugins;
  return plugins?.["templater-obsidian"] ?? null;
}

export function getTemplater(app: App): TemplaterCore | null {
  return getTemplaterPlugin(app)?.templater ?? null;
}

export function isTemplaterReady(app: App): { ok: boolean; reason?: string } {
  const tpl = getTemplater(app);
  if (!tpl) return { ok: false, reason: "Templater 플러그인이 설치되어 있지 않거나 꺼져 있습니다" };
  if (typeof tpl.parse_template !== "function" || typeof tpl.create_running_config !== "function") {
    return { ok: false, reason: "설치된 Templater 버전과 호환되지 않습니다" };
  }
  return { ok: true };
}

/** Templater 설정의 템플릿 폴더 (없으면 null) */
export function getTemplaterTemplatesFolder(app: App): string | null {
  const folder = getTemplaterPlugin(app)?.settings?.templates_folder?.trim();
  if (!folder || folder === "/") return null;
  return normalizePath(folder);
}

// ── 텍스트 유틸 (줄 단위 — YAML 파서 없음) ─────────────────────────

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/;

/** 템플릿 텍스트를 선두 프론트매터와 본문으로 나눈다. BOM 제거, CRLF → LF. */
export function splitTemplate(raw: string): { fmText: string | null; body: string } {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = text.match(FRONTMATTER_RE);
  if (!m) return { fmText: null, body: text };
  return { fmText: m[1], body: text.slice(m[0].length) };
}

/** 노트 텍스트를 프론트매터 줄들과 나머지 본문으로 나눈다. 프론트매터가 없으면 null. */
export function splitNoteFrontmatter(raw: string): { fmLines: string[]; body: string } | null {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = text.match(FRONTMATTER_RE);
  if (!m) return null;
  return { fmLines: m[1].split("\n"), body: text.slice(m[0].length) };
}

export interface FrontmatterEntry {
  key: string;
  /** 키 행의 값 부분 (trim). 빈 문자열이면 값 없음 */
  value: string;
  /** 키 행 + 연속 행(리스트 항목·들여쓴 행) 원문 */
  lines: string[];
}

// 열 0에서 시작하는 "키: 값" 행. 앞 공백·'-'·'#'으로 시작하는 행은 직전 키의 연속 행으로 본다.
const KEY_LINE_RE = /^([A-Za-z0-9가-힣_][^:]*?):\s*(.*)$/;

export function parseFrontmatterEntries(fmText: string): FrontmatterEntry[] {
  const entries: FrontmatterEntry[] = [];
  for (const line of fmText.split("\n")) {
    const m = line.match(KEY_LINE_RE);
    if (m) {
      entries.push({ key: m[1].trim(), value: m[2].trim(), lines: [line] });
    } else if (entries.length > 0) {
      entries[entries.length - 1].lines.push(line);
    }
  }
  // 각 항목 끝의 빈 줄은 버린다
  for (const e of entries) {
    while (e.lines.length > 1 && e.lines[e.lines.length - 1].trim() === "") e.lines.pop();
  }
  return entries;
}

function yamlQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * 플러그인 프론트매터 줄들에 템플릿 프론트매터(렌더된 텍스트)의 키를 병합한다.
 * - 플러그인 키 우선(같은 키는 템플릿 쪽을 버림). 템플릿 키는 템플릿 순서대로 뒤에 추가.
 * - 템플릿 안 중복 키는 첫 번째만.
 * - `source`가 빈 값이면 fill.source(하이라이트 Readwise 링크)로 채운다.
 */
export function mergeFrontmatter(
  pluginFmLines: string[],
  templateFmText: string,
  fill: { source?: string },
): { lines: string[]; added: string[] } {
  const have = new Set(parseFrontmatterEntries(pluginFmLines.join("\n")).map((e) => e.key.toLowerCase()));
  const seen = new Set<string>();
  const out = [...pluginFmLines];
  const added: string[] = [];

  for (const entry of parseFrontmatterEntries(templateFmText)) {
    const k = entry.key.toLowerCase();
    if (have.has(k) || seen.has(k)) continue;
    seen.add(k);

    let lines = entry.lines;
    if (k === "source" && !entry.value && lines.length === 1 && fill.source) {
      lines = [`source: ${yamlQuote(fill.source)}`];
    }
    out.push(...lines);
    added.push(entry.key);
  }
  return { lines: out, added };
}

/** Pass A 렌더 실패 시 폴백 — Templater 표현식을 빈 값으로 지워 키만 남긴다 */
export function blankTemplaterTags(text: string): string {
  return text.replace(/<%[\s\S]*?%>/g, "");
}

export function stripCursorMarkers(text: string): string {
  return text.replace(/<%[-_]?\s*tp\.file\.cursor\(\s*\d*\s*\)\s*[-_]?%>/g, "");
}

/** 렌더 결과 앞에 남은 프론트매터 블록(들)을 제거 — 본문 중간에 YAML이 박히는 것 방지 */
export function removeLeadingFrontmatterBlocks(text: string): string {
  let out = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  for (;;) {
    const m = out.match(/^\s*---\n[\s\S]*?\n---[ \t]*(?:\n|$)/);
    if (!m) break;
    out = out.slice(m[0].length);
  }
  return out;
}

/** 옵시디언 태그 규칙: 선행 # 제거, 공백·언더바·슬래시·역슬래시 제거 */
export function sanitizeTag(t: unknown): string {
  return String(t ?? "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[\s/\\_]+/g, "");
}

function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.trim()) return v.split(",").map((s) => s.trim());
  return [];
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

// ── Templater 실행 ────────────────────────────────────────────────

async function renderWithTemplater(
  tpl: TemplaterCore,
  templateFile: TFile,
  target: TFile,
  text: string,
): Promise<string> {
  const config = tpl.create_running_config!(templateFile, target, RUN_MODE_OVERWRITE_FILE);
  const out = await tpl.parse_template!(config, text);
  return typeof out === "string" ? out : "";
}

/** Templater의 실행 중 작업 추적을 맞춰준다(예외 시에도 반드시 종료 — 안 하면 전역 이벤트가 막힘) */
async function withTemplaterTask<T>(tpl: TemplaterCore, path: string, fn: () => Promise<T>): Promise<T> {
  tpl.start_templater_task?.(path);
  try {
    return await fn();
  } finally {
    await tpl.end_templater_task?.(path);
  }
}

/**
 * 분류 결과 정규화 (processFrontMatter 1회):
 * - tags = Readwise 태그 ∪ 템플릿이 쓴 태그 (sanitizeTag, 중복 제거)
 * - world/outcome/doctrine 배열의 null·빈 문자열 제거
 * - route가 원소 1개 리스트면 스칼라로 (볼트 규칙: route는 스칼라)
 * - source 키가 있고 비어 있으면 하이라이트 링크로
 */
export async function normalizeClassifiedFrontmatter(
  app: App,
  file: TFile,
  readwiseTags: string[],
  source: string,
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const merged = dedupe([...readwiseTags, ...toStringArray(fm.tags)].map(sanitizeTag).filter(Boolean));
    if (merged.length > 0) fm.tags = merged;

    for (const key of ["world", "outcome", "doctrine"]) {
      if (Array.isArray(fm[key])) {
        fm[key] = (fm[key] as unknown[]).filter((v) => typeof v === "string" && v.trim() !== "");
      }
    }

    if (Array.isArray(fm.route)) {
      const route = (fm.route as unknown[]).filter((v) => typeof v === "string" && v.trim() !== "");
      fm.route = route.length === 1 ? route[0] : route;
    }

    if (source && "source" in fm && (fm.source === null || fm.source === undefined || fm.source === "")) {
      fm.source = source;
    }
  });
}

/**
 * 새 노트에 분류 템플릿을 적용한다. 절대 throw 하지 않으며, 실패 시 한국어 Notice만 남기고 노트는 그대로 둔다.
 * 90초 안에 끝나지 않으면 먼저 반환하고(호출자가 노트를 연다) 작업은 백그라운드에서 이어진다.
 */
export async function applyNoteTemplate(
  app: App,
  file: TFile,
  templatePath: string,
  fill: TemplateFill,
): Promise<void> {
  const ready = isTemplaterReady(app);
  if (!ready.ok) {
    new Notice(`⚠️ 분류 템플릿을 건너뜁니다: ${ready.reason}`, 8000);
    return;
  }
  const tpl = getTemplater(app)!;

  const templateFile = app.vault.getAbstractFileByPath(normalizePath(templatePath));
  if (!(templateFile instanceof TFile)) {
    new Notice(`⚠️ 분류 템플릿을 찾을 수 없습니다: ${templatePath}`, 8000);
    return;
  }

  let raw: string;
  try {
    raw = await app.vault.read(templateFile);
  } catch (e) {
    console.error(LOG, "분류 템플릿 읽기 실패", e);
    new Notice("⚠️ 분류 템플릿을 읽을 수 없습니다", 8000);
    return;
  }

  const { fmText, body } = splitTemplate(raw);
  const source = `https://readwise.io/open/${fill.highlightId}`;

  const work = (async () => {
    await withTemplaterTask(tpl, file.path, async () => {
      // Pass A — 프론트매터 스켈레톤 렌더 → 줄 단위 병합
      if (fmText !== null && fmText.trim() !== "") {
        let rendered = "";
        try {
          rendered = await renderWithTemplater(tpl, templateFile, file, fmText);
        } catch (e) {
          console.error(LOG, "템플릿 프론트매터 렌더 실패 — 표현식을 비워 병합합니다", e);
        }
        if (rendered.trim() === "") rendered = blankTemplaterTags(fmText);

        // read → merge → modify 사이에 await를 두지 않는다 (경합 방지)
        const note = await app.vault.read(file);
        const split = splitNoteFrontmatter(note);
        if (split) {
          const { lines, added } = mergeFrontmatter(split.fmLines, rendered, { source });
          if (added.length > 0) {
            await app.vault.modify(file, `---\n${lines.join("\n")}\n---\n${split.body}`);
          }
        }
      }

      // Pass B — 본문 스크립트 실행 (AI 분류 → 템플릿이 processFrontMatter로 직접 기록)
      if (body.trim() !== "") {
        const out = await renderWithTemplater(tpl, templateFile, file, body);
        const extra = stripCursorMarkers(removeLeadingFrontmatterBlocks(out)).trim();
        if (extra) {
          await app.vault.process(file, (data) => data.replace(/\n*$/, "\n\n") + extra + "\n");
        }
      }
    });

    await normalizeClassifiedFrontmatter(app, file, fill.readwiseTags, source);
  })();

  const guarded = work.then(
    () => "done" as const,
    (e: unknown) => {
      console.error(LOG, "분류 템플릿 실행 실패", e);
      const msg = e instanceof Error ? e.message : String(e);
      new Notice(`⚠️ 분류 템플릿 실행 실패: ${msg.slice(0, 120)}`, 8000);
      return "error" as const;
    },
  );
  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), TEMPLATE_TIMEOUT_MS),
  );

  const result = await Promise.race([guarded, timeout]);
  if (result === "timeout") {
    new Notice(
      "⏱️ 분류가 90초 안에 끝나지 않아 노트를 먼저 엽니다. 완료되면 속성이 자동으로 채워집니다 — 그 전까지 입력한 내용은 덮어써질 수 있습니다.",
      10000,
    );
  }
}
