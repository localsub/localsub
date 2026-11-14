import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * Finishing the setup wizard left active_whisper_model / active_llm_model
 * unset, so jobs fell back to the first ready manifest entry: for a Qwen pick
 * that is its forced aligner, which is not a speech recognition model.
 * It also left no preset, and a job cannot start without one.
 */

const api = vi.hoisted(() => ({
  getPresets: vi.fn(async () => [] as unknown[]),
  addPreset: vi.fn(async (p: unknown) => [p]),
}));

vi.mock("@/lib/tauriApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauriApi")>()),
  getPresets: api.getPresets,
  addPreset: api.addPreset,
}));

import i18n from "@/i18n";
import { useWizard } from "@/hooks/useWizard";
import type { AppConfig, Preset } from "@/types";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

const config = {
  wizard_step: 5, profile: "balanced", output_dir: "C:/out", subtitle_format: "vtt",
  source_language: "auto", target_language: "ko",
} as unknown as AppConfig;

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  api.getPresets.mockReset().mockResolvedValue([]);
  api.addPreset.mockReset().mockImplementation(async (p: unknown) => [p]);
});

function setup() {
  const onUpdateConfig = vi.fn().mockResolvedValue(config);
  const { result } = renderHook(() => useWizard({ config, onUpdateConfig }));
  return { result, onUpdateConfig };
}

async function finish(result: ReturnType<typeof setup>["result"], whisper: string | null, llm: string | null) {
  act(() => result.current.updateState({ selectedWhisperModel: whisper, selectedLlmModel: llm }));
  await act(() => result.current.complete());
}

describe("wizard completion", () => {
  it("makes the downloaded models the active ones", async () => {
    const { result, onUpdateConfig } = setup();
    await finish(result, "qwen3-asr-0.6b", "qwen35-9b-q5km");
    expect(onUpdateConfig).toHaveBeenCalledWith({
      wizard_completed: true,
      wizard_step: 5,
      active_whisper_model: "qwen3-asr-0.6b",
      active_llm_model: "qwen35-9b-q5km",
    });
  });

  it("leaves the LLM alone when translation was skipped", async () => {
    const { result, onUpdateConfig } = setup();
    await finish(result, "whisper-small", null);
    const patch = onUpdateConfig.mock.calls[0][0];
    expect(patch.active_whisper_model).toBe("whisper-small");
    expect(patch).not.toHaveProperty("active_llm_model");
  });

  it("saves the choices as the default preset on a fresh install", async () => {
    const { result } = setup();
    await finish(result, "qwen3-asr-0.6b", "qwen35-9b-q5km");
    expect(api.addPreset).toHaveBeenCalledTimes(1);
    const preset = api.addPreset.mock.calls[0][0] as Preset;
    expect(preset).toMatchObject({
      name: en.presets.wizardDefault.name,
      whisper_model: "qwen3-asr-0.6b",
      llm_model: "qwen35-9b-q5km",
      source_lang: "auto",
      target_lang: "ko",
      output_format: "vtt",
      is_default: true,
      translation_mode: "direct",
    });
  });

  it("never adds a preset over existing ones", async () => {
    api.getPresets.mockResolvedValue([{ id: "mine" }]);
    const { result } = setup();
    await finish(result, "whisper-small", null);
    expect(api.addPreset).not.toHaveBeenCalled();
  });

  it("still completes when saving the preset fails", async () => {
    api.addPreset.mockRejectedValue(new Error("disk full"));
    const { result, onUpdateConfig } = setup();
    await expect(finish(result, "whisper-small", null)).resolves.toBeUndefined();
    expect(onUpdateConfig).toHaveBeenCalled();
  });

  it("names the default preset in every language", () => {
    for (const locale of [en, es, ja, ko, zhCN]) {
      expect(locale.presets.wizardDefault.name).toBeTruthy();
      expect(locale.presets.wizardDefault.description).toBeTruthy();
    }
  });
});
