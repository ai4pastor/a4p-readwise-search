/**
 * 검색 문법 (v0.4.0).
 * - 띄어 쓴 낱말: 모두 들어 있어야 한다 (지금까지와 같음)
 * - "정확한 구절": 따옴표 안은 띄어쓰기까지 그대로 한 덩어리로 찾는다
 * - -낱말: 이 낱말이 든 밑줄은 뺀다
 * - 책:제목 · 저자:이름 · 태그:이름 · #태그 · 메모:낱말: 그 칸에서만 찾는다 (앞에 -를 붙이면 그 칸에 든 것을 뺀다)
 * 값에 띄어쓰기가 있으면 따옴표로 묶는다: 책:"기도의 능력"
 */
export interface QueryFields {
  book: string[];
  author: string[];
  tag: string[];
  note: string[];
}

export interface ParsedQuery {
  /** 들어 있어야 할 낱말·구절 (소문자) */
  terms: string[];
  /** terms와 같은 순서의 원래 대소문자 — 영문 자판 복원에서 쌍자음(Shift)을 살리려고 */
  termsRaw: string[];
  /** 들어 있으면 빼는 낱말·구절 (소문자) */
  excludes: string[];
  fields: QueryFields;
  excludeFields: QueryFields;
  /** 문법(따옴표·빼기·칸 지정)을 하나라도 썼는지 — 상태줄 설명용 */
  hasSyntax: boolean;
}

const FIELD_NAMES: Record<string, keyof QueryFields> = {
  책: "book",
  제목: "book",
  book: "book",
  저자: "author",
  author: "author",
  태그: "tag",
  tag: "tag",
  메모: "note",
  note: "note",
};

export const FIELD_LABELS: Record<keyof QueryFields, string> = {
  book: "책",
  author: "저자",
  tag: "태그",
  note: "메모",
};

const emptyFields = (): QueryFields => ({ book: [], author: [], tag: [], note: [] });

export function parseQuery(raw: string): ParsedQuery {
  const q: ParsedQuery = {
    terms: [],
    termsRaw: [],
    excludes: [],
    fields: emptyFields(),
    excludeFields: emptyFields(),
    hasSyntax: false,
  };
  const s = raw;
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    let negative = false;
    if (s[i] === "-" && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      negative = true;
      i++;
    }

    let field: keyof QueryFields | null = null;
    const named = /^([가-힣a-zA-Z]+):/.exec(s.slice(i));
    if (named && FIELD_NAMES[named[1].toLowerCase()]) {
      field = FIELD_NAMES[named[1].toLowerCase()];
      i += named[0].length;
    } else if (s[i] === "#" && i + 1 < s.length && !/\s/.test(s[i + 1])) {
      field = "tag";
      i++;
    }

    let value: string;
    let quoted = false;
    if (s[i] === '"') {
      quoted = true;
      const close = s.indexOf('"', i + 1);
      value = close === -1 ? s.slice(i + 1) : s.slice(i + 1, close);
      i = close === -1 ? s.length : close + 1;
    } else {
      let j = i;
      while (j < s.length && !/\s/.test(s[j])) j++;
      value = s.slice(i, j);
      i = j;
    }
    const original = value.replace(/\s+/g, " ").trim();
    value = original.toLowerCase();
    if (!value) continue;

    if (negative || field || quoted) q.hasSyntax = true;
    if (field) (negative ? q.excludeFields : q.fields)[field].push(value);
    else if (negative) q.excludes.push(value);
    else {
      q.terms.push(value);
      q.termsRaw.push(original);
    }
  }
  return q;
}

/** 상태줄에 보여 줄 조건 요약 — 예: 책 '기도' · 빼기 '번영' */
export function describeQuery(q: ParsedQuery): string {
  const parts: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as Array<keyof QueryFields>) {
    for (const v of q.fields[key]) parts.push(`${FIELD_LABELS[key]} '${v}'`);
    for (const v of q.excludeFields[key]) parts.push(`${FIELD_LABELS[key]} '${v}' 빼기`);
  }
  for (const v of q.terms) if (v.includes(" ")) parts.push(`구절 "${v}"`);
  for (const v of q.excludes) parts.push(`빼기 '${v}'`);
  return parts.join(" · ");
}
