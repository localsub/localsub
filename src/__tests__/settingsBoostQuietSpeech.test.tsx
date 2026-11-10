import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * Whispered lines can fall below what speech detection keeps, so they vanish
 * from the subtitles. "Boost Quiet Speech" raises them before recognition;
 * the server applies it, Settings only stores the switch.
 */

import i18n from "@/i18n";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { SettingsPage } from "@/components/settings/SettingsPage";
import type { AppConfig } from "@/types";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const CONFIG: AppConfig = {
  version: 1, wizard_completed: true, wizard_step: 5, profile: "lite",
  output_dir: "C:/out", subtitle_format: "srt", source_language: "auto", target_language: "ko",
  translation_mode: "local", context_window: 4, style_preset: "natural",
  external_api: { provider: null, api_key: null, model: null }, model_dir: null,
  ui_language: "en", active_whisper_model: null, active_llm_model: null,
  max_concurrent_jobs: 1, gpu_acceleration: null, max_memory_mb: null,
  translation_quality: null, custom_translation_prompt: null,
};

function renderSection(boost: boolean | null | undefined, onUpdate = vi.fn()) {
  render(<GeneralSection config={{ ...CONFIG, boost_quiet_speech: boost }} onUpdate={onUpdate} />);
  return { toggle: screen.getByRole("switch", { name: "Boost Quiet Speech" }), onUpdate };
}

describe("settings boost quiet speech", () => {
  it.each([undefined, null])("is off when the config has no value (%s)", (value) => {
    const { toggle } = renderSection(value);
    expect(toggle).toHaveAttribute("aria-checked", "false");
  });

  it("turns on and off", () => {
    const { toggle, onUpdate } = renderSection(false);
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenLastCalledWith({ boost_quiet_speech: true });
  });

  it("shows a stored true as on and turns it off", () => {
    const { toggle, onUpdate } = renderSection(true);
    expect(toggle).toHaveAttribute("aria-checked", "true");
    fireEvent.click(toggle);
    expect(onUpdate).toHaveBeenLastCalledWith({ boost_quiet_speech: false });
  });

  it("explains itself", () => {
    const { toggle } = renderSection(false);
    expect(toggle).toHaveAccessibleDescription(en.settings.general.boostQuietSpeechDesc);
  });

  it.each([
    ["en", en],
    ["es", es],
    ["ja", ja],
    ["ko", ko],
    ["zh-CN", zhCN],
  ])("has its label and description in %s", (_lang, locale) => {
    expect(locale.settings.general.boostQuietSpeech).toBeTruthy();
    expect(locale.settings.general.boostQuietSpeechDesc).toBeTruthy();
  });

  it("is turned off by Restore Defaults", () => {
    const onUpdateConfig = vi.fn();
    render(
      <SettingsPage
        config={{ ...CONFIG, boost_quiet_speech: true }}
        manifest={[]}
        catalog={null}
        hardware={null}
        downloads={new Map()}
        onUpdateConfig={onUpdateConfig}
        onDeleteModel={() => {}}
        onDownloadModel={() => {}}
        onCancelDownload={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore Defaults" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    expect(onUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ boost_quiet_speech: false }));
  });
});
