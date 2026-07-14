import { useState, useEffect, useCallback } from "react";
import { getPresets, addPreset, updatePreset, removePreset } from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";
import type { Preset } from "../types";

/**
 * Tauri rejects a command with the serialized `AppError` string, so the reason a
 * preset failed to save is already here — it was just never shown. Every write
 * below re-reads presets.json first, which means a corrupt file surfaces as
 * "failed to save" with the actual cause (`…/presets.json:1:1: …`) discarded.
 */
export function reason(e: unknown): string | undefined {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : null;
  return text?.trim() ? text : undefined;
}

export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await getPresets();
      setPresets(data);
    } catch (e) {
      console.error("Failed to load presets:", e);
      toastError(i18n.t("toast.presetLoadFailed"), reason(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const add = useCallback(async (preset: Preset) => {
    try {
      const updated = await addPreset(preset);
      setPresets(updated);
      return updated;
    } catch (e) {
      console.error("Failed to add preset:", e);
      toastError(i18n.t("toast.presetSaveFailed"), reason(e));
      throw e;
    }
  }, []);

  const update = useCallback(async (preset: Preset) => {
    try {
      const updated = await updatePreset(preset);
      setPresets(updated);
      return updated;
    } catch (e) {
      console.error("Failed to update preset:", e);
      toastError(i18n.t("toast.presetSaveFailed"), reason(e));
      throw e;
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      const updated = await removePreset(id);
      setPresets(updated);
      return updated;
    } catch (e) {
      console.error("Failed to remove preset:", e);
      toastError(i18n.t("toast.presetDeleteFailed"), reason(e));
      throw e;
    }
  }, []);

  return { presets, loading, reload: load, add, update, remove };
}
