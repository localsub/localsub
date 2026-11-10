import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Settings2,
  HardDrive,
  Info,
  RotateCcw,
} from "lucide-react"
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
import { cn } from "@/lib/utils"
import { toastSuccess, toastError } from "@/lib/toast"
import { GeneralSection } from "./GeneralSection"
import { ModelsSection } from "./ModelsSection"
import { InfoSection } from "./InfoSection"
import type { AppConfig, PartialConfig, ModelManifestEntry, ModelCatalog, HardwareInfo, SettingsTab, DownloadProgress, SttEngine } from "@/types"

const navItemClass =
  "flex h-11 cursor-pointer items-center gap-2.5 rounded-md px-3.5 text-left transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"

const TABS: { value: SettingsTab; icon: typeof Settings2; labelKey: string }[] = [
  { value: "general", icon: Settings2, labelKey: "settings.tabs.general" },
  { value: "models", icon: HardDrive, labelKey: "settings.tabs.models" },
  { value: "info", icon: Info, labelKey: "settings.tabs.info" },
]

interface SettingsPageProps {
  config: AppConfig
  manifest: ModelManifestEntry[]
  catalog: ModelCatalog | null
  hardware: HardwareInfo | null
  downloads: Map<string, DownloadProgress>
  installingPacks?: Set<SttEngine>
  onUpdateConfig: (partial: PartialConfig) => void
  onDeleteModel: (id: string) => void
  onDownloadModel: (id: string) => void
  onCancelDownload: (id: string) => void
}

export function SettingsPage({
  config,
  manifest,
  catalog,
  hardware,
  downloads,
  installingPacks,
  onUpdateConfig,
  onDeleteModel,
  onDownloadModel,
  onCancelDownload,
}: SettingsPageProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<SettingsTab>("general")
  const [resetDialogOpen, setResetDialogOpen] = useState(false)

  const DEFAULT_CONFIG: PartialConfig = {
    subtitle_format: "srt",
    source_language: "auto",
    boost_quiet_speech: false,
    max_concurrent_jobs: 1,
  }

  function handleResetDefaults() {
    try {
      onUpdateConfig(DEFAULT_CONFIG)
      toastSuccess(t("toast.configResetSuccess"))
    } catch {
      toastError(t("toast.configResetFailed"))
    }
    setResetDialogOpen(false)
  }

  return (
    <div className="flex min-h-0 flex-1 gap-8">
      {/* Left sub-navigation */}
      <nav className="flex w-[180px] shrink-0 flex-col gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon
          const active = activeTab === tab.value
          return (
            <button
              key={tab.value}
              aria-current={active ? "page" : undefined}
              className={cn(
                navItemClass,
                "text-[15px]",
                active
                  ? "bg-card font-bold text-foreground shadow-card"
                  : "font-semibold text-foreground-secondary hover:bg-muted-hover hover:text-foreground",
              )}
              onClick={() => setActiveTab(tab.value)}
            >
              <Icon className="size-[18px] shrink-0" />
              {t(tab.labelKey as never)}
            </button>
          )
        })}
        <div className="flex-1" />
        <button
          className={cn(navItemClass, "text-sm font-semibold text-muted-foreground hover:bg-muted-hover hover:text-foreground")}
          onClick={() => setResetDialogOpen(true)}
        >
          <RotateCcw className="size-4 shrink-0" />
          {t("settings.restoreDefaults")}
        </button>
      </nav>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogIcon tone="warning"><RotateCcw /></AlertDialogIcon>
            <AlertDialogTitle>{t("confirm.resetConfig")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirm.resetConfigMsg")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("shared.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleResetDefaults}>{t("shared.confirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Right content */}
      <div className="min-w-0 flex-1 overflow-y-auto px-1">
        <div className="max-w-[720px] pb-8">
          {activeTab === "general" && (
            <GeneralSection config={config} onUpdate={onUpdateConfig} />
          )}
          {activeTab === "models" && (
            <ModelsSection
              manifest={manifest}
              catalog={catalog}
              hardware={hardware}
              downloads={downloads}
              profile={config.profile}
              activeWhisperModel={config.active_whisper_model}
              activeLlmModel={config.active_llm_model}
              onUpdate={onUpdateConfig}
              onDelete={onDeleteModel}
              onDownload={onDownloadModel}
              onCancelDownload={onCancelDownload}
              sourceLanguage={config.source_language}
              targetLanguage={config.target_language}
              installingPacks={installingPacks}
            />
          )}
          {activeTab === "info" && (
            <InfoSection />
          )}
        </div>
      </div>
    </div>
  )
}
