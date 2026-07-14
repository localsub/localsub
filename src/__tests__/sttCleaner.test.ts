import { describe, it, expect } from "vitest";
import { cleanText, cleanSttSegments, isLikelyHallucination } from "@/lib/sttCleaner";

describe("cleanText", () => {
  it("collapses repeated single characters (5+)", () => {
    expect(cleanText("아아아아아아아아")).toBe("아");
    expect(cleanText("hhhhhhhhh")).toBe("h");
    expect(cleanText("하하하하하하")).toBe("하");
    // Short repeats (< 5) are preserved
    expect(cleanText("aaa")).toBe("aaa");
  });

  it("collapses repeated syllable groups (3+)", () => {
    expect(cleanText("lalalalala")).toBe("la");
    expect(cleanText("냐옹냐옹냐옹")).toBe("냐옹");
  });

  it("collapses repeated phrases (3+)", () => {
    expect(cleanText("Thank you. Thank you. Thank you. Thank you.")).toBe("Thank you.");
    expect(cleanText("감사합니다. 감사합니다. 감사합니다.")).toBe("감사합니다.");
  });

  it("removes punctuation-only noise", () => {
    expect(cleanText("...")).toBe("");
    expect(cleanText("   ---   ")).toBe("");
    expect(cleanText("~~~~~")).toBe("");
  });

  it("preserves normal text", () => {
    expect(cleanText("Hello, how are you?")).toBe("Hello, how are you?");
    expect(cleanText("안녕하세요, 반갑습니다.")).toBe("안녕하세요, 반갑습니다.");
  });

  it("handles empty string", () => {
    expect(cleanText("")).toBe("");
    expect(cleanText("   ")).toBe("");
  });

  it("cleans noise within a sentence", () => {
    // "aaaaaaa" (7 a's) → "a"
    expect(cleanText("So aaaaaaa I said hello")).toBe("So a I said hello");
  });
});

describe("cleanSttSegments", () => {
  it("removes empty segments after cleaning", () => {
    const segments = [
      { index: 0, start: 0, end: 1, text: "Hello world" },
      { index: 1, start: 1, end: 2, text: "............" },
      { index: 2, start: 2, end: 3, text: "Good morning" },
    ];
    const result = cleanSttSegments(segments);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Hello world");
    expect(result[1].text).toBe("Good morning");
  });

  it("cleans but keeps segments with remaining text", () => {
    const segments = [
      { index: 0, start: 0, end: 1, text: "아아아아아아아 좋아요" },
    ];
    const result = cleanSttSegments(segments);
    expect(result).toHaveLength(1);
    expect(result[0].text).toBe("아 좋아요");
  });

  it("preserves all clean segments", () => {
    const segments = [
      { index: 0, start: 0, end: 1, text: "First line" },
      { index: 1, start: 1, end: 2, text: "Second line" },
    ];
    const result = cleanSttSegments(segments);
    expect(result).toHaveLength(2);
  });
});

describe("isLikelyHallucination", () => {
  it("detects empty text", () => {
    expect(isLikelyHallucination("")).toBe(true);
    expect(isLikelyHallucination("   ")).toBe(true);
  });

  it("detects very long text", () => {
    expect(isLikelyHallucination("a".repeat(501))).toBe(true);
  });

  it("detects dominant single character", () => {
    expect(isLikelyHallucination("aaaaaaaaab")).toBe(true);
  });

  it("passes normal text", () => {
    expect(isLikelyHallucination("Hello, how are you?")).toBe(false);
    expect(isLikelyHallucination("안녕하세요")).toBe(false);
  });
});
