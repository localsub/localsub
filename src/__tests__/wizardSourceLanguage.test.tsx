import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

/**
 * The config default for source_language is "auto", but the setup wizard
 * listed only fixed languages: the select showed blank for the default, and
 * once a language was picked there was no way back to automatic detection.
 */

import i18n from "@/i18n";
import { StepOutput } from "@/components/wizard/StepOutput";

beforeAll(async () => {
  await i18n.changeLanguage("en");
  // Radix Select calls these when its list opens; jsdom lacks them
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

function renderStep(sourceLanguage: string, onUpdate = vi.fn()) {
  render(
    <StepOutput
      outputDir="C:/out"
      subtitleFormat="srt"
      sourceLanguage={sourceLanguage}
      targetLanguage="ko"
      onUpdate={onUpdate}
    />,
  );
  const [source, target] = screen.getAllByRole("combobox");
  return { source, target, onUpdate };
}

describe("wizard source language", () => {
  it("shows automatic detection for the config default", () => {
    const { source } = renderStep("auto");
    expect(source).toHaveTextContent("Auto Detect");
  });

  it("lets a picked language go back to automatic detection", () => {
    const { source, onUpdate } = renderStep("ja");
    expect(source).toHaveTextContent("JA");

    fireEvent.keyDown(source, { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("option", { name: "Auto Detect" }), { key: "Enter" });

    expect(onUpdate).toHaveBeenCalledWith({ sourceLanguage: "auto" });
  });

  it("does not offer automatic detection as a target language", () => {
    const { target } = renderStep("auto");

    fireEvent.keyDown(target, { key: "Enter" });

    const options = within(screen.getByRole("listbox")).getAllByRole("option");
    expect(options.map((o) => o.textContent)).not.toContain("Auto Detect");
    expect(options).toHaveLength(10);
  });
});
