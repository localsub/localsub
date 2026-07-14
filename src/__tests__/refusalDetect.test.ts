import { describe, it, expect } from "vitest"
import { detectRefusal } from "@/lib/refusalDetect"

describe("detectRefusal", () => {
  it.each([
    ["", "empty"],
    ["   ", "empty"],
  ])("빈 번역 '%s' → empty", (translated, reason) => {
    expect(detectRefusal("こんにちは、元気ですか", translated)?.reason).toBe(reason)
  })
  it("원문 그대로 복사(10자 이상) → copy", () => {
    const src = "これは長い日本語の文章でテストのためのもの"
    expect(detectRefusal(src, src)?.reason).toBe("copy")
  })
  it("짧은 원문(10자 미만)의 동일 출력은 통과 (숫자/고유명사)", () => {
    expect(detectRefusal("2024", "2024")).toBeNull()
    expect(detectRefusal("OK!", "OK!")).toBeNull()
  })
  it.each([
    "죄송하지만 이 내용은 번역할 수 없습니다",
    "죄송합니다. 도와드릴 수 없습니다",
    "I cannot translate this content.",
    "I'm sorry, but I can't assist with that.",
    "As an AI language model, I cannot help.",
  ])("거부 문구 '%s' → refusal_phrase", (translated) => {
    expect(detectRefusal("何か原文", translated)?.reason).toBe("refusal_phrase")
  })
  it("정상 번역은 null", () => {
    expect(detectRefusal("こんにちは、元気ですか", "안녕하세요, 잘 지내세요?")).toBeNull()
  })
  it("원문 대비 4배 초과 길이 → too_long", () => {
    expect(detectRefusal("短い文です", "아".repeat(50))?.reason).toBe("too_long")
  })
  it("같은 구 5회 이상 반복 → repetition", () => {
    expect(detectRefusal("原文テキストです", "안녕 안녕 안녕 안녕 안녕 안녕")?.reason).toBe("repetition")
  })
  it("거부 문구가 정상 번역의 일부로 등장해도(따옴표 인용) 선두가 아니면 통과", () => {
    expect(detectRefusal("彼は「翻訳できない」と言った", "그는 \"번역할 수 없다\"고 말했다")).toBeNull()
  })
  it("따옴표로 시작하는 대사 번역은 거부로 오탐하지 않는다", () => {
    expect(detectRefusal("「すみませんが行けない」と言った", "\"죄송하지만 못 가요\"라고 말했다")).toBeNull()
  })
  it("원문 자체가 사과인 대사는 거부로 오탐하지 않는다", () => {
    expect(detectRefusal("すみません。", "죄송합니다.")).toBeNull()
    expect(detectRefusal("I'm sorry about that.", "I'm sorry about that... 정말 미안해")).toBeNull()
  })
  it("원문에 사과 단서가 없는데 번역이 사과+거부면 여전히 탐지한다", () => {
    expect(detectRefusal("この場面の説明", "죄송하지만 번역할 수 없습니다")?.reason).toBe("refusal_phrase")
  })
  it("따옴표 안의 완전한 거부 문구 인용은 통과한다", () => {
    expect(detectRefusal("彼は「手伝えません」と言った", "그는 \"도와드릴 수 없습니다\"라고 했다")).toBeNull()
  })
})
