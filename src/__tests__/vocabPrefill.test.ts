import { describe, it, expect } from "vitest"
import { buildVocabPrefill, VOCAB_PREFILL_MAX_LENGTH } from "@/lib/vocabPrefill"

describe("buildVocabPrefill", () => {
  it("original 선택 → source에 배치, target은 빈 문자열", () => {
    expect(buildVocabPrefill("Nakamura", "original")).toEqual({
      source: "Nakamura",
      target: "",
    })
  })

  it("translated 선택 → target에 배치, source는 빈 문자열", () => {
    expect(buildVocabPrefill("나카무라", "translated")).toEqual({
      source: "",
      target: "나카무라",
    })
  })

  it("앞뒤 공백은 트림된다", () => {
    expect(buildVocabPrefill("  중간 보스  ", "original")).toEqual({
      source: "중간 보스",
      target: "",
    })
  })

  it("빈 문자열 → null", () => {
    expect(buildVocabPrefill("", "original")).toBeNull()
  })

  it("공백만 있는 선택 → null", () => {
    expect(buildVocabPrefill("   \n\t  ", "translated")).toBeNull()
  })

  it("80자 초과 시 앞쪽 80자 유지 후 트림", () => {
    const long = "a".repeat(79) + " bcdefg"
    const result = buildVocabPrefill(long, "original")
    expect(result).not.toBeNull()
    // 80자로 컷하면 'a'*79 + ' ' → 트림 후 'a'*79
    expect(result!.source).toBe("a".repeat(79))
    expect(result!.source.length).toBeLessThanOrEqual(VOCAB_PREFILL_MAX_LENGTH)
  })

  it("정확히 80자는 그대로 유지", () => {
    const exact = "b".repeat(VOCAB_PREFILL_MAX_LENGTH)
    expect(buildVocabPrefill(exact, "original")!.source).toBe(exact)
  })

  it("개행은 공백 하나로 정규화된다", () => {
    expect(buildVocabPrefill("first\nsecond\r\nthird", "original")).toEqual({
      source: "first second third",
      target: "",
    })
  })

  it("개행 + 연속 공백도 공백 하나로 합쳐진다", () => {
    expect(buildVocabPrefill("a \n  b", "translated")).toEqual({
      source: "",
      target: "a b",
    })
  })
})
