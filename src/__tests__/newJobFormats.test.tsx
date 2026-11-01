import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

/**
 * Drag & drop accepts every extension in MEDIA_EXTENSIONS, but the file
 * picker used to hardcode its own shorter list (no WebM/OGG/AAC), and the
 * hint under the drop zone named even fewer. Both now follow the same sets.
 */

const api = vi.hoisted(() => ({
  pickFile: vi.fn(async (_filters: { name: string; extensions: string[] }[]) => null as string | null),
}));

vi.mock("@/lib/tauriApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tauriApi")>()),
  pickFile: api.pickFile,
  checkFfmpeg: async () => true,
}));

import i18n from "@/i18n";
import { NewJobDialog } from "@/components/dashboard/NewJobDialog";
import { MEDIA_EXTENSIONS, SUBTITLE_EXTENSIONS } from "@/lib/sourceType";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

describe("new job file formats", () => {
  it("offers every accepted extension in the file picker", async () => {
    render(
      <NewJobDialog open onOpenChange={() => {}} presets={[]} vocabularies={[]} onSubmit={() => {}} />,
    );

    await act(async () => {
      fireEvent.click(screen.getByText("Drag and drop files here, or click to browse"));
    });

    expect(api.pickFile).toHaveBeenCalledWith([
      { name: "Media", extensions: [...MEDIA_EXTENSIONS] },
      { name: "Subtitles", extensions: [...SUBTITLE_EXTENSIONS] },
    ]);
    const media = api.pickFile.mock.calls[0][0][0].extensions;
    expect(media).toEqual(expect.arrayContaining(["webm", "ogg", "aac"]));
  });

  it.each([
    ["en", en],
    ["es", es],
    ["ja", ja],
    ["ko", ko],
    ["zh-CN", zhCN],
  ])("names every accepted extension in the %s drop zone hint", (_lang, locale) => {
    const hint = locale.dashboard.newJob.supportedFormats.toLowerCase();
    const named = new Set(hint.split(/[,、]\s*/));
    for (const ext of [...MEDIA_EXTENSIONS, ...SUBTITLE_EXTENSIONS]) {
      expect(named).toContain(ext);
    }
  });
});
