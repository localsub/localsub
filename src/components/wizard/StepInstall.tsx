import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle, AlertCircle, Download } from "lucide-react";
import type { DownloadProgress, ModelManifestEntry } from "../../types";
import { Progress } from "../Progress";

type InstallPhase = "downloading" | "installing" | "verifying" | "complete" | "error";

interface StepInstallProps {
  selectedModels: string[];
  downloads: Map<string, DownloadProgress>;
  manifest: ModelManifestEntry[];
  onStartDownload: () => void;
  onComplete: () => void;
  error: string | null;
  onRetry: () => void;
}

function formatSpeed(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`;
  return `${bps} B/s`;
}

function formatEta(secs: number): string {
  if (secs < 60) return `${Math.ceil(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.ceil(secs % 60);
  return `${m}m ${s}s`;
}

export function StepInstall({
  selectedModels,
  downloads,
  manifest,
  onStartDownload,
  onComplete,
  error,
  onRetry,
}: StepInstallProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<InstallPhase>("downloading");

  // Trigger downloads on mount
  useEffect(() => {
    if (selectedModels.length === 0) {
      setPhase("complete");
      return;
    }
    onStartDownload();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect error
  useEffect(() => {
    if (error) {
      setPhase("error");
    }
  }, [error]);

  // Detect all downloads complete
  useEffect(() => {
    if (phase !== "downloading" || selectedModels.length === 0) return;

    const allDone = selectedModels.every((id) => {
      // A download can finish — file on disk, manifest entry marked "ready" —
      // without the live progress map ever reaching `downloaded >= total` (the
      // progress events don't always land for large single-file models). Treat
      // a "ready" manifest entry as done too, otherwise the wizard hangs on a
      // completed download with no way to proceed.
      if (manifest.some((m) => m.id === id && m.status === "ready")) return true;
      const dp = downloads.get(id);
      return !!dp && dp.total > 0 && dp.downloaded >= dp.total;
    });

    if (allDone) {
      setPhase("complete");
    }
  }, [downloads, selectedModels, phase, manifest]);

  // Calculate overall progress
  let totalDownloaded = 0;
  let totalSize = 0;
  downloads.forEach((dp) => {
    totalDownloaded += dp.downloaded;
    totalSize += dp.total;
  });
  const overallProgress = totalSize > 0 ? (totalDownloaded / totalSize) * 100 : 0;

  // Get current active download for speed/eta display
  const activeDownloads = Array.from(downloads.values()).filter(
    (d) => d.downloaded < d.total,
  );
  const currentDownload = activeDownloads[0] ?? null;

  if (phase === "error") {
    return (
      <div className="text-center">
        <AlertCircle className="mx-auto mb-4 h-10 w-10 text-danger" />
        <h2 className="mb-4 text-lg font-semibold text-slate-50">
          {t("wizard.install.error")}
        </h2>
        <p className="mb-6 max-h-[100px] overflow-y-auto break-words rounded-md bg-surface-inset p-3 text-left text-xs text-danger">
          {error}
        </p>
        <button
          className="cursor-pointer rounded-md bg-primary px-6 py-2 text-sm font-medium text-white transition-opacity hover:opacity-85"
          onClick={onRetry}
        >
          {t("wizard.install.retry")}
        </button>
      </div>
    );
  }

  if (phase === "complete") {
    return (
      <div className="text-center">
        <CheckCircle className="mx-auto mb-4 h-10 w-10 text-success" />
        <h2 className="mb-2 text-lg font-semibold text-slate-50">
          {t("wizard.install.complete")}
        </h2>
        <button
          className="mt-6 cursor-pointer rounded-md bg-primary px-8 py-3 text-base font-medium text-white transition-opacity hover:opacity-85"
          onClick={onComplete}
        >
          {t("wizard.install.startUsing")}
        </button>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6 flex items-center gap-2">
        <Download className="h-5 w-5 text-primary" />
        <h2 className="text-lg font-semibold text-slate-50">
          {t("wizard.install.title")}
        </h2>
      </div>

      {/* Overall progress */}
      <div className="mb-4">
        <div className="mb-1 flex justify-between text-xs text-slate-400">
          <span>{t(`wizard.install.${phase}`)}</span>
          <span>{Math.round(overallProgress)}%</span>
        </div>
        <Progress value={overallProgress} />
      </div>

      {/* Per-file progress */}
      {downloads.size > 0 && (
        <div className="mb-4 flex flex-col gap-2">
          {Array.from(downloads.entries()).map(([id, dp]) => {
            const pct = dp.total > 0 ? (dp.downloaded / dp.total) * 100 : 0;
            const fileLabel =
              dp.file_name && dp.total_files > 1
                ? `${dp.file_name} (${dp.file_index + 1}/${dp.total_files})`
                : dp.file_name || id;
            return (
              <div key={id} className="rounded-md bg-surface-inset p-2">
                <div className="mb-1 flex justify-between text-xs">
                  <span className="truncate text-slate-300">{fileLabel}</span>
                  <span className="text-slate-500">{Math.round(pct)}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-slate-700">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Speed + ETA */}
      {currentDownload && (
        <div className="flex justify-center gap-4 text-xs text-slate-500">
          <span>{formatSpeed(currentDownload.speed_bps)}</span>
          <span>ETA {formatEta(currentDownload.eta_secs)}</span>
        </div>
      )}
    </div>
  );
}
