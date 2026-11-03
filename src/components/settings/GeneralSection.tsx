import { useTranslation } from "react-i18next"
import { FolderOpen } from "lucide-react"
import * as RadioGroupPrimitive from "@radix-ui/react-radio-group"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { pickDirectory } from "@/lib/tauriApi"
import { SOURCE_LANGUAGES } from "@/lib/languages"
import { SectionHeader, SettingsCard, SettingsRow } from "./SettingsCard"
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
    <div className="flex flex-col gap-5">
      <SectionHeader title={t("settings.general.title")} description={t("settings.general.description")} />

      <SettingsCard>
        {/* UI Language */}
        <SettingsRow>
          <span id="settings-ui-language" className="text-[15px] font-bold">{t("settings.language.title")}</span>
          <RadioGroupPrimitive.Root
            value={config.ui_language ?? "en"}
            onValueChange={handleLanguageChange}
            aria-labelledby="settings-ui-language"
            className="flex flex-wrap gap-2"
          >
            {LANGUAGES.map((lang) => (
              <RadioGroupPrimitive.Item
                key={lang.value}
                value={lang.value}
                className="h-10 cursor-pointer rounded-md bg-muted px-4 text-sm font-semibold text-foreground-secondary transition-[background-color,color,box-shadow] duration-150 ease-out hover:bg-muted-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=checked]:bg-primary-soft data-[state=checked]:shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
              >
                {lang.label}
              </RadioGroupPrimitive.Item>
            ))}
          </RadioGroupPrimitive.Root>
        </SettingsRow>

        {/* Source Language — the wizard can't be re-run, so this is the only way to change it later */}
        <SettingsRow className="flex-row items-center">
          <div className="flex flex-1 flex-col gap-1">
            <span id="settings-source-language" className="text-[15px] font-bold">{t("settings.general.sourceLanguage")}</span>
            <p id="settings-source-language-desc" className="text-[13px] text-muted-foreground">{t("settings.general.sourceLanguageDesc")}</p>
          </div>
          <Select value={config.source_language} onValueChange={(v) => onUpdate({ source_language: v })}>
            <SelectTrigger
              aria-labelledby="settings-source-language"
              aria-describedby="settings-source-language-desc"
              // Grows past 180px for long names ("Detección automática") instead of clipping them
              className="h-11 w-auto min-w-[180px] shrink-0 px-3.5 font-bold"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SOURCE_LANGUAGES.map((l) => (
                <SelectItem key={l} value={l}>{t(`settings.general.sourceLangs.${l}`)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>

        {/* Boost Quiet Speech — the server applies it while extracting audio for STT */}
        <SettingsRow className="flex-row items-center">
          <div className="flex flex-1 flex-col gap-1">
            <span id="settings-boost-quiet-speech" className="text-[15px] font-bold">{t("settings.general.boostQuietSpeech")}</span>
            <p id="settings-boost-quiet-speech-desc" className="text-[13px] text-muted-foreground">{t("settings.general.boostQuietSpeechDesc")}</p>
          </div>
          <Switch
            checked={config.boost_quiet_speech ?? false}
            onCheckedChange={(v) => onUpdate({ boost_quiet_speech: v })}
            aria-labelledby="settings-boost-quiet-speech"
            aria-describedby="settings-boost-quiet-speech-desc"
          />
        </SettingsRow>

        {/* Output Format */}
        <SettingsRow className="flex-row items-center">
          <span id="settings-output-format" className="flex-1 text-[15px] font-bold">{t("settings.general.outputFormat")}</span>
          <Select value={config.subtitle_format} onValueChange={(v) => onUpdate({ subtitle_format: v })}>
            <SelectTrigger aria-labelledby="settings-output-format" className="h-11 w-[180px] px-3.5 font-bold"><SelectValue /></SelectTrigger>
            <SelectContent>
              {FORMATS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsRow>

        {/* Output Directory */}
        <SettingsRow className="gap-2.5">
          <span id="settings-output-dir" className="text-[15px] font-bold">{t("settings.paths.outputDir")}</span>
          <div className="flex gap-2">
            <Input value={config.output_dir} readOnly title={config.output_dir} aria-labelledby="settings-output-dir" className="min-w-0 flex-1" />
            <Button
              size="icon"
              className="size-12 bg-primary-soft text-primary-text hover:bg-primary-soft/70"
              aria-label={t("settings.paths.outputDir")}
              onClick={browseOutputDir}
            >
              <FolderOpen />
            </Button>
          </div>
          <p className="text-[13px] text-muted-foreground">{t("settings.paths.outputDirDesc")}</p>
        </SettingsRow>
      </SettingsCard>
    </div>
  )
}
