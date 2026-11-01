/**
 * Languages offered for speech recognition and translation (Whisper codes).
 * The setup wizard and Settings both read these lists, so a language picked
 * in one always shows in the other.
 */
export const LANGUAGES = [
  "en", "ko", "ja", "zh", "es", "fr", "de", "pt", "ru", "ar",
] as const;

/**
 * "auto" is the config default: Whisper detects the language itself. Without
 * it a select shows blank for the default and can't go back to it. Source
 * only; a translation needs a fixed target.
 */
export const SOURCE_LANGUAGES = ["auto", ...LANGUAGES] as const;
