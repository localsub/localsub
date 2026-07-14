import type { SubtitleLine } from "../types";

/** Default number of translated segments between checkpoint saves. */
export const CHECKPOINT_INTERVAL = 25;

/**
 * True when `doneCount` translated segments warrant a checkpoint save —
 * i.e. at every positive multiple of `interval` (25, 50, 75, …).
 */
export function shouldCheckpoint(doneCount: number, interval = CHECKPOINT_INTERVAL): boolean {
  if (interval <= 0) return false;
  return doneCount > 0 && doneCount % interval === 0;
}

// NOTE: 재개 시 미번역 분류는 count 위치 기반 슬라이스가 아니라 라인 status
// 필터를 쓴다(App.tsx handleResumeJob) — 중간 세그먼트가 실패해 갭이 있어도
// 안전하기 때문. 위치 기반 sliceRemaining은 그 취약성 때문에 제거됐다.

/**
 * Merge previously translated lines (`base`) with the lines of the current
 * (resumed) pipeline run. On duplicate `index`, `current` wins. The result
 * is sorted by `index`; neither input is mutated.
 *
 * Named `mergeCheckpointLines` to avoid colliding with the two-cue
 * `mergeLines` editor operation in `subtitleOps.ts`.
 */
export function mergeCheckpointLines(
  base: SubtitleLine[],
  current: SubtitleLine[],
): SubtitleLine[] {
  const byIndex = new Map<number, SubtitleLine>();
  for (const line of base) byIndex.set(line.index, line);
  for (const line of current) byIndex.set(line.index, line);
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}
