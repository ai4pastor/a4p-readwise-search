/**
 * 한글 검색 도우미 (v0.4.0) — 초성 검색과 영문 자판으로 친 글자 복원.
 * 외부 라이브러리 없이 유니코드 계산만 쓴다 (수강생 배포 원칙: 추가 의존성 없음).
 */

const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_LAST = 0xd7a3;
const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const JUNG = "ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ";
const JONG = ["", "ㄱ", "ㄲ", "ㄳ", "ㄴ", "ㄵ", "ㄶ", "ㄷ", "ㄹ", "ㄺ", "ㄻ", "ㄼ", "ㄽ", "ㄾ", "ㄿ", "ㅀ", "ㅁ", "ㅂ", "ㅄ", "ㅅ", "ㅆ", "ㅇ", "ㅈ", "ㅊ", "ㅋ", "ㅌ", "ㅍ", "ㅎ"];

/** 두 글자 이상이 모두 초성 자음이면 초성 검색어로 본다 (한 글자는 너무 많이 걸린다) */
export function isChoseongQuery(term: string): boolean {
  return term.length >= 2 && /^[ㄱ-ㅎ]+$/.test(term);
}

/**
 * 완성형 한글만 초성으로 바꿔 이어 붙인다 — 띄어쓰기·문장부호는 건너뛴다 ("하나님 사랑" → "ㅎㄴㄴㅅㄹ").
 * map[k]는 k번째 초성이 원문의 몇 번째 글자에서 왔는지 (강조 표시용).
 */
export function choseongIndex(text: string): { compact: string; map: number[] } {
  let compact = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST) {
      compact += CHO[Math.floor((code - SYLLABLE_FIRST) / 588)];
      map.push(i);
    }
  }
  return { compact, map };
}

/**
 * 낱말 경계를 지킨 초성 — 한글이 아닌 글자는 띄어쓰기로 둔다 ("하는 나" → "ㅎㄴ ㄴ").
 * 초성 검색은 먼저 이걸로 한 낱말 안에서만 찾고, 없을 때만 compact(띄어쓰기 건너뜀)로 넓힌다.
 */
export function choseongWords(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    out += code >= SYLLABLE_FIRST && code <= SYLLABLE_LAST ? CHO[Math.floor((code - SYLLABLE_FIRST) / 588)] : " ";
  }
  return out;
}

/** 원문에서 초성 검색어가 맞은 범위들 [시작, 끝) */
export function choseongRanges(text: string, term: string): Array<{ start: number; end: number }> {
  const { compact, map } = choseongIndex(text);
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (true) {
    const k = compact.indexOf(term, from);
    if (k === -1) break;
    ranges.push({ start: map[k], end: map[k + term.length - 1] + 1 });
    from = k + term.length;
  }
  return ranges;
}

// 두벌식 자판: 영문 키 → 자모 (대문자는 쌍자음·ㅒ·ㅖ, 나머지 대문자는 소문자와 같다)
const KEY_TO_JAMO: Record<string, string> = {
  q: "ㅂ", w: "ㅈ", e: "ㄷ", r: "ㄱ", t: "ㅅ", y: "ㅛ", u: "ㅕ", i: "ㅑ", o: "ㅐ", p: "ㅔ",
  a: "ㅁ", s: "ㄴ", d: "ㅇ", f: "ㄹ", g: "ㅎ", h: "ㅗ", j: "ㅓ", k: "ㅏ", l: "ㅣ",
  z: "ㅋ", x: "ㅌ", c: "ㅊ", v: "ㅍ", b: "ㅠ", n: "ㅜ", m: "ㅡ",
  Q: "ㅃ", W: "ㅉ", E: "ㄸ", R: "ㄲ", T: "ㅆ", O: "ㅒ", P: "ㅖ",
};
const COMPOUND_VOWEL: Record<string, string> = {
  "ㅗㅏ": "ㅘ", "ㅗㅐ": "ㅙ", "ㅗㅣ": "ㅚ", "ㅜㅓ": "ㅝ", "ㅜㅔ": "ㅞ", "ㅜㅣ": "ㅟ", "ㅡㅣ": "ㅢ",
};
const COMPOUND_JONG: Record<string, string> = {
  "ㄱㅅ": "ㄳ", "ㄴㅈ": "ㄵ", "ㄴㅎ": "ㄶ", "ㄹㄱ": "ㄺ", "ㄹㅁ": "ㄻ", "ㄹㅂ": "ㄼ",
  "ㄹㅅ": "ㄽ", "ㄹㅌ": "ㄾ", "ㄹㅍ": "ㄿ", "ㄹㅎ": "ㅀ", "ㅂㅅ": "ㅄ",
};

const isVowel = (j: string | undefined) => j !== undefined && JUNG.includes(j);
const isConsonant = (j: string | undefined) => j !== undefined && CHO.includes(j);

/**
 * 한영 전환을 잊고 영문 자판으로 친 글자를 한글로 되돌린다 ("rleh" → "기도", "gksk" → "하나").
 * 모든 글자가 온전한 음절로 묶일 때만 돌려주고, 아니면 null (영어 낱말을 한글로 잘못 바꾸지 않게).
 */
export function qwertyToHangul(input: string): string | null {
  if (!/^[a-zA-Z]+$/.test(input)) return null;
  const jamo: string[] = [];
  for (const ch of input) {
    const j = KEY_TO_JAMO[ch] ?? KEY_TO_JAMO[ch.toLowerCase()];
    if (!j) return null;
    jamo.push(j);
  }
  let out = "";
  let i = 0;
  while (i < jamo.length) {
    const cho = jamo[i];
    if (!isConsonant(cho) || !isVowel(jamo[i + 1])) return null;
    let jung = jamo[i + 1];
    i += 2;
    const compound = COMPOUND_VOWEL[jung + (jamo[i] ?? "")];
    if (compound) {
      jung = compound;
      i++;
    }
    let jong = "";
    // 다음 자음 뒤에 모음이 오면 그 자음은 다음 음절의 첫소리다
    if (isConsonant(jamo[i]) && !isVowel(jamo[i + 1]) && JONG.includes(jamo[i])) {
      jong = jamo[i];
      i++;
      const double = COMPOUND_JONG[jong + (jamo[i] ?? "")];
      if (double && isConsonant(jamo[i]) && !isVowel(jamo[i + 1])) {
        jong = double;
        i++;
      }
    }
    out += String.fromCharCode(
      SYLLABLE_FIRST + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + JONG.indexOf(jong),
    );
  }
  return out;
}
