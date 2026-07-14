/**
 * Prefill helper for the editor's "add selection to vocabulary" flow.
 *
 * Takes the raw text the user selected in a subtitle row and decides
 * which side of a vocabulary entry it should land on.
 */

export const VOCAB_PREFILL_MAX_LENGTH = 80

export type VocabPrefillSide = "original" | "translated"

export interface VocabPrefill {
  source: string
  target: string
}

/**
 * Normalize a text selection into a vocabulary-entry prefill.
 *
 * - Newlines (and surrounding runs of whitespace) collapse to a single space
 * - Leading/trailing whitespace is trimmed
 * - Selections longer than {@link VOCAB_PREFILL_MAX_LENGTH} keep the head and
 *   are re-trimmed so the cut never ends in a dangling space
 * - Returns `null` when nothing usable remains
 */
export function buildVocabPrefill(selection: string, side: VocabPrefillSide): VocabPrefill | null {
  let text = selection.replace(/\s+/g, " ").trim()
  if (text.length === 0) return null

  if (text.length > VOCAB_PREFILL_MAX_LENGTH) {
    text = text.slice(0, VOCAB_PREFILL_MAX_LENGTH).trim()
  }

  return side === "original"
    ? { source: text, target: "" }
    : { source: "", target: text }
}
