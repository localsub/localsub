import { describe, it, expect } from "vitest";
import { shouldCheckpoint, mergeCheckpointLines } from "@/lib/checkpoint";
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

describe("shouldCheckpoint", () => {
  it("returns true at exact interval multiples", () => {
    expect(shouldCheckpoint(25)).toBe(true);
    expect(shouldCheckpoint(50)).toBe(true);
    expect(shouldCheckpoint(75)).toBe(true);
    expect(shouldCheckpoint(250)).toBe(true);
  });

  it("returns false between interval multiples", () => {
    expect(shouldCheckpoint(1)).toBe(false);
    expect(shouldCheckpoint(24)).toBe(false);
    expect(shouldCheckpoint(26)).toBe(false);
    expect(shouldCheckpoint(49)).toBe(false);
  });

  it("returns false for zero", () => {
    expect(shouldCheckpoint(0)).toBe(false);
  });

  it("returns false for negative counts", () => {
    expect(shouldCheckpoint(-25)).toBe(false);
  });

  it("respects a custom interval", () => {
    expect(shouldCheckpoint(10, 10)).toBe(true);
    expect(shouldCheckpoint(20, 10)).toBe(true);
    expect(shouldCheckpoint(25, 10)).toBe(false);
  });

  it("returns false for non-positive intervals", () => {
    expect(shouldCheckpoint(25, 0)).toBe(false);
    expect(shouldCheckpoint(25, -5)).toBe(false);
  });
});

describe("mergeCheckpointLines", () => {
  it("merges disjoint sets sorted by index", () => {
    const base = [
      makeLine({ index: 1, translated_text: "안녕", status: "translated" }),
      makeLine({ index: 2, translated_text: "세상", status: "translated" }),
    ];
    const current = [makeLine({ index: 3 }), makeLine({ index: 4 })];
    const merged = mergeCheckpointLines(base, current);
    expect(merged.map((l) => l.index)).toEqual([1, 2, 3, 4]);
    expect(merged[0].translated_text).toBe("안녕");
  });

  it("prefers current over base on duplicate index", () => {
    const base = [makeLine({ index: 2, translated_text: "old", status: "translated" })];
    const current = [makeLine({ index: 2, translated_text: "new", status: "translated" })];
    const merged = mergeCheckpointLines(base, current);
    expect(merged).toHaveLength(1);
    expect(merged[0].translated_text).toBe("new");
  });

  it("sorts interleaved indices", () => {
    const base = [makeLine({ index: 3 }), makeLine({ index: 1 })];
    const current = [makeLine({ index: 4 }), makeLine({ index: 2 })];
    const merged = mergeCheckpointLines(base, current);
    expect(merged.map((l) => l.index)).toEqual([1, 2, 3, 4]);
  });

  it("returns current when base is empty", () => {
    const current = [makeLine({ index: 2 }), makeLine({ index: 1 })];
    const merged = mergeCheckpointLines([], current);
    expect(merged.map((l) => l.index)).toEqual([1, 2]);
  });

  it("returns base when current is empty", () => {
    const base = [makeLine({ index: 1, translated_text: "x", status: "translated" })];
    const merged = mergeCheckpointLines(base, []);
    expect(merged).toHaveLength(1);
    expect(merged[0].translated_text).toBe("x");
  });

  it("returns empty array when both are empty", () => {
    expect(mergeCheckpointLines([], [])).toEqual([]);
  });

  it("does not mutate inputs", () => {
    const base = [makeLine({ index: 2 }), makeLine({ index: 1 })];
    const current = [makeLine({ index: 2, translated_text: "n" })];
    const baseSnapshot = base.map((l) => l.index);
    mergeCheckpointLines(base, current);
    expect(base.map((l) => l.index)).toEqual(baseSnapshot);
    expect(base[0].translated_text).toBe("");
  });

  it("keeps base line fields intact for non-overlapping indices", () => {
    const base = [
      makeLine({ index: 1, translated_text: "기존 번역", status: "translated", speaker: "S1" }),
    ];
    const current = [makeLine({ index: 2 })];
    const merged = mergeCheckpointLines(base, current);
    expect(merged[0].translated_text).toBe("기존 번역");
    expect(merged[0].speaker).toBe("S1");
    expect(merged[0].status).toBe("translated");
  });
});
