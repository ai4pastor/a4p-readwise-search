# A4P Readwise Search

옵시디언 사이드 패널에서 Readwise highlights를 검색하고, 노트에 인용으로 삽입하거나 전용 노트로 변환하는 플러그인.

## 주요 기능

- **사이드 패널 검색** — 책·아티클·트윗·팟캐스트의 highlight를 키워드로 즉시 검색
- **필터** — 책, 카테고리, 태그로 좁히기 (책은 퍼지 검색 모달)
- **Daily Review 탭** — Readwise 오늘의 review를 한 번에 보기 + 전체 인용 일괄 삽입
- **인용 삽입** — 클릭 또는 드래그앤드롭으로 callout 형식 인용 삽입
- **Highlight → 메모 노트 생성** — 지정 폴더에 프론트매터 + `## 내 생각` 섹션 + 인용을 담은 단일 메모 자동 생성
- **시각 보조** — 카테고리 컬러 칩, 상대 시간 배지, 검색어 마킹, 정렬 옵션(관련도/최신/오래된순/책별)

## 설치 (BRAT 사용)

1. 옵시디언 커뮤니티 플러그인에서 **BRAT** 검색 → 설치 → 활성화
2. Cmd/Ctrl+P → "BRAT: Add a beta plugin for testing" 실행
3. 입력창에 `ai4pastor/a4p-readwise-search` 입력 → 추가
4. 옵시디언 설정 → 커뮤니티 플러그인에서 **A4P Readwise Search** 활성화

## 사용법

1. 설정 → **A4P Readwise Search**에서 "토큰 발급" 버튼 → Readwise에서 토큰 복사
2. 토큰 입력 → "토큰 검증" → 성공 확인
3. "전체 동기화" 클릭 → 모든 highlight 로컬 캐시 (이후 자동 증분)
4. 좌측 리본의 책갈피(bookmark) 아이콘 또는 명령 팔레트 "A4P Readwise Search: 검색 패널 열기"
5. 검색어 입력 → 결과 카드에서:
   - **인용 삽입** 버튼 또는 카드 드래그 → 현재 노트에 callout
   - **노트 생성** 버튼 → 노트 폴더에 `{스니펫}.md` 메모 (`## 내 생각` + `## 출처` 인용). 같은 highlight면 기존 메모를 엾니다
   - **Readwise** 링크 → 해당 책 페이지에서 "Find similar highlights" 사용 가능

## 명령 팔레트

- `A4P Readwise Search: 검색 패널 열기`
- `A4P Readwise Search: Daily Review 열기`
- `A4P Readwise Search: 동기화 (증분)`

> 전체 다시 동기화는 실수 방지를 위해 명령 팔레트에 두지 않고, 설정 탭의 "전체 동기화" 버튼에서만 실행합니다.

## 데이터 저장

- Readwise highlights는 플러그인 `data.json`에 로컬 캐시 (옵시디언 vault 외부 통신 없음, Readwise API 한정)
- 생성된 메모는 설정의 "노트 폴더" 안에 평평하게 저장 (책별 하위 폴더 없음)

## 라이선스

MIT
