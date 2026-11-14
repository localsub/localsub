import { describe, it, expect, vi, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";

/**
 * Qwen3-ASR joins Whisper in the STT model list. The end user is not
 * technical, so the UI must never offer the forced aligner as a model, never
 * let a machine without a suitable NVIDIA GPU start a Qwen download, explain
 * the one-time component setup, and turn backend error codes into plain words.
 */

import i18n from "@/i18n";
import { ModelsSection } from "@/components/settings/ModelsSection";
import { StepModels } from "@/components/wizard/StepModels";
import { StepInstall } from "@/components/wizard/StepInstall";
import {
  downloadErrorKey,
  downloadSize,
  friendlySttError,
  gpuFit,
  helperModelIds,
  selectableSttModels,
  sttErrorKey,
} from "@/lib/sttModels";
import type { HardwareInfo, ModelCatalog, ModelManifestEntry, WhisperModelEntry } from "@/types";
import en from "@/i18n/locales/en.json";
import es from "@/i18n/locales/es.json";
import ja from "@/i18n/locales/ja.json";
import ko from "@/i18n/locales/ko.json";
import zhCN from "@/i18n/locales/zh-CN.json";

beforeAll(async () => {
  await i18n.changeLanguage("en");
});

const ALIGN = ["zh", "yue", "en", "ko", "ja", "fr", "de", "it", "es", "pt", "ru"];

function stt(id: string, extra: Partial<WhisperModelEntry> = {}): WhisperModelEntry {
  return {
    id, name: id, repo: `org/${id}`, files: ["model.bin"], total_size_bytes: 1e9,
    sha256: {}, profiles: ["balanced", "power"], license: "MIT", license_url: "https://x",
    ...extra,
  };
}

const CATALOG: ModelCatalog = {
  version: 1,
  whisper_models: [
    stt("whisper-small"),
    stt("qwen3-asr-1.7b", {
      name: "Qwen3-ASR 1.7B", engine: "qwen3-asr", total_size_bytes: 4.7e9,
      requires: ["qwen3-forced-aligner-0.6b"], languages: ALIGN, min_vram_mb: 7680,
    }),
    stt("qwen3-forced-aligner-0.6b", {
      name: "Qwen3 Forced Aligner 0.6B", engine: "qwen3-asr", role: "aligner", total_size_bytes: 1.8e9,
    }),
  ],
  llm_models: [],
} as ModelCatalog;

function hw(vram_mb: number | null): HardwareInfo {
  return {
    cpu_name: "cpu", cpu_cores: 8, avx_support: true, avx2_support: true,
    total_ram_gb: 32, available_ram_gb: 16,
    gpu: vram_mb == null ? null : { name: "NVIDIA GeForce RTX 4060 Ti", vram_mb, cuda_version: "12.9" },
  } as HardwareInfo;
}

function renderModels(hardware: HardwareInfo | null, opts: { manifest?: ModelManifestEntry[]; preparing?: boolean } = {}) {
  render(
    <ModelsSection
      manifest={opts.manifest ?? []}
      catalog={CATALOG}
      hardware={hardware}
      downloads={new Map()}
      profile="power"
      activeWhisperModel={null}
      activeLlmModel={null}
      onUpdate={vi.fn()}
      onDelete={vi.fn()}
      onDownload={vi.fn()}
      onCancelDownload={vi.fn()}
      installingPacks={opts.preparing ? new Set(["qwen3-asr"]) : new Set()}
    />,
  );
}

function installButtonFor(name: string) {
  const row = screen.getByText(name).closest("div.rounded-lg") as HTMLElement;
  return row.querySelector("button") as HTMLButtonElement;
}

describe("STT model rules", () => {
  it("never offers the aligner as a model", () => {
    expect(selectableSttModels(CATALOG).map((m) => m.id)).toEqual(["whisper-small", "qwen3-asr-1.7b"]);
    expect([...helperModelIds(CATALOG)]).toEqual(["qwen3-forced-aligner-0.6b"]);
  });

  it("checks the GPU only for models that need one", () => {
    const qwen = CATALOG.whisper_models[1];
    expect(gpuFit(CATALOG.whisper_models[0], null)).toBe("ok");
    expect(gpuFit(qwen, null)).toBe("needs_gpu");
    expect(gpuFit(qwen, hw(6144))).toBe("low_vram");
    // An 8 GB card reports a little under 8192 MB; it must still qualify.
    expect(gpuFit(qwen, hw(8188))).toBe("ok");
  });

  it("counts the aligner in the download size until it is installed", () => {
    const qwen = CATALOG.whisper_models[1];
    expect(downloadSize(qwen, CATALOG, new Set())).toBe(4.7e9 + 1.8e9);
    expect(downloadSize(qwen, CATALOG, new Set(["qwen3-forced-aligner-0.6b"]))).toBe(4.7e9);
  });

  it("maps backend error codes to plain-language messages", () => {
    const refused = "stt_language_unsupported_by_engine: Qwen3-ASR cannot time subtitles for Thai (th).";
    expect(sttErrorKey(refused)).toBe("errors.stt.languageUnsupported");
    expect(sttErrorKey("Failed to load model: Qwen3-ASR unavailable (OSError: ...)")).toBe("errors.stt.qwenUnavailable");
    expect(sttErrorKey("CUDA out of memory")).toBeNull();
    expect(friendlySttError(refused, i18n.t as never)).toMatch(/Whisper model/);
    expect(friendlySttError("raw", i18n.t as never)).toBe("raw");

    expect(downloadErrorKey("Not enough disk space for the engine pack: need 1 bytes")).toBe("errors.enginePack.disk");
    expect(downloadErrorKey("[engine-pack] ERROR: Could not install")).toBe("errors.enginePack.failed");
    expect(downloadErrorKey("HTTP 404 for https://huggingface.co/x")).toBeNull();
  });

  it("has every new string in all five languages", () => {
    const keys = [
      ["settings", "models", "preparingEngine"], ["settings", "models", "needsNvidiaGpu"],
      ["settings", "models", "needsVram"], ["settings", "models", "qwenNote"],
      ["presets", "dialog", "qwenLanguagesNote"],
      ["errors", "stt", "languageUnsupported"], ["errors", "stt", "qwenUnavailable"],
      ["errors", "enginePack", "disk"], ["errors", "enginePack", "failed"],
    ];
    for (const locale of [en, es, ja, ko, zhCN]) {
      for (const path of keys) {
        const value = path.reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], locale);
        expect(typeof value, path.join(".")).toBe("string");
      }
    }
  });
});

