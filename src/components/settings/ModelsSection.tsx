import { useState, useMemo, type ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { Trash2, Cpu, Monitor, Globe, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
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
  AlertDialogIcon,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { SectionHeader } from "./SettingsCard"
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

  function renderVramTag(fit: VramFit) {
    if (fit === "recommended") {
      return <Tag tone="ok">{t("settings.models.recommended")}</Tag>
    }
    if (fit === "cpu_only") {
      return <Tag tone="neutral" strong>{t("settings.models.cpuOnly")}</Tag>
    }
    return <Tag tone="warn">{t("settings.models.tooLarge")}</Tag>
  }

  // "Ready" and "not installed" are already said by the radio and the
  // delete/install action, so only the in-between states get a chip.
  function renderStatusTag(status: InstallStatus) {
    if (status === "ready" || status === "not_installed") return null
    const tone = status === "missing" || status === "corrupt" ? "error" : "primary"
    return <Tag tone={tone}>{t(`settings.models.status.${status}` as never)}</Tag>
  }

  function renderDownloadProgress(id: string) {
    const progress = downloads.get(id)
    if (!progress || progress.total === 0) {
      return (
        <div className="flex items-center gap-2 pl-9">
          <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
          <span className="text-xs text-muted-foreground">{t("settings.models.status.verifying")}</span>
        </div>
      )
    }
    const pct = Math.min((progress.downloaded / progress.total) * 100, 100)
    const fileLabel = progress.total_files > 1
      ? `(${progress.file_index + 1}/${progress.total_files}) ${progress.file_name}`
      : progress.file_name
    return (
      <div className="flex w-full flex-col gap-1.5 pl-9">
        <Progress value={pct} className="h-1.5" />
        <div className="flex items-center justify-between gap-3 text-xs tabular-nums text-muted-foreground">
          <span className="truncate">{fileLabel} — {pct.toFixed(1)}%</span>
          <span className="shrink-0">
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
        <button className={textActionClass} onClick={() => setDeleteTarget(id)}>
          {t("settings.models.delete")}
        </button>
      )
    }
    if (status === "downloading") {
      return (
        <button className={textActionClass} onClick={() => onCancelDownload(id)}>
          {t("shared.cancel")}
        </button>
      )
    }
    if (status === "not_installed" || status === "missing" || status === "corrupt") {
      return (
        <Button
          className="h-[38px] rounded-[11px] bg-primary-soft px-4 text-sm text-primary-text hover:bg-primary-soft/70"
          onClick={() => onDownload(id)}
        >
          {t("settings.models.install")}
        </Button>
      )
    }
    return null
  }

  function renderModelRow({
    id,
    name,
    nameExtra,
    size,
    license,
    licenseUrl,
    tags,
    isActive,
  }: {
    id: string
    name: string
    nameExtra?: ReactNode
    size: number
    license: string
    licenseUrl: string
    tags: ReactNode
    isActive: boolean
  }) {
    const status = getStatus(id)
    const canActivate = status === "ready"
    return (
      <div key={id} className="flex flex-col gap-3 rounded-lg px-4 py-3.5">
        <div className="flex items-center gap-3.5">
          {canActivate ? (
            <RadioGroupItem value={id} id={`model-${id}`} />
          ) : (
            // Placeholder ring keeps names aligned; only installed models can be chosen.
            <span aria-hidden className="size-[22px] shrink-0 rounded-full shadow-[inset_0_0_0_2px_hsl(var(--border))]" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor={`model-${id}`} className={cn("text-[15px] font-bold", canActivate && "cursor-pointer")}>
                {name}
              </Label>
              {nameExtra}
              {isActive && <Tag tone="primary">{t("settings.models.active")}</Tag>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-muted-foreground">
              <span className="tabular-nums">{formatSize(size)}</span>
              <a
                href={licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mr-0.5 underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {license}
              </a>
              {renderStatusTag(status)}
              {tags}
            </div>
          </div>
          <div className="flex shrink-0 items-center">
            {renderActions(id, status)}
          </div>
        </div>
        {status === "downloading" && renderDownloadProgress(id)}
      </div>
    )
  }

  function renderWhisperModels(models: WhisperModelEntry[]) {
    if (models.length === 0) return null
    return (
      <ModelGroup title={t("settings.models.whisperSection")}>
        <RadioGroup
          value={activeWhisperModel ?? ""}
          onValueChange={(id) => handleSelectActive("whisper", id)}
          className="gap-0"
        >
          {models.map((entry) =>
            renderModelRow({
              id: entry.id,
              name: entry.name,
              size: entry.total_size_bytes,
              license: entry.license,
              licenseUrl: entry.license_url,
              tags: renderVramTag(getWhisperFit(entry, profile)),
              isActive: entry.id === activeWhisperModel,
            }),
          )}
        </RadioGroup>
      </ModelGroup>
    )
  }

  function renderLlmModels(models: LlmModelEntry[]) {
    if (models.length === 0) return null
    return (
      <ModelGroup title={t("settings.models.llmSection")}>
        <RadioGroup
          value={activeLlmModel ?? ""}
          onValueChange={(id) => handleSelectActive("llm", id)}
          className="gap-0"
        >
          {models.map((entry) => {
            const showLangBadge = (sourceLanguage || targetLanguage) && isLangRecommended(entry.name)
            return renderModelRow({
              id: entry.id,
              name: entry.name,
              nameExtra: <span className="font-mono text-xs tracking-normal text-muted-foreground">{entry.quant}</span>,
              size: entry.size_bytes,
              license: entry.license,
              licenseUrl: entry.license_url,
              tags: (
                <>
                  {renderVramTag(getLlmVramFit(entry.size_bytes, hardware))}
                  {entry.model_category === "instruct" && <Tag tone="neutral">{t("settings.models.categoryInstruct")}</Tag>}
                  {entry.model_category === "general" && <Tag tone="neutral">{t("settings.models.categoryGeneral")}</Tag>}
                  {showLangBadge && (
                    <Tag tone="neutral">
                      <Globe className="size-3" />
                      {t("settings.models.langRecommended")}
                    </Tag>
                  )}
                </>
              ),
              isActive: entry.id === activeLlmModel,
            })
          })}
        </RadioGroup>
      </ModelGroup>
    )
  }

  // GPU info summary banner
  function renderGpuCard() {
    if (hardware?.gpu) {
      return (
        <div className="flex items-center gap-3.5 rounded-[16px] bg-status-success-soft px-5 py-[18px]">
          <Monitor className="size-5 shrink-0 text-status-success" />
          <span className="min-w-0 truncate text-[15px] font-bold">{hardware.gpu.name}</span>
          <span className="shrink-0 text-sm text-foreground-secondary">
            {formatVram(hardware.gpu.vram_mb)} VRAM
          </span>
        </div>
      )
    }
    return (
      <div className="flex items-center gap-3.5 rounded-[16px] bg-status-warning-soft px-5 py-[18px]">
        <Cpu className="size-5 shrink-0 text-status-warning" />
        <span className="text-[15px] font-bold">{t("settings.models.noGpu")}</span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-5">
      <SectionHeader title={t("settings.models.title")} description={t("settings.models.description")} />

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
            <AlertDialogIcon tone="destructive"><Trash2 /></AlertDialogIcon>
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

const textActionClass =
  "cursor-pointer rounded-sm px-1 text-sm font-semibold text-muted-foreground transition-colors hover:text-status-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

const TAG_TONES = {
  ok: "bg-status-success-soft text-status-success font-bold",
  warn: "bg-status-warning-soft text-status-warning font-bold",
  error: "bg-status-error-soft text-status-error font-bold",
  primary: "bg-primary-soft text-primary-text font-bold",
  neutral: "bg-muted text-foreground-secondary font-semibold",
} as const

/** 22px chip used for model fit, status and category. */
function Tag({ tone, strong, children }: { tone: keyof typeof TAG_TONES; strong?: boolean; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-[22px] items-center gap-1 rounded-[6px] px-[7px] text-xs", TAG_TONES[tone], strong && "font-bold")}>
      {children}
    </span>
  )
}

function ModelGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5">
      <h4 className="text-sm font-bold text-foreground-secondary">{title}</h4>
      <div className="rounded-xl bg-card p-1.5 shadow-card">{children}</div>
    </div>
  )
}
