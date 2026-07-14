import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import {
  Cpu, MemoryStick, Monitor, Microchip, RefreshCw,
  ExternalLink, CheckCircle2, AlertCircle, Download,
} from "lucide-react"
import { getVersion } from "@tauri-apps/api/app"
import { LocalSubLogo } from "@/components/localsub-logo"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useHardware } from "@/hooks/useHardware"
import { useUpdater } from "@/hooks/useUpdater"
import type { LucideIcon } from "lucide-react"
import { GITHUB_REPO } from "@/lib/links"

export function InfoSection() {
  const { t } = useTranslation()
  const { hardware, loading, detect } = useHardware()
  const { checking, updateAvailable, installing, error, upToDate, checkForUpdates, installUpdate } = useUpdater()
  const [version, setVersion] = useState("...")

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.1.0"))
  }, [])

  return (
    <div className="flex flex-col gap-6">
      {/* App info */}
      <div className="flex items-center gap-4 rounded-lg border p-4">
        <LocalSubLogo size="md" />
        <div>
          <h4 className="text-sm font-semibold">LocalSub</h4>
          <p className="text-xs text-muted-foreground mt-0.5">{t("settings.about.version")} {version}</p>
          <p className="text-xs text-muted-foreground">{t("settings.about.tagline")}</p>
        </div>
      </div>

      {/* Update check */}
      <div className="rounded-lg border p-4">
        <h4 className="text-sm font-semibold mb-3">{t("settings.about.updates.title")}</h4>
        <div className="flex items-center gap-3">
          {!checking && !updateAvailable && !upToDate && !error && (
            <Button variant="outline" size="sm" onClick={checkForUpdates}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {t("settings.about.updates.check")}
            </Button>
          )}
          {checking && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-4 w-4 animate-spin" />
              {t("settings.about.updates.checking")}
            </div>
          )}
          {updateAvailable && (
            <div className="flex items-center gap-3">
              <Badge variant="secondary">{updateAvailable.version}</Badge>
              <span className="text-sm">{t("settings.about.updates.available")}</span>
              <Button size="sm" onClick={installUpdate} disabled={installing}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {installing ? t("settings.about.updates.installing") : t("settings.about.updates.install")}
              </Button>
            </div>
          )}
          {upToDate && (
            <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400">
              <CheckCircle2 className="h-4 w-4" />
              {t("settings.about.updates.upToDate")}
              <Button variant="ghost" size="sm" className="ml-2 h-7" onClick={checkForUpdates}>
                <RefreshCw className="h-3.5 w-3.5" />
              </Button>
            </div>
          )}
          {error && (
            <div className="flex items-center gap-2">
              <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
              <span className="text-sm text-destructive">{t("settings.about.updates.error")}</span>
              <Button variant="outline" size="sm" className="ml-2" onClick={checkForUpdates}>
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                {t("settings.about.updates.check")}
              </Button>
            </div>
          )}
        </div>
      </div>

      <Separator />

      {/* Hardware info */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{t("settings.system.title")}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">{t("settings.system.description")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={detect} disabled={loading}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          {t("settings.system.refresh")}
        </Button>
      </div>

      {loading && !hardware ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {t("settings.profile.detecting")}
        </div>
      ) : hardware ? (
        <div className="grid grid-cols-2 gap-3">
          <HwCard icon={Cpu} label={t("wizard.environment.cpuCard")} value={hardware.cpu_name} sub={`${hardware.cpu_cores} cores`} />
          <HwCard icon={MemoryStick} label={t("wizard.environment.ramCard")} value={`${hardware.total_ram_gb.toFixed(1)} GB`} sub={`${hardware.available_ram_gb.toFixed(1)} GB free`} />
          <HwCard icon={Monitor} label={t("wizard.environment.gpuCard")} value={hardware.gpu?.name ?? t("wizard.environment.noGpu")} sub={hardware.gpu ? `${hardware.gpu.vram_mb} MB VRAM${hardware.gpu.cuda_version ? ` • CUDA ${hardware.gpu.cuda_version}` : ""}` : undefined} />
          <HwCard icon={Microchip} label={t("wizard.environment.diskCard")} value={hardware.avx2_support ? "AVX2" : hardware.avx_support ? "AVX" : "SSE"} sub={t("wizard.environment.instructionSet")} />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("settings.system.noData")}</p>
      )}

      <Separator />

      {/* Tech info + links */}
      <div className="flex flex-col gap-2 text-sm">
        <InfoRow label={t("settings.about.runtime")} value="Tauri 2.x + React" />
        <InfoRow label={t("settings.about.sttEngine")} value="faster-whisper (CTranslate2)" />
        <InfoRow label={t("settings.about.llmEngine")} value="llama-cpp-python (GGUF)" />
        <InfoRow label={t("settings.about.license")} value="PolyForm Noncommercial 1.0.0" />
      </div>

      <div className="flex flex-col gap-1.5">
        <a href={GITHUB_REPO} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> {t("settings.about.github")}
        </a>
        <a href={`${GITHUB_REPO}/issues`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
          <ExternalLink className="h-3.5 w-3.5" /> {t("settings.about.reportIssue")}
        </a>
      </div>
    </div>
  )
}

function HwCard({ icon: Icon, label, value, sub }: { icon: LucideIcon; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="truncate text-sm font-medium">{value}</p>
      {sub && <p className="truncate text-xs text-muted-foreground mt-0.5">{sub}</p>}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md px-3 py-2 odd:bg-muted/30">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  )
}
