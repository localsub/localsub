import { describe, it, expect } from "vitest";
import {
  reindex,
  findSplitPosition,
  splitLine,
  mergeLines,
  getSplitTime,
  canSplit,
  canMerge,
  shiftLines,
} from "@/lib/subtitleOps";
import type { SubtitleLine } from "@/types";

function makeLine(overrides: Partial<SubtitleLine> = {}): SubtitleLine {
  return {
    id: crypto.randomUUID(),
    index: 1,
    start_time: 0,
    end_time: 2,
    original_text: "Hello world",
    translated_text: "",
    status: "untranslated",
    ...overrides,
  };
}

describe("reindex", () => {
  it("assigns sequential indices starting from 1", () => {
    const lines = [makeLine({ index: 5 }), makeLine({ index: 10 }), makeLine({ index: 3 })];
    const result = reindex(lines);
    expect(result.map((l) => l.index)).toEqual([1, 2, 3]);
  });

  it("returns empty array for empty input", () => {
    expect(reindex([])).toEqual([]);
  });
});

describe("findSplitPosition", () => {
  it("splits at sentence boundary", () => {
    const pos = findSplitPosition("Hello world. How are you?");
    // Should split after "Hello world. "
    expect(pos).toBe(13);
  });

  it("splits at word boundary when no sentence break", () => {
    const pos = findSplitPosition("Hello wonderful world");
    // Should split at a space near the middle
    expect(pos).toBeGreaterThan(0);
    expect(pos).toBeLessThan(21);
    // The character at pos should be a space (word boundary)
    expect("Hello wonderful world"[pos]).toBe(" ");
  });

  it("returns midpoint for single word", () => {
    const pos = findSplitPosition("Supercalifragilistic");
    expect(pos).toBe(10); // midpoint
  });

  it("returns 0 for empty string", () => {
    expect(findSplitPosition("")).toBe(0);
  });
});

describe("splitLine", () => {
  it("creates two lines with correct timing", () => {
    const line = makeLine({ start_time: 1, end_time: 5, original_text: "Hello world" });
    const [first, second] = splitLine(line, 3);

    expect(first.start_time).toBe(1);
    expect(first.end_time).toBe(3);
    expect(second.start_time).toBe(3);
    expect(second.end_time).toBe(5);
  });

  it("splits text into non-empty parts", () => {
    const line = makeLine({ original_text: "Hello world" });
    const [first, second] = splitLine(line, 1);

    expect(first.original_text.length).toBeGreaterThan(0);
    expect(second.original_text.length).toBeGreaterThan(0);
    expect(`${first.original_text} ${second.original_text}`).toBe("Hello world");
  });

  it("generates unique IDs for both parts", () => {
    const line = makeLine();
    const [first, second] = splitLine(line, 1);
    expect(first.id).not.toBe(second.id);
    expect(first.id).not.toBe(line.id);
  });

  it("sets status to editing for both parts", () => {
    const line = makeLine({ status: "translated" });
    const [first, second] = splitLine(line, 1);
    expect(first.status).toBe("editing");
    expect(second.status).toBe("editing");
  });

  it("splits translated text too", () => {
    const line = makeLine({
      original_text: "Hello world",
      translated_text: "안녕 세계",
    });
    const [first, second] = splitLine(line, 1);
    expect(first.translated_text.length).toBeGreaterThan(0);
    expect(second.translated_text.length).toBeGreaterThan(0);
  });
});

describe("mergeLines", () => {
  it("merges text and timing", () => {
    const first = makeLine({ start_time: 0, end_time: 2, original_text: "Hello" });
    const second = makeLine({ start_time: 2, end_time: 5, original_text: "world" });
    const merged = mergeLines(first, second);

    expect(merged.start_time).toBe(0);
    expect(merged.end_time).toBe(5);
    expect(merged.original_text).toBe("Hello world");
  });

  it("keeps first line ID and index", () => {
    const first = makeLine({ index: 3 });
    const second = makeLine({ index: 4 });
    const merged = mergeLines(first, second);

    expect(merged.id).toBe(first.id);
    expect(merged.index).toBe(3);
  });

  it("merges translated text", () => {
    const first = makeLine({ translated_text: "안녕" });
    const second = makeLine({ translated_text: "세계" });
    const merged = mergeLines(first, second);
    expect(merged.translated_text).toBe("안녕 세계");
  });

  it("handles empty translated text", () => {
    const first = makeLine({ translated_text: "" });
    const second = makeLine({ translated_text: "world" });
    const merged = mergeLines(first, second);
    expect(merged.translated_text).toBe("world");
  });

  it("sets status to editing", () => {
    const merged = mergeLines(makeLine(), makeLine());
    expect(merged.status).toBe("editing");
  });
});

