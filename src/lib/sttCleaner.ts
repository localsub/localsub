import type { SttSegment } from "@/types";

/**
 * Clean STT segments by removing hallucinations and noise.
 * Applied after STT completes, before translation.
 */
export function cleanSttSegments(segments: SttSegment[]): SttSegment[] {
  const deduped = deduplicateSegments(segments);
  return deduped
    .map((seg) => ({ ...seg, text: cleanText(seg.text) }))
    .filter((seg) => seg.text.length > 0)
    .map((seg, i) => ({ ...seg, index: i })); // re-index sequentially
}

/** Remove duplicate segments with same timing and text */
function deduplicateSegments(segments: SttSegment[]): SttSegment[] {
  if (segments.length === 0) return segments;
  const sorted = [...segments].sort((a, b) => a.start - b.start || a.index - b.index);
  const result: SttSegment[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1];
    const curr = sorted[i];
    const sameTime = Math.abs(prev.start - curr.start) < 0.05 && Math.abs(prev.end - curr.end) < 0.05;
    const sameText = prev.text === curr.text;
    if (sameTime && sameText) continue; // skip duplicate
    result.push(curr);
  }
  return result;
}

/** Clean a single text string */
export function cleanText(text: string): string {
  let cleaned = text.trim();

  // 1. Collapse repeated single characters (5+ → 1)
  //    "아아아아아아아" → "아", "hhhhhhhhh" → "h"
  cleaned = cleaned.replace(/(.)\1{4,}/g, "$1");

  // 2. Collapse repeated syllable groups (3+ → 1)
  //    "lalalalala" → "la", "ㅋㅋㅋㅋㅋㅋ" → "ㅋㅋ" (after step 1)
  cleaned = cleaned.replace(/(.{2,4})\1{2,}/g, "$1");

  // 3. Collapse repeated sentences/phrases (3+ → 1)
  //    "Thank you. Thank you. Thank you." → "Thank you."
  cleaned = cleaned.replace(/(.{3,40}?[.!?。！？])\s*(?:\1\s*){2,}/g, "$1");

  // 4. Remove segments that are just punctuation/whitespace noise
  cleaned = cleaned.replace(/^[\s.,!?…·\-_*#@~]+$/, "");

  return cleaned.trim();
}

/** Check if a segment looks like hallucination (for flagging) */
export function isLikelyHallucination(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;

  // Extremely long single segment (>500 chars) is suspicious
  if (trimmed.length > 500) return true;

  // More than 70% is the same character
  const charCounts = new Map<string, number>();
  for (const ch of trimmed) {
    charCounts.set(ch, (charCounts.get(ch) ?? 0) + 1);
  }
  const maxCount = Math.max(...charCounts.values());
  if (maxCount / trimmed.length > 0.7) return true;

  return false;
}
