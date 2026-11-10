// Rules for showing STT models from the catalog. "whisper_models" holds every
// STT model (Whisper and Qwen3-ASR); these helpers keep the UI from offering a
// helper model as a choice or a GPU-only model to a machine that cannot run it.

import type { HardwareInfo, ModelCatalog, WhisperModelEntry } from "@/types"

/** Helper models (the Qwen forced aligner) are installed with the model that
 * needs them and are never a choice of their own. */
export function isSelectableStt(entry: WhisperModelEntry): boolean {
  return (entry.role ?? "stt") !== "aligner"
}

export function selectableSttModels(catalog: ModelCatalog | null): WhisperModelEntry[] {
  return catalog ? catalog.whisper_models.filter(isSelectableStt) : []
}

/** Ids of helper models, for lists built from the manifest (which has no role). */
export function helperModelIds(catalog: ModelCatalog | null): Set<string> {
  return new Set((catalog?.whisper_models ?? []).filter((m) => !isSelectableStt(m)).map((m) => m.id))
}

export function isQwen(entry: WhisperModelEntry | undefined): boolean {
  return entry?.engine === "qwen3-asr"
}

export function engineLabel(entry: WhisperModelEntry): string {
  return isQwen(entry) ? "Qwen3-ASR" : "Whisper"
}

export type GpuFit = "ok" | "needs_gpu" | "low_vram"

/** Whether this machine can run the model. Only models that declare
 * `min_vram_mb` (Qwen3-ASR, NVIDIA GPU only) can fail this. */
export function gpuFit(entry: WhisperModelEntry, hardware: HardwareInfo | null): GpuFit {
  const need = entry.min_vram_mb
  if (need == null) return "ok"
  if (!hardware?.gpu) return "needs_gpu"
  return hardware.gpu.vram_mb >= need ? "ok" : "low_vram"
}

/** Size the user actually downloads: the model plus helpers not yet installed. */
export function downloadSize(
  entry: WhisperModelEntry,
  catalog: ModelCatalog | null,
  installed: Set<string>,
): number {
  let size = entry.total_size_bytes
  for (const id of entry.requires ?? []) {
    if (installed.has(id)) continue
    size += catalog?.whisper_models.find((m) => m.id === id)?.total_size_bytes ?? 0
  }
  return size
}

/** Stable prefixes of STT job errors the user should see in plain words
 * (python-server/stt_backend_qwen.py). */
export const STT_ERROR_CODES = {
  languageUnsupported: "stt_language_unsupported_by_engine:",
  qwenUnavailable: "Qwen3-ASR unavailable",
} as const

/** i18n key for a failed download caused by the engine components install. */
export function downloadErrorKey(error: string | null | undefined): string | null {
  if (!error) return null
  if (/disk space for the engine pack/i.test(error)) return "errors.enginePack.disk"
  if (/\[engine-pack\]|engine pack/i.test(error)) return "errors.enginePack.failed"
  return null
}

/** i18n key for a known STT job error, or null to show the raw message. */
export function sttErrorKey(error: string | null | undefined): string | null {
  if (!error) return null
  if (error.includes(STT_ERROR_CODES.languageUnsupported)) return "errors.stt.languageUnsupported"
  if (error.includes(STT_ERROR_CODES.qwenUnavailable)) return "errors.stt.qwenUnavailable"
  return null
}

/** The message to show for a failed job: plain words for a known STT error,
 * else the raw error. */
export function friendlySttError(
  error: string | null | undefined,
  t: (key: never) => string,
): string | undefined {
  const key = sttErrorKey(error)
  return key ? t(key as never) : (error ?? undefined)
}
