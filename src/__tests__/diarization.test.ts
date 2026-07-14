import { describe, it, expect } from "vitest";
import { splitLine, mergeLines, reindex } from "@/lib/subtitleOps";
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

describe("speaker field in SubtitleLine", () => {
  it("speaker is optional and defaults to undefined", () => {
    const line = makeLine();
    expect(line.speaker).toBeUndefined();
  });

  it("speaker can be set to a string value", () => {
    const line = makeLine({ speaker: "SPEAKER_0" });
    expect(line.speaker).toBe("SPEAKER_0");
  });
});

describe("splitLine preserves speaker", () => {
  it("both halves inherit the speaker label", () => {
    const line = makeLine({
      speaker: "SPEAKER_1",
      start_time: 0,
      end_time: 4,
      original_text: "Hello world",
    });
    const [first, second] = splitLine(line, 2);
    expect(first.speaker).toBe("SPEAKER_1");
    expect(second.speaker).toBe("SPEAKER_1");
  });

  it("both halves have undefined speaker when original has none", () => {
    const line = makeLine({ start_time: 0, end_time: 4 });
    const [first, second] = splitLine(line, 2);
    expect(first.speaker).toBeUndefined();
    expect(second.speaker).toBeUndefined();
  });
});

describe("mergeLines preserves speaker", () => {
  it("merged line keeps first line speaker", () => {
    const first = makeLine({ speaker: "SPEAKER_0" });
    const second = makeLine({ speaker: "SPEAKER_0" });
    const merged = mergeLines(first, second);
    expect(merged.speaker).toBe("SPEAKER_0");
  });

  it("merged line keeps first line speaker even if different", () => {
    const first = makeLine({ speaker: "SPEAKER_0" });
    const second = makeLine({ speaker: "SPEAKER_1" });
    const merged = mergeLines(first, second);
    expect(merged.speaker).toBe("SPEAKER_0");
  });

  it("merged line has no speaker when first has none", () => {
    const first = makeLine();
    const second = makeLine({ speaker: "SPEAKER_1" });
    const merged = mergeLines(first, second);
    expect(merged.speaker).toBeUndefined();
  });
});

describe("reindex preserves speaker", () => {
  it("speaker is preserved after reindex", () => {
    const lines = [
      makeLine({ index: 5, speaker: "SPEAKER_0" }),
      makeLine({ index: 10, speaker: "SPEAKER_1" }),
      makeLine({ index: 3 }),
    ];
    const result = reindex(lines);
    expect(result[0].speaker).toBe("SPEAKER_0");
    expect(result[1].speaker).toBe("SPEAKER_1");
    expect(result[2].speaker).toBeUndefined();
  });
});

describe("JobStage type", () => {
  it("diarizing is a valid stage", () => {
    // Type-level check — if this compiles, it works
    const stage: import("@/types").JobStage = "diarizing";
    expect(stage).toBe("diarizing");
  });
});

describe("DiarizationSegment type", () => {
  it("has index and speaker fields", () => {
    const seg: import("@/types").DiarizationSegment = {
      index: 0,
      speaker: "SPEAKER_0",
    };
    expect(seg.index).toBe(0);
    expect(seg.speaker).toBe("SPEAKER_0");
  });
});