describe("Settings > Models with Qwen3-ASR", () => {
  it("lists Qwen with an engine badge and hides the aligner", () => {
    renderModels(hw(8188));
    expect(screen.getByText("Qwen3-ASR 1.7B")).toBeInTheDocument();
    expect(screen.getByText("Qwen3-ASR")).toBeInTheDocument();
    expect(screen.queryByText("Qwen3 Forced Aligner 0.6B")).toBeNull();
    // Size shown is what will be downloaded: model + aligner.
    expect(screen.getByText("6.5 GB")).toBeInTheDocument();
    expect(screen.getByText(/first download also sets up its components/)).toBeInTheDocument();
    expect(installButtonFor("Qwen3-ASR 1.7B")).toBeEnabled();
  });

  it("blocks the Qwen download without an NVIDIA GPU and says why", () => {
    renderModels(null);
    expect(screen.getByText("Needs an NVIDIA graphics card")).toBeInTheDocument();
    expect(installButtonFor("Qwen3-ASR 1.7B")).toBeDisabled();
    expect(installButtonFor("whisper-small")).toBeEnabled();
  });

  it("blocks the Qwen download when the GPU is too small", () => {
    renderModels(hw(6144));
    expect(screen.getByText("Needs 7.5 GB of graphics memory")).toBeInTheDocument();
    expect(installButtonFor("Qwen3-ASR 1.7B")).toBeDisabled();
  });

  it("shows the one-time component setup while it runs", () => {
    const downloading: ModelManifestEntry = {
      id: "qwen3-asr-1.7b", model_type: "whisper", name: "Qwen3-ASR 1.7B", path: "qwen3-asr-1.7b",
      size_bytes: 1, sha256: "", status: "downloading", installed_at: "0",
    };
    renderModels(hw(8188), { manifest: [downloading], preparing: true });
    expect(screen.getByText(/Setting up speech recognition components/)).toBeInTheDocument();
  });
});

describe("Setup wizard", () => {
  function renderWizardModels(hardware: HardwareInfo | null, sourceLanguage = "auto") {
    render(
      <StepModels
        catalog={CATALOG}
        loading={false}
        profile="power"
        hardware={hardware}
        sourceLanguage={sourceLanguage}
        selectedWhisperModel="qwen3-asr-1.7b"
        selectedLlmModel={null}
        onSelectWhisper={vi.fn()}
        onSelectLlm={vi.fn()}
        onLoadCatalog={vi.fn()}
      />,
    );
  }

  it("offers Qwen when the detected GPU fits, never the aligner", () => {
    renderWizardModels(hw(8188));
    expect(screen.getByText("whisper-small")).toBeInTheDocument();
    expect(screen.getByText("Qwen3-ASR 1.7B")).toBeInTheDocument();
    expect(screen.getByText("Qwen3-ASR")).toBeInTheDocument();
    expect(screen.queryByText("Qwen3 Forced Aligner 0.6B")).toBeNull();
  });

  it("counts the aligner in the Qwen download size", () => {
    renderWizardModels(hw(8188));
    // 4.7 GB model + 1.8 GB aligner, on the row and in the total
    expect(screen.getAllByText("6.5 GB")).toHaveLength(2);
  });

  it.each([
    ["no GPU", null],
    ["too little VRAM", 6144],
  ])("hides Qwen with %s", (_label, vram) => {
    renderWizardModels(hw(vram));
    expect(screen.getByText("whisper-small")).toBeInTheDocument();
    expect(screen.queryByText("Qwen3-ASR 1.7B")).toBeNull();
  });

  it("hides Qwen when the chosen source language has no aligner", () => {
    renderWizardModels(hw(8188), "vi");
    expect(screen.queryByText("Qwen3-ASR 1.7B")).toBeNull();
  });
});

describe("Setup wizard install step", () => {
  function renderInstall(preparingEngine: boolean) {
    render(
      <StepInstall
        selectedModels={["qwen3-asr-1.7b"]}
        downloads={new Map()}
        manifest={[]}
        preparingEngine={preparingEngine}
        onStartDownload={vi.fn()}
        onComplete={vi.fn()}
        error={null}
        onRetry={vi.fn()}
      />,
    );
  }

  it("says the engine components are being set up while they install", () => {
    renderInstall(true);
    expect(screen.getByText(en.settings.models.preparingEngine)).toBeInTheDocument();
  });

  it("does not show that line otherwise", () => {
    renderInstall(false);
    expect(screen.queryByText(en.settings.models.preparingEngine)).toBeNull();
  });
});
