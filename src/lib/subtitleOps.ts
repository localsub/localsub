import type { SubtitleLine } from "@/types"

/** Reindex lines sequentially starting from 1 */
export function reindex(lines: SubtitleLine[]): SubtitleLine[] {
  return lines.map((l, i) => ({ ...l, index: i + 1 }))
}

/** Find a good position to split text: sentence boundary > word boundary > midpoint */
export function findSplitPosition(text: string): number {
  const mid = Math.floor(text.length / 2)
  if (text.length === 0) return 0

  // Sentence boundary near the middle
  const sentenceBreaks = /[.!?。！？]\s*/g
  let best = -1
  let bestDist = Infinity
  let match: RegExpExecArray | null
  while ((match = sentenceBreaks.exec(text)) !== null) {
    const pos = match.index + match[0].length
    const dist = Math.abs(pos - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = pos
    }
  }
  if (best > 0 && best < text.length) return best

  // Word boundary near the middle
  const wordBreaks = /\s+/g
  best = -1
  bestDist = Infinity
  while ((match = wordBreaks.exec(text)) !== null) {
    const pos = match.index
    const dist = Math.abs(pos - mid)
    if (dist < bestDist) {
      bestDist = dist
      best = pos
    }
  }
  if (best > 0 && best < text.length) return best

  // Fallback to midpoint
  return mid
}

/** Split a subtitle line at the given time into two new lines */
export function splitLine(line: SubtitleLine, splitTime: number): [SubtitleLine, SubtitleLine] {
  const splitPos = findSplitPosition(line.original_text)
  const firstText = line.original_text.slice(0, splitPos).trim()
  const secondText = line.original_text.slice(splitPos).trim()

  // Split translated text at the same proportional position
  let firstTranslated = ""
  let secondTranslated = ""
  if (line.translated_text) {
    const translatedSplitPos = findSplitPosition(line.translated_text)
    firstTranslated = line.translated_text.slice(0, translatedSplitPos).trim()
    secondTranslated = line.translated_text.slice(translatedSplitPos).trim()
  }

  const first: SubtitleLine = {
    id: crypto.randomUUID(),
    index: line.index,
    start_time: line.start_time,
    end_time: splitTime,
    original_text: firstText,
    translated_text: firstTranslated,
    speaker: line.speaker,
    status: "editing",
  }

  const second: SubtitleLine = {
    id: crypto.randomUUID(),
    index: line.index + 1,
    start_time: splitTime,
    end_time: line.end_time,
    original_text: secondText,
    translated_text: secondTranslated,
    speaker: line.speaker,
    status: "editing",
  }

  return [first, second]
}

/** Merge two consecutive subtitle lines into one */
export function mergeLines(first: SubtitleLine, second: SubtitleLine): SubtitleLine {
  const mergedOriginal = [first.original_text, second.original_text].filter(Boolean).join(" ")
  const mergedTranslated = [first.translated_text, second.translated_text].filter(Boolean).join(" ")

  return {
    id: first.id,
    index: first.index,
    start_time: first.start_time,
    end_time: second.end_time,
    original_text: mergedOriginal,
    translated_text: mergedTranslated,
    speaker: first.speaker,
    status: "editing",
  }
}

/** Get the split time: use playhead if within range, otherwise midpoint */
export function getSplitTime(line: SubtitleLine, currentTime: number): number {
  if (currentTime > line.start_time && currentTime < line.end_time) {
    return currentTime
  }
  return (line.start_time + line.end_time) / 2
}

/** Whether a line can be split (duration >= 0.5s) */
export function canSplit(line: SubtitleLine): boolean {
  return (line.end_time - line.start_time) >= 0.5
}

/**
 * Shift line timings by deltaSeconds (negative = earlier).
 * Start times are clamped to 0; a minimum 0.1s duration is preserved.
 * When `range` is given, only lines with array index in [from, to] are shifted.
 */
export function shiftLines(
  lines: SubtitleLine[],
  deltaSeconds: number,
  range?: { from: number; to: number },
): SubtitleLine[] {
  const MIN_DURATION = 0.1
  return lines.map((line, i) => {
    if (range && (i < range.from || i > range.to)) return line
    const start = Math.max(0, line.start_time + deltaSeconds)
    const end = Math.max(line.end_time + deltaSeconds, start + MIN_DURATION)
    return { ...line, start_time: start, end_time: end }
  })
}

/** Whether a line can be merged with the next (not the last line) */
export function canMerge(line: SubtitleLine, lines: SubtitleLine[]): boolean {
  if (lines.length <= 1) return false
  const idx = lines.findIndex((l) => l.id === line.id)
  return idx >= 0 && idx < lines.length - 1
}
