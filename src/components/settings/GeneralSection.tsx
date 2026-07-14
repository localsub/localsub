import { useTranslation } from "react-i18next"
import { FolderOpen } from "lucide-react"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { pickDirectory } from "@/lib/tauriApi"
import type { AppConfig, PartialConfig } from "@/types"

interface GeneralSectionProps {
  config: AppConfig
  onUpdate: (patch: PartialConfig) => void
}

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ko", label: "한국어" },
  { value: "ja", label: "日本語" },
  { value: "zh-CN", label: "简体中文" },
  { value: "es", label: "Español" },
]

const FORMATS = [
  { value: "srt", label: "SRT" },
  { value: "vtt", label: "VTT" },
  { value: "ass", label: "ASS" },
  { value: "txt", label: "TXT" },
]

export function GeneralSection({ config, onUpdate }: GeneralSectionProps) {
  const { t, i18n } = useTranslation()

  function handleLanguageChange(lang: string) {
    i18n.changeLanguage(lang)
    localStorage.setItem("ui_language", lang)
    onUpdate({ ui_language: lang })
  }

  async function browseOutputDir() {
    const dir = await pickDirectory()
    if (dir) onUpdate({ output_dir: dir })
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold">{t("settings.general.title")}</h3>
        <p className="text-sm text-muted-foreground mt-1">{t("settings.general.description")}</p>
      </div>

      {/* UI Language */}
      <div className="flex flex-col gap-2">
        <Label>{t("settings.language.title")}</Label>
        <RadioGroup
          value={config.ui_language ?? "en"}
          onValueChange={handleLanguageChange}
          className="flex gap-4"
        >
          {LANGUAGES.map((lang) => (
            <div key={lang.value} className="flex items-center gap-2">
              <RadioGroupItem value={lang.value} id={`lang-${lang.value}`} />
              <Label htmlFor={`lang-${lang.value}`} className="font-normal cursor-pointer">{lang.label}</Label>
            </div>
          ))}
        </RadioGroup>
      </div>

      <Separator />

      {/* Output Format */}
      <div className="flex flex-col gap-2">
        <Label>{t("settings.general.outputFormat")}</Label>
        <Select value={config.subtitle_format} onValueChange={(v) => onUpdate({ subtitle_format: v })}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
          </SelectContent>
        </Select>
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

    </div>
  )
}
