// The preset the setup wizard leaves behind. A fresh install has no presets,
// and a job needs one, so the choices the user just made (models, languages,
// subtitle format) become the default preset instead of a blank first job.

import type { Preset } from "@/types"

export interface WizardChoices {
  selectedWhisperModel: string | null
  selectedLlmModel: string | null
  sourceLanguage: string
  targetLanguage: string
  subtitleFormat: string
}

export function buildWizardPreset(
  choices: WizardChoices,
  text: { name: string; description: string },
  id: string,
  now: string,
): Preset {
  return {
    id,
    name: text.name,
    description: text.description,
    whisper_model: choices.selectedWhisperModel ?? "",
    source_lang: choices.sourceLanguage,
    target_lang: choices.targetLanguage,
    output_format: choices.subtitleFormat,
    translation_style: "natural",
    // Empty: translation was skipped; the job then uses whatever is active.
    llm_model: choices.selectedLlmModel ?? "",
    vocabulary_id: null,
    is_default: true,
    translation_quality: "balanced",
    media_type: "movie",
    translation_mode: "direct",
    pivot_language: "en",
    pivot_vocabulary_id: null,
    created_at: now,
    updated_at: now,
  }
}
