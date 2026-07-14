import { useTranslation } from "react-i18next"
import { FolderOpen } from "lucide-react"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { pickDirectory } from "@/lib/tauriApi"
import type { AppConfig, PartialConfig } from "@/types"

interface PathsSectionProps {
  config: AppConfig
  onUpdate: (patch: PartialConfig) => void
}

export function PathsSection({ config, onUpdate }: PathsSectionProps) {
  const { t } = useTranslation()

  async function browseOutputDir() {
    const dir = await pickDirectory()
    if (dir) onUpdate({ output_dir: dir })
  }

  async function browseModelDir() {
    const dir = await pickDirectory()
    if (dir) onUpdate({ model_dir: dir })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold">{t("settings.paths.title")}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t("settings.paths.description")}</p>
      </div>

      {/* Output Directory */}
      <div className="flex flex-col gap-2">
        <Label>{t("settings.paths.outputDir")}</Label>
        <div className="flex gap-2">
          <Input value={config.output_dir} readOnly className="flex-1" />
          <Button variant="outline" size="icon" onClick={browseOutputDir}>
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.paths.outputDirDesc")}</p>
      </div>

      {/* Model Directory */}
      <div className="flex flex-col gap-2">
        <Label>{t("settings.paths.modelDir")}</Label>
        <div className="flex gap-2">
          <Input value={config.model_dir ?? ""} readOnly className="flex-1" placeholder={t("settings.paths.modelDirDefault")} />
          <Button variant="outline" size="icon" onClick={browseModelDir}>
            <FolderOpen className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("settings.paths.modelDirDesc")}</p>
      </div>
    </div>
  )
}
