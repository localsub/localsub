import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { RefreshCw, ExternalLink, CheckCircle2, AlertCircle, Download } from "lucide-react"
import { getVersion } from "@tauri-apps/api/app"
import { LocalSubLogo } from "@/components/localsub-logo"
import { Button } from "@/components/ui/button"
import { useHardware } from "@/hooks/useHardware"
import { useUpdater } from "@/hooks/useUpdater"
import { VcRedistCard } from "@/components/shared/VcRedistCard"
import { GITHUB_REPO } from "@/lib/links"

/** Small control on a white card: muted fill, 38px tall. */
const cardActionClass = "h-[38px] rounded-[11px] px-3.5 text-sm [&_svg]:size-4"

export function InfoSection() {
  const { t } = useTranslation()
  const { hardware, loading, detect } = useHardware()
  const { checking, updateAvailable, installing, error, upToDate, checkForUpdates, installUpdate } = useUpdater()
  const [version, setVersion] = useState("...")

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.1.0"))
  }, [])

  return (
    <div className="flex flex-col gap-3.5">
      {/* App info + update status */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-card px-6 py-5 shadow-card">
        <LocalSubLogo className="h-11 w-11 scale-150" />
        <div className="flex min-w-0 flex-col gap-[3px]">
          <h4 className="text-[17px] font-extrabold">LocalSub</h4>
          <p className="text-[13.5px] text-muted-foreground">
            {t("settings.about.version")} {version} · {t("settings.about.tagline")}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {!checking && !updateAvailable && !upToDate && !error && (
            <Button variant="secondary" className={cardActionClass} onClick={checkForUpdates}>
              <RefreshCw />
              {t("settings.about.updates.check")}
            </Button>
          )}
          {checking && (
            <span className="flex items-center gap-2 text-[13px] font-semibold text-muted-foreground">
              <RefreshCw className="size-4 animate-spin" />
              {t("settings.about.updates.checking")}
            </span>
          )}
          {updateAvailable && (
            <>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-primary-soft px-3 text-[13px] font-bold text-primary-text">
                {t("settings.about.updates.available")} · {updateAvailable.version}
              </span>
              <Button className={cardActionClass} onClick={installUpdate} disabled={installing}>
                <Download />
                {installing ? t("settings.about.updates.installing") : t("settings.about.updates.install")}
              </Button>
            </>
          )}
          {upToDate && (
            <>
              <span className="inline-flex h-8 items-center gap-1.5 rounded-sm bg-status-success-soft px-3 text-[13px] font-bold text-status-success">
                <CheckCircle2 className="size-4" />
                {t("settings.about.updates.upToDate")}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-sm [&_svg]:size-4"
                aria-label={t("settings.about.updates.check")}
                title={t("settings.about.updates.check")}
                onClick={checkForUpdates}
              >
                <RefreshCw />
              </Button>
            </>
          )}
          {error && (
            <>
              <span className="flex items-center gap-1.5 text-[13px] font-semibold text-status-error">
                <AlertCircle className="size-4 shrink-0" />
                {t("settings.about.updates.error")}
              </span>
              <Button variant="secondary" className={cardActionClass} onClick={checkForUpdates}>
                <RefreshCw />
                {t("settings.about.updates.check")}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Visual C++ runtime — a fixed address for the install, so declining
          the elevation prompt is never a dead end. */}
      <VcRedistCard variant="section" />

      {/* Hardware info */}
      <div className="mt-2 flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <h3 className="text-base font-extrabold">{t("settings.system.title")}</h3>
          <p className="text-[13px] text-muted-foreground">{t("settings.system.description")}</p>
        </div>
        <Button
          variant="ghost"
          className={`${cardActionClass} bg-card shadow-card hover:bg-card hover:text-foreground`}
          onClick={detect}
          disabled={loading}
        >
          <RefreshCw className={loading ? "animate-spin" : ""} />
          {t("settings.system.refresh")}
        </Button>
      </div>

      {loading && !hardware ? (
        <p className="text-sm text-muted-foreground">{t("settings.profile.detecting")}</p>
      ) : hardware ? (
        <div className="grid grid-cols-2 gap-2">
          <HwCard label={t("wizard.environment.cpuCard")} value={hardware.cpu_name} sub={`${hardware.cpu_cores} cores`} />
          <HwCard label={t("wizard.environment.ramCard")} value={`${hardware.total_ram_gb.toFixed(1)} GB`} sub={`${hardware.available_ram_gb.toFixed(1)} GB free`} />
          <HwCard label={t("wizard.environment.gpuCard")} value={hardware.gpu?.name ?? t("wizard.environment.noGpu")} sub={hardware.gpu ? `${hardware.gpu.vram_mb} MB VRAM${hardware.gpu.cuda_version ? ` • CUDA ${hardware.gpu.cuda_version}` : ""}` : undefined} />
          <HwCard label={t("wizard.environment.diskCard")} value={hardware.avx2_support ? "AVX2" : hardware.avx_support ? "AVX" : "SSE"} sub={t("wizard.environment.instructionSet")} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings.system.noData")}</p>
      )}

      {/* Tech info */}
      <div className="rounded-xl bg-card px-5 py-1.5 shadow-card">
        <InfoRow label={t("settings.about.runtime")} value="Tauri 2.x + React" />
        <InfoRow label={t("settings.about.sttEngine")} value="faster-whisper (CTranslate2)" />
        <InfoRow label={t("settings.about.llmEngine")} value="llama-cpp-python (GGUF)" />
        <InfoRow label={t("settings.about.license")} value="PolyForm Noncommercial 1.0.0" />
      </div>

      {/* Links */}
      <div className="flex flex-wrap gap-2">
        <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer" className={`${linkClass} bg-primary-soft text-primary-text hover:bg-primary-soft/70`}>
          <ExternalLink className="size-4" />
          {t("settings.about.github")}
        </a>
        <a href={`${GITHUB_REPO}/issues`} target="_blank" rel="noopener noreferrer" className={`${linkClass} bg-card text-foreground-secondary shadow-card hover:text-foreground`}>
          <ExternalLink className="size-4" />
          {t("settings.about.reportIssue")}
        </a>
      </div>
    </div>
  )
}

const linkClass =
  "inline-flex h-[42px] items-center gap-2 rounded-md px-4 text-sm font-bold transition-[background-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

function HwCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px] rounded-[16px] bg-card px-[18px] py-3.5 shadow-card">
      <p className="truncate text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="truncate text-[15px] font-bold">{value}</p>
      {sub && <p className="truncate text-[12.5px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex h-[46px] items-center justify-between gap-4 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-semibold">{value}</span>
    </div>
  )
}
