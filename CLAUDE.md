# CLAUDE.md — a4p-readwise-search

옵시디언 안에서 Readwise highlights를 검색·인용·전용 노트화 하는 플러그인. 수강생 대상 배포.

## 핵심 결정

- **배포 경로**: ai4pastor GitHub org (public) + BRAT
- **플러그인 id**: `a4p-readwise-search`
- **UI 언어**: 100% 한국어
- **인증**: 사용자 본인 Readwise API 토큰 (설정 UI에서 입력)
- **로컬 캐시**: 플러그인 `data.json` 안에 settings + highlights 통합 저장
- **데이터 흐름**: Readwise API (`/auth/`, `/export/`, `/review/`) 외 외부 통신 없음
- **인용 형식**: `> [!quote]` callout (책 — 저자 헤드라인 + 본문 + 메모 + Readwise 링크)
- **전용 노트 경로**: `{noteRootFolder}/{책 sanitize}/{본문 스니펫}.md` — 책별 하위 폴더
- **중복 처리**: 같은 highlight_id면 기존 노트 열기, 다른 highlight면 ` (2)`, ` (3)` 접미사
- **검색**: substring AND (한국어 음절 대응) + 책/카테고리/태그 필터 + 정렬(관련도/최근/책별)
- **기본 보기**: 검색어/필터 없으면 최근 업데이트된 highlight 자동 표시 + 배너

## 워크플로우

- 빌드: `npm run build`
- 개발 watch: `npm run dev`
- dev vault 심볼릭: `~/obsidian_dev_vault/.obsidian/plugins/a4p-readwise-search` → `~/Projects/a4p-readwise-search`
- 커밋: PR 단위로 잘게, 메시지에 Co-Authored-By 포함

## 절대 안 하는 것

- API 토큰을 코드에 하드코딩하지 않는다 (수강생 배포 원칙)
- Readwise 채팅(Chat) 같은 비공개 엔드포인트를 흉내 내지 않는다 (공개 API만 사용)
- 영문 UI 잔재 두지 않는다 — 사용자에게 노출되는 모든 텍스트는 한국어
- 기존에 생성된 highlight 노트를 자동으로 덮어쓰지 않는다 (열기만)
- 옵시디언 wikilink 형식을 깨뜨리지 않는다

## 수강생 시나리오 검증 (모든 변경 시 점검)

- [ ] BRAT만으로 설치 가능 (릴리스에 `main.js`, `manifest.json`, `styles.css` 자산 보장)
- [ ] 토큰 발급 → 입력 → 검증 → 동기화까지 메시지 안내가 한국어
- [ ] 에러 Notice 한국어
- [ ] 기존 사용자 설정 키(`apiToken`, `noteRootFolder`, `lastSyncAt`)와 캐시 형태 호환
- [ ] 추가 의존성·외부 서비스 없음 (Readwise API 외)

## 참고

- Readwise API v2: https://readwise.io/api_deets
- BRAT: https://github.com/TfTHacker/obsidian42-brat
- 표준 패턴: [[plugin-distribution-pattern]] (수강생 7원칙)
- 선례 플러그인: a4p-pdf-ocr
