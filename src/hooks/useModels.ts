import { useState, useEffect, useCallback } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getModelCatalog,
  getModelManifest,
  downloadModel as apiDownloadModel,
  cancelDownload as apiCancelDownload,
  deleteModel as apiDeleteModel,
} from "../lib/tauriApi";
import { toastError } from "../lib/toast";
import i18n from "../i18n";
import type {
  ModelCatalog,
  ModelManifestEntry,
  DownloadProgress,
} from "../types";

export function useModels() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [manifest, setManifest] = useState<ModelManifestEntry[]>([]);
  const [downloads, setDownloads] = useState<Map<string, DownloadProgress>>(
    new Map(),
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const cat = await getModelCatalog();
      setCatalog(cat);
    } catch (e) {
      console.error("Failed to load model catalog:", e);
      toastError(i18n.t("toast.modelLoadFailed"));
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const loadManifest = useCallback(async () => {
    try {
      const m = await getModelManifest();
      setManifest(m.models);
    } catch (e) {
      console.error("Failed to load model manifest:", e);
      toastError(i18n.t("toast.modelLoadFailed"));
    }
  }, []);

  const startDownload = useCallback(
    async (modelId: string) => {
      setError(null);
      try {
        await apiDownloadModel(modelId);
      } catch (e) {
        console.error("Failed to start download:", e);
        toastError(i18n.t("toast.modelDownloadFailed"));
        setError(String(e));
      }
    },
    [],
  );

  const cancelDownload = useCallback(async (modelId: string) => {
    try {
      await apiCancelDownload(modelId);
      setDownloads((prev) => {
        const next = new Map(prev);
        next.delete(modelId);
        return next;
      });
    } catch (e) {
      console.error("Failed to cancel download:", e);
      toastError(i18n.t("toast.modelCancelFailed"));
    }
  }, []);

  const deleteModel = useCallback(async (modelId: string) => {
    try {
      await apiDeleteModel(modelId);
    } catch (e) {
      console.error("Failed to delete model:", e);
      toastError(i18n.t("toast.modelDeleteFailed"));
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    // Load manifest on mount
    loadManifest();

    let unlistenProgress: (() => void) | null = null;
    let unlistenManifest: (() => void) | null = null;

    listen<DownloadProgress>(
      "download-progress",
      (event) => {
        setDownloads((prev) => {
          const next = new Map(prev);
          next.set(event.payload.model_id, event.payload);
          return next;
        });
      },
    ).then((fn) => { unlistenProgress = fn; });

    listen<ModelManifestEntry[]>(
      "model-manifest",
      (event) => {
        setManifest(event.payload);
      },
    ).then((fn) => { unlistenManifest = fn; });

    return () => {
      unlistenProgress?.();
      unlistenManifest?.();
    };
  }, [loadManifest]);

  return {
    catalog,
    manifest,
    downloads,
    loading,
    error,
    loadCatalog,
    loadManifest,
    startDownload,
    cancelDownload,
    deleteModel,
  };
}
