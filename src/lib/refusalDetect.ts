// Heuristics for spotting LLM translation failures: refusal boilerplate,
// verbatim source copies, runaway/looping output, empty results.
// Pure derived-data — callers recompute when original/translated change.

export type RefusalReason = "empty" | "copy" | "refusal_phrase" | "too_long" | "repetition"

export interface RefusalHit {
  reason: RefusalReason
}

// 선두에서 시작하는 거부 문구만 매칭. 의도적으로 인용부호를 선두 허용 문자에서
// 제외한다 — 따옴표로 시작하면 대사 번역일 가능성이 높아 오탐 방지가 우선.
const ANCHORED_PATTERNS: RegExp[] = [
  /^\s*죄송(하지만|합니다)/,
  /^\s*(이|해당)?\s*내용(은|을)?\s*번역할 수 없/,
  /^\s*I\s+(cannot|can't)\b/i,
  /^\s*I'?m sorry\b/i,
  /^\s*As an AI\b/i,
  /^\s*Sorry,? (but )?I\b/i,
]

// 위치 무관 패턴 — 단, 매칭 위치 앞에 인용부호가 있으면 인용으로 보고 제외
const FLOATING_PATTERNS: RegExp[] = [/번역할 수 없습니다/, /도와드릴 수 없/]

// 원문 자체에 사과 단서가 있으면 번역의 사과 표현은 대사일 가능성이 높다 —
// refusal_phrase 검사를 통째로 건너뛰어 오탐을 막는다.
const APOLOGY_CUE = /すみません|ごめん|申し訳|sorry|미안|죄송|对不起|lo siento/i

export function detectRefusal(original: string, translated: string): RefusalHit | null {
  const t = translated.trim()
  if (t.length === 0) return { reason: "empty" }

  if (!APOLOGY_CUE.test(original)) {
    for (const p of ANCHORED_PATTERNS) {
      if (p.test(t)) return { reason: "refusal_phrase" }
    }
    for (const p of FLOATING_PATTERNS) {
      const m = t.match(p)
      if (m && m.index !== undefined && !/["'「『]/.test(t.slice(0, m.index))) {
        return { reason: "refusal_phrase" }
      }
    }
  }

  const o = original.trim()
  // 짧은 원문(숫자, 고유명사 등)은 동일 출력이 정상일 수 있어 제외
  if (o.length >= 10 && t === o) return { reason: "copy" }
  // 원문 대비 폭주 출력 — 절대 길이 하한으로 짧은 라인 오탐 방지
  if (o.length > 0 && t.length > o.length * 4 && t.length > 40) return { reason: "too_long" }

  const tokens = t.split(/\s+/)
  if (tokens.length >= 5) {
    const counts = new Map<string, number>()
    for (const tok of tokens) counts.set(tok, (counts.get(tok) ?? 0) + 1)
    const max = Math.max(...counts.values())
    if (max >= 5 && max / tokens.length > 0.6) return { reason: "repetition" }
  }

  return null
}
