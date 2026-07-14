import { useState } from "react"
import { useTranslation } from "react-i18next"
import {
  Settings2,
  HardDrive,
  Info,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
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
import { toastSuccess, toastError } from "@/lib/toast"
import { GeneralSection } from "./GeneralSection"
import { ModelsSection } from "./ModelsSection"
import { InfoSection } from "./InfoSection"
import type { AppConfig, PartialConfig, ModelManifestEntry, ModelCatalog, HardwareInfo, SettingsTab, DownloadProgress } from "@/types"

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
    <div className="flex gap-4 h-full">
      {/* Left sub-navigation */}
      <nav className="flex w-36 flex-shrink-0 flex-col gap-1">
        {TABS.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.value}
              className={`flex items-center gap-2.5 cursor-pointer rounded-md px-3 py-2 text-left text-sm transition-colors ${
                activeTab === tab.value
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
              onClick={() => setActiveTab(tab.value)}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {t(tab.labelKey as never)}
            </button>
          )
        })}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="sm"
          className="justify-start text-muted-foreground"
          onClick={() => setResetDialogOpen(true)}
        >
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          {t("settings.restoreDefaults")}
        </Button>
      </nav>

      <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
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
      <div className="flex-1 overflow-y-auto min-w-0 px-1">
        <div className="max-w-[600px] pb-8">
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
