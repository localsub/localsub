import { useState, useCallback } from "react";
import type { AppConfig, PartialConfig, Profile, WizardStep } from "../types";
import { addPreset, getPresets } from "../lib/tauriApi";
import { buildWizardPreset } from "../lib/wizardPreset";
import i18n from "../i18n";

export interface WizardState {
  step: WizardStep;
  profile: Profile;
  outputDir: string;
  subtitleFormat: string;
  sourceLanguage: string;
  targetLanguage: string;
  selectedWhisperModel: string | null;
  selectedLlmModel: string | null;
}

function initState(config: AppConfig): WizardState {
  const step = (config.wizard_step >= 1 && config.wizard_step <= 5
    ? config.wizard_step
    : 1) as WizardStep;
  return {
    step,
    profile: config.profile,
    outputDir: config.output_dir,
    subtitleFormat: config.subtitle_format,
    sourceLanguage: config.source_language,
    targetLanguage: config.target_language,
    selectedWhisperModel: null,
    selectedLlmModel: null,
  };
}

interface UseWizardOptions {
  config: AppConfig;
  onUpdateConfig: (partial: PartialConfig) => Promise<AppConfig>;
}

export function useWizard({ config, onUpdateConfig }: UseWizardOptions) {
  const [state, setState] = useState<WizardState>(() => initState(config));

  const updateState = useCallback(
    (patch: Partial<WizardState>) => {
      setState((prev) => ({ ...prev, ...patch }));
    },
    [],
  );

  const next = useCallback(async () => {
    const configPatch: PartialConfig = { wizard_step: state.step + 1 };

    if (state.step === 2) {
      configPatch.profile = state.profile;
    } else if (state.step === 3) {
      configPatch.output_dir = state.outputDir;
      configPatch.subtitle_format = state.subtitleFormat;
      configPatch.source_language = state.sourceLanguage;
      configPatch.target_language = state.targetLanguage;
    }

    await onUpdateConfig(configPatch);

    if (state.step < 5) {
      setState((prev) => ({ ...prev, step: (prev.step + 1) as WizardStep }));
    }
  }, [state, onUpdateConfig]);

  const back = useCallback(() => {
    if (state.step > 1) {
      setState((prev) => ({ ...prev, step: (prev.step - 1) as WizardStep }));
    }
  }, [state.step]);

  // The models just downloaded become the ones jobs use. Left unset, STT fell
  // back to the first ready manifest entry, which for a Qwen pick is its
  // forced aligner (downloaded first).
  const complete = useCallback(async () => {
    const patch: PartialConfig = { wizard_completed: true, wizard_step: 5 };
    if (state.selectedWhisperModel) patch.active_whisper_model = state.selectedWhisperModel;
    if (state.selectedLlmModel) patch.active_llm_model = state.selectedLlmModel;
    await onUpdateConfig(patch);

    // A job needs a preset and a fresh install has none: save these choices
    // as the default one. Never over existing presets, and a failure here
    // must not keep the user in the wizard (they can still make one).
    if (!state.selectedWhisperModel) return;
    try {
      if ((await getPresets()).length > 0) return;
      await addPreset(
        buildWizardPreset(
          state,
          { name: i18n.t("presets.wizardDefault.name"), description: i18n.t("presets.wizardDefault.description") },
          crypto.randomUUID(),
          new Date().toISOString(),
        ),
      );
    } catch (e) {
      console.error("Failed to create the default preset:", e);
    }
  }, [onUpdateConfig, state]);

  const skip = useCallback(async () => {
    await onUpdateConfig({ wizard_completed: true });
  }, [onUpdateConfig]);

  return { state, updateState, next, back, complete, skip };
}
