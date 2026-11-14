import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, AlertCircle, Loader2 } from "lucide-react";
import type { DownloadProgress, ModelManifestEntry } from "../../types";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";

type InstallPhase = "downloading" | "installing" | "verifying" | "complete" | "error";

interface StepInstallProps {
  selectedModels: string[];
  downloads: Map<string, DownloadProgress>;
  manifest: ModelManifestEntry[];
  /** A Qwen3-ASR download is installing its engine components first. That
   * step sends no download progress, so say what is happening instead. */
  preparingEngine?: boolean;
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
  preparingEngine = false,
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
      <div className="flex flex-col items-center gap-3.5 text-center">
        <div className="mb-1.5 flex size-14 items-center justify-center rounded-[18px] bg-status-error-soft text-status-error">
          <AlertCircle className="size-[26px]" />
        </div>
        <h2 className="text-[22px] font-extrabold tracking-[-0.02em]">
          {t("wizard.install.error")}
        </h2>
        <p className="max-h-[100px] w-full overflow-y-auto break-words rounded-md bg-muted px-3.5 py-3 text-left font-mono text-xs leading-relaxed text-status-error">
          {error}
        </p>
        <Button className="mt-2 h-12 px-[22px]" onClick={onRetry}>
          {t("wizard.install.retry")}
        </Button>
      </div>
    );
  }

  if (phase === "complete") {
    return (
      <div className="flex flex-col items-center gap-3.5 text-center">
        <div className="mb-1.5 flex size-14 items-center justify-center rounded-[18px] bg-status-success-soft text-status-success">
          <Check className="size-[26px]" strokeWidth={2.6} />
        </div>
        <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
          {t("wizard.install.complete")}
        </h2>
        <Button className="mt-4 h-14 w-full rounded-[16px] text-[17px]" onClick={onComplete}>
          {t("wizard.install.startUsing")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-[22px]">
      <h2 className="text-2xl font-extrabold tracking-[-0.03em]">
        {t("wizard.install.title")}
      </h2>

      {/* Overall progress */}
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <span className="text-[15px] font-semibold text-foreground-secondary">
            {t(`wizard.install.${phase}`)}
          </span>
          <span className="text-[32px] font-extrabold leading-none tracking-[-0.03em] tabular-nums text-primary-text">
            {Math.round(overallProgress)}%
          </span>
        </div>
        <Progress value={overallProgress} className="h-2.5" />
      </div>

      {preparingEngine && (
        <div className="flex items-center gap-2.5 rounded-lg bg-muted px-4 py-3.5 text-[13.5px] text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          <span>{t("settings.models.preparingEngine")}</span>
        </div>
      )}

      {/* Per-file progress */}
      {downloads.size > 0 && (
        <div className="flex flex-col gap-2">
          {Array.from(downloads.entries()).map(([id, dp]) => {
            const pct = dp.total > 0 ? (dp.downloaded / dp.total) * 100 : 0;
            const fileLabel =
              dp.file_name && dp.total_files > 1
                ? `${dp.file_name} (${dp.file_index + 1}/${dp.total_files})`
                : dp.file_name || id;
            return (
              <div key={id} className="flex flex-col gap-2 rounded-lg bg-muted px-4 py-3.5">
                <div className="flex justify-between gap-3 text-[13.5px]">
                  <span className="truncate font-semibold">{fileLabel}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{Math.round(pct)}%</span>
                </div>
                <div className="h-1 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
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
        <div className="flex justify-center gap-4 text-[13px] tabular-nums text-muted-foreground">
          <span>{formatSpeed(currentDownload.speed_bps)}</span>
          <span>ETA {formatEta(currentDownload.eta_secs)}</span>
        </div>
      )}
    </div>
  );
}
