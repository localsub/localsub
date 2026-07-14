import { useState, useMemo } from "react"
import { useTranslation } from "react-i18next"
import { Download, Trash2, CheckCircle2, Cpu, Monitor, Globe, X, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import type {
  ModelManifestEntry,
  ModelCatalog,
  HardwareInfo,
  WhisperModelEntry,
  LlmModelEntry,
  Profile,
  PartialConfig,
  DownloadProgress,
} from "@/types"

type InstallStatus = ModelManifestEntry["status"] | "not_installed"
type VramFit = "recommended" | "cpu_only" | "too_large"

interface ModelsSectionProps {
  manifest: ModelManifestEntry[]
  catalog: ModelCatalog | null
  hardware: HardwareInfo | null
  downloads: Map<string, DownloadProgress>
  profile: Profile
  activeWhisperModel: string | null
  activeLlmModel: string | null
  onUpdate: (patch: PartialConfig) => void
  onDelete: (id: string) => void
  onDownload: (id: string) => void
  onCancelDownload: (id: string) => void
  sourceLanguage?: string
  targetLanguage?: string
}

// All Qwen models are multilingual; specific model names can be mapped here if needed
const MULTILINGUAL_MODEL_PATTERNS = ["qwen", "aya", "gemma", "llama"]

function isLangRecommended(modelName: string): boolean {
  const lower = modelName.toLowerCase()
  return MULTILINGUAL_MODEL_PATTERNS.some((p) => lower.includes(p))
}

function formatSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(0)} MB`
  return `${(bytes / 1e3).toFixed(0)} KB`
}

function formatVram(mb: number): string {
  return `${(mb / 1024).toFixed(1)} GB`
}

function formatSpeed(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(1)} MB/s`
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(0)} KB/s`
  return `${bps} B/s`
}

function formatEta(secs: number): string {
  if (secs <= 0) return ""
  if (secs < 60) return `${Math.ceil(secs)}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${Math.ceil(secs % 60)}s`
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ready: "default",
  downloading: "secondary",
  verifying: "secondary",
  missing: "outline",
  corrupt: "destructive",
  not_installed: "outline",
}

function getLlmVramFit(sizeBytes: number, hardware: HardwareInfo | null): VramFit {
  if (!hardware?.gpu) return "cpu_only"
  const vramBytes = hardware.gpu.vram_mb * 1024 * 1024
  if (vramBytes >= sizeBytes) return "recommended"
  // Can still run on CPU if enough RAM
  const ramBytes = hardware.total_ram_gb * 1024 * 1024 * 1024
  if (ramBytes >= sizeBytes) return "cpu_only"
  return "too_large"
}

function getWhisperFit(entry: WhisperModelEntry, profile: Profile): VramFit {
  if (entry.profiles.includes(profile)) return "recommended"
  return "cpu_only"
}

export function ModelsSection({
  manifest,
  catalog,
  hardware,
  downloads,
  profile,
  activeWhisperModel,
  activeLlmModel,
  onUpdate,
  onDelete,
  onDownload,
  onCancelDownload,
  sourceLanguage,
  targetLanguage,
}: ModelsSectionProps) {
  const { t } = useTranslation()
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)

  const manifestMap = useMemo(() => {
    const map = new Map<string, ModelManifestEntry>()
    for (const m of manifest) map.set(m.id, m)
    return map
  }, [manifest])

  function getStatus(id: string): InstallStatus {
    const entry = manifestMap.get(id)
    return entry ? entry.status : "not_installed"
  }

  function handleSelectActive(type: "whisper" | "llm", id: string) {
    if (type === "whisper") {
      onUpdate({ active_whisper_model: id })
    } else {
      onUpdate({ active_llm_model: id })
    }
  }

  function renderVramBadge(fit: VramFit) {
    if (fit === "recommended") {
      return (
        <Badge variant="default" className="text-[10px] h-4 bg-green-600 hover:bg-green-600">
          {t("settings.models.recommended")}
        </Badge>
      )
    }
    if (fit === "cpu_only") {
      return (
        <Badge variant="secondary" className="text-[10px] h-4 bg-yellow-600/20 text-yellow-600">
          {t("settings.models.cpuOnly")}
        </Badge>
      )
    }
    return (
      <Badge variant="destructive" className="text-[10px] h-4">
        {t("settings.models.tooLarge")}
      </Badge>
    )
  }

  function renderStatusBadge(status: InstallStatus) {
    const labelKey = status === "not_installed"
      ? "settings.models.notInstalled"
      : `settings.models.status.${status}`
    return (
      <Badge variant={STATUS_VARIANT[status] ?? "outline"} className="text-[10px] h-4">
        {t(labelKey as never)}
      </Badge>
    )
  }

  function renderDownloadProgress(id: string) {
    const progress = downloads.get(id)
    if (!progress || progress.total === 0) {
      return (
        <div className="flex items-center gap-2 mt-2">
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{t("settings.models.status.verifying")}</span>
        </div>
      )
    }
    const pct = Math.min((progress.downloaded / progress.total) * 100, 100)
    const fileLabel = progress.total_files > 1
      ? `(${progress.file_index + 1}/${progress.total_files}) ${progress.file_name}`
      : progress.file_name
    return (
      <div className="flex flex-col gap-1.5 mt-2 w-full">
        <Progress value={pct} className="h-2" />
        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{fileLabel} — {pct.toFixed(1)}%</span>
          <span>
            {formatSpeed(progress.speed_bps)}
            {progress.eta_secs > 0 && ` · ${formatEta(progress.eta_secs)}`}
          </span>
        </div>
      </div>
    )
  }

  function renderActions(id: string, status: InstallStatus) {
    if (status === "ready") {
      return (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-destructive hover:text-destructive"
          onClick={() => setDeleteTarget(id)}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )
    }
    if (status === "downloading") {
      return (
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => onCancelDownload(id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )
    }
    if (status === "not_installed" || status === "missing" || status === "corrupt") {
      return (
        <Button variant="outline" size="sm" onClick={() => onDownload(id)}>
          <Download className="mr-1.5 h-3.5 w-3.5" />
          {t("settings.models.install")}
        </Button>
      )
    }
    return null
  }

  function renderWhisperModels(models: WhisperModelEntry[]) {
    if (models.length === 0) return null
    return (
      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("settings.models.whisperSection")}</h4>
        <RadioGroup
          value={activeWhisperModel ?? ""}
          onValueChange={(id) => handleSelectActive("whisper", id)}
          className="flex flex-col gap-2"
        >
          {models.map((entry) => {
            const status = getStatus(entry.id)
            const canActivate = status === "ready"
            const isDownloading = status === "downloading"
            const fit = getWhisperFit(entry, profile)
            return (
              <div
                key={entry.id}
                className={cn(
                  "flex flex-col rounded-lg border p-3 transition-colors",
                  status === "ready"
                    ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                    : "hover:bg-muted/30",
                )}
              >
                <div className="flex items-center gap-3">
                  {canActivate && (
                    <RadioGroupItem value={entry.id} id={`model-${entry.id}`} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`model-${entry.id}`} className="text-sm font-medium cursor-pointer">
                        {entry.name}
                      </Label>
                      {entry.id === activeWhisperModel && (
                        <Badge variant="default" className="text-[10px] h-5 gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {t("settings.models.active")}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                      <span>{formatSize(entry.total_size_bytes)}</span>
                      {renderStatusBadge(status)}
                      {renderVramBadge(fit)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {renderActions(entry.id, status)}
                  </div>
                </div>
                {isDownloading && renderDownloadProgress(entry.id)}
              </div>
            )
          })}
        </RadioGroup>
      </div>
    )
  }

  function renderLlmModels(models: LlmModelEntry[]) {
    if (models.length === 0) return null
    return (
      <div className="flex flex-col gap-3">
        <h4 className="text-sm font-medium">{t("settings.models.llmSection")}</h4>
        <RadioGroup
          value={activeLlmModel ?? ""}
          onValueChange={(id) => handleSelectActive("llm", id)}
          className="flex flex-col gap-2"
        >
          {models.map((entry) => {
            const status = getStatus(entry.id)
            const canActivate = status === "ready"
            const isDownloading = status === "downloading"
            const fit = getLlmVramFit(entry.size_bytes, hardware)
            const showLangBadge = (sourceLanguage || targetLanguage) && isLangRecommended(entry.name)
            return (
              <div
                key={entry.id}
                className={cn(
                  "flex flex-col rounded-lg border p-3 transition-colors",
                  status === "ready"
                    ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                    : "hover:bg-muted/30",
                )}
              >
                <div className="flex items-center gap-3">
                  {canActivate && (
                    <RadioGroupItem value={entry.id} id={`model-${entry.id}`} />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`model-${entry.id}`} className="text-sm font-medium cursor-pointer">
                        {entry.name}
                      </Label>
                      <span className="text-[10px] text-muted-foreground font-mono">{entry.quant}</span>
                      {entry.model_category === "instruct" && (
                        <Badge variant="secondary" className="text-[10px] h-4">
                          {t("settings.models.categoryInstruct")}
                        </Badge>
                      )}
                      {entry.model_category === "general" && (
                        <Badge variant="outline" className="text-[10px] h-4">
                          {t("settings.models.categoryGeneral")}
                        </Badge>
                      )}
                      {showLangBadge && (
                        <Badge variant="secondary" className="text-[10px] h-4 gap-0.5 bg-blue-600/20 text-blue-500">
                          <Globe className="h-2.5 w-2.5" />
                          {t("settings.models.langRecommended")}
                        </Badge>
                      )}
                      {entry.id === activeLlmModel && (
                        <Badge variant="default" className="text-[10px] h-5 gap-1">
                          <CheckCircle2 className="h-3 w-3" />
                          {t("settings.models.active")}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                      <span>{formatSize(entry.size_bytes)}</span>
                      {renderStatusBadge(status)}
                      {renderVramBadge(fit)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {renderActions(entry.id, status)}
                  </div>
                </div>
                {isDownloading && renderDownloadProgress(entry.id)}
              </div>
            )
          })}
        </RadioGroup>
      </div>
    )
  }

  // GPU info summary card
  function renderGpuCard() {
    if (hardware?.gpu) {
      return (
        <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
          <Monitor className="h-5 w-5 text-green-500 shrink-0" />
          <div className="text-sm">
            <span className="font-medium">{hardware.gpu.name}</span>
            <span className="text-muted-foreground ml-2">
              {formatVram(hardware.gpu.vram_mb)} VRAM
            </span>
          </div>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
        <Cpu className="h-5 w-5 text-yellow-500 shrink-0" />
        <span className="text-sm text-muted-foreground">
          {t("settings.models.noGpu")}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold">{t("settings.models.title")}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t("settings.models.description")}</p>
      </div>

      {renderGpuCard()}

      {!catalog ? (
        <p className="text-sm text-muted-foreground">{t("settings.models.empty")}</p>
      ) : (
        <>
          {renderWhisperModels(catalog.whisper_models)}
          {renderLlmModels(catalog.llm_models)}
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => { if (!o) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("settings.models.confirmDelete")}</AlertDialogTitle>
            <AlertDialogDescription>{t("settings.models.confirmDeleteMsg")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("shared.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) onDelete(deleteTarget); setDeleteTarget(null) }}
            >
              {t("settings.models.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
