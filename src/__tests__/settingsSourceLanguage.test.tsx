import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

/**
 * The setup wizard was the only place that set source_language, and it can't
 * be run again: once it pinned a language, speech recognition stayed on that
 * language with no way back to automatic detection. Settings now offers the
 * same choice, from the same list.
 */

import i18n from "@/i18n";
import { GeneralSection } from "@/components/settings/GeneralSection";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { StepOutput } from "@/components/wizard/StepOutput";
import { SOURCE_LANGUAGES } from "@/lib/languages";
import type { AppConfig } from "@/types";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix Select calls these when its list opens; jsdom lacks them
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
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

function renderSection(sourceLanguage: string, onUpdate = vi.fn()) {
  const { unmount } = render(
    <GeneralSection config={{ ...CONFIG, source_language: sourceLanguage }} onUpdate={onUpdate} />,
  );
  return { trigger: screen.getByRole("combobox", { name: "Source Language" }), onUpdate, unmount };
}

function openOptions(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return within(screen.getByRole("listbox")).getAllByRole("option");
}

describe("settings source language", () => {
  it("shows automatic detection for the config default", () => {
    const { trigger } = renderSection("auto");
    expect(trigger).toHaveTextContent("Auto Detect");
  });

  it("lets a language pinned by the wizard go back to automatic detection", () => {
    const { trigger, onUpdate } = renderSection("ja");
    expect(trigger).toHaveTextContent("Japanese");

    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "Auto Detect" }), { key: "Enter" });

    expect(onUpdate).toHaveBeenCalledWith({ source_language: "auto" });
  });

  it("offers every language the wizard offers", () => {
    const { trigger, unmount } = renderSection("auto");
    const settingsCount = openOptions(trigger).length;
    unmount();

    render(
      <StepOutput outputDir="C:/out" subtitleFormat="srt" sourceLanguage="auto" targetLanguage="ko" onUpdate={() => {}} />,
    );
    const [wizardSource] = screen.getAllByRole("combobox");
    expect(openOptions(wizardSource)).toHaveLength(settingsCount);
    expect(settingsCount).toBe(SOURCE_LANGUAGES.length);
  });

  it.each([
    ["en", en],
    ["es", es],
    ["ja", ja],
    ["ko", ko],
    ["zh-CN", zhCN],
  ])("names every source language in %s", (_lang, locale) => {
    const names: Record<string, string> = locale.settings.general.sourceLangs;
    for (const code of SOURCE_LANGUAGES) {
      expect(names[code], code).toBeTruthy();
    }
  });

  it("restores automatic detection with the other defaults", () => {
    const onUpdateConfig = vi.fn();
    render(
      <SettingsPage
        config={{ ...CONFIG, source_language: "ja" }}
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

    expect(onUpdateConfig).toHaveBeenCalledWith(expect.objectContaining({ source_language: "auto" }));
  });
});