describe("getSplitTime", () => {
  it("returns playhead time when within range", () => {
    const line = makeLine({ start_time: 1, end_time: 5 });
    expect(getSplitTime(line, 3)).toBe(3);
  });

  it("returns midpoint when playhead is outside range", () => {
    const line = makeLine({ start_time: 2, end_time: 6 });
    expect(getSplitTime(line, 0)).toBe(4);
    expect(getSplitTime(line, 10)).toBe(4);
  });

  it("returns midpoint when playhead is at boundary", () => {
    const line = makeLine({ start_time: 2, end_time: 6 });
    expect(getSplitTime(line, 2)).toBe(4); // at start_time, not strictly inside
    expect(getSplitTime(line, 6)).toBe(4); // at end_time
  });
});

describe("canSplit", () => {
  it("returns true for lines >= 0.5s", () => {
    expect(canSplit(makeLine({ start_time: 0, end_time: 0.5 }))).toBe(true);
    expect(canSplit(makeLine({ start_time: 0, end_time: 2 }))).toBe(true);
  });

  it("returns false for lines < 0.5s", () => {
    expect(canSplit(makeLine({ start_time: 0, end_time: 0.3 }))).toBe(false);
    expect(canSplit(makeLine({ start_time: 0, end_time: 0 }))).toBe(false);
  });
});

describe("shiftLines", () => {
  const mkLine = (index: number, start: number, end: number) =>
    makeLine({ index, start_time: start, end_time: end });

  it("빈 배열이면 빈 배열을 반환한다", () => {
    expect(shiftLines([], 1.0)).toEqual([]);
  });

  it("전체 라인을 +2.5초 이동한다", () => {
    const lines = [mkLine(0, 1.0, 2.0), mkLine(1, 3.0, 4.0)];
    const out = shiftLines(lines, 2.5);
    expect(out[0].start_time).toBeCloseTo(3.5);
    expect(out[0].end_time).toBeCloseTo(4.5);
    expect(out[1].start_time).toBeCloseTo(5.5);
  });

  it("음수 이동 시 0 미만은 0으로 클램프한다", () => {
    const out = shiftLines([mkLine(0, 1.0, 3.0)], -2.0);
    expect(out[0].start_time).toBe(0);
    expect(out[0].end_time).toBeCloseTo(1.0); // start만 클램프, end는 정상 이동
  });

  it("end까지 0에 눌리면 최소 0.1초 길이를 보장한다", () => {
    const out = shiftLines([mkLine(0, 0.5, 1.0)], -5.0);
    expect(out[0].start_time).toBe(0);
    expect(out[0].end_time).toBeCloseTo(0.1);
  });

  it("range 지정 시 해당 인덱스 구간만 이동한다", () => {
    const lines = [mkLine(0, 1, 2), mkLine(1, 3, 4), mkLine(2, 5, 6)];
    const out = shiftLines(lines, 1.0, { from: 1, to: 1 });
    expect(out[0].start_time).toBe(1);
    expect(out[1].start_time).toBe(4);
    expect(out[2].start_time).toBe(5);
  });

  it("원본 배열을 변경하지 않는다 (불변)", () => {
    const lines = [mkLine(0, 1, 2)];
    shiftLines(lines, 1.0);
    expect(lines[0].start_time).toBe(1);
  });
});

describe("canMerge", () => {
  it("returns true when line is not last", () => {
    const lines = [makeLine({ index: 1 }), makeLine({ index: 2 })];
    expect(canMerge(lines[0], lines)).toBe(true);
  });

  it("returns false for last line", () => {
    const lines = [makeLine({ index: 1 }), makeLine({ index: 2 })];
    expect(canMerge(lines[1], lines)).toBe(false);
  });

  it("returns false for single line", () => {
    const lines = [makeLine()];
    expect(canMerge(lines[0], lines)).toBe(false);
  });

  it("returns false for empty lines", () => {
    expect(canMerge(makeLine(), [])).toBe(false);
  });
});
