import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * A fresh install has no presets, and the new job dialog only said "create
 * one in the Presets page" with no way to get there from the dialog.
 */

vi.mock("@/lib/tauriApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauriApi")>()),
  checkFfmpeg: async () => true,
}));

import i18n from "@/i18n";
import { NewJobDialog } from "@/components/dashboard/NewJobDialog";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("new job dialog without presets", () => {
  it("closes itself and opens the Presets page", () => {
    const onOpenChange = vi.fn();
    const onGoToPresets = vi.fn();
    render(
      <NewJobDialog open onOpenChange={onOpenChange} presets={[]} vocabularies={[]} onSubmit={() => {}}
        onGoToPresets={onGoToPresets} />,
    );

    fireEvent.click(screen.getByRole("button", { name: en.dashboard.newJob.goToPresets }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onGoToPresets).toHaveBeenCalledTimes(1);
  });

  it("has the button label in every language", () => {
    for (const locale of [en, es, ja, ko, zhCN]) {
      expect(locale.dashboard.newJob.goToPresets).toBeTruthy();
    }
  });
});
