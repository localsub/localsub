import { useState, useEffect, type ReactNode } from "react"
import {
  Plus,
  Pencil,
  Copy,
  Trash2,
  BookOpen,
  SlidersHorizontal,
  ChevronDown,
  MoreHorizontal,
  Star,
  Info,
  ArrowLeftRight,
} from "lucide-react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
  DialogScrollLayout,
} from "@/components/ui/dialog"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { PageActions } from "@/components/page-header"
import { toastSuccess, toastError } from "@/lib/toast"
import { pickFile, readCsvFile } from "@/lib/tauriApi"
import { cn } from "@/lib/utils"
import type { Preset, Vocabulary, VocabularyEntry, ModelManifestEntry, ModelCatalog } from "@/types"
import { helperModelIds, isQwen } from "@/lib/sttModels"

const LANG_KEYS = ["ko", "en", "ja", "zh"] as const
const STYLE_KEYS = ["natural", "formal", "casual"] as const
type StyleKey = (typeof STYLE_KEYS)[number]

/** Map legacy/unknown stored styles (e.g. "honorific") to "natural" for display.
 *  The stored value only changes when the user saves the preset. */
function normalizeStyle(style: string | undefined): StyleKey {
  return (STYLE_KEYS as readonly string[]).includes(style ?? "") ? (style as StyleKey) : "natural"
}

/** Label + control stack used by both dialogs. */
function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-[7px]">
      <Label htmlFor={htmlFor} className="flex items-center gap-1.5 text-[13.5px] font-bold text-foreground-secondary">
        {label}
      </Label>
      {children}
      {hint}
    </div>
  )
}

function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-[7px] bg-muted px-2 text-xs font-bold text-foreground-secondary", className)}>
      {children}
    </span>
  )
}

// ─── Preset Card ─────────────────────────────────────────────────

function PresetCard({
  preset,
  vocabName,
  isDefault,
  onEdit,
  onDuplicate,
  onDelete,
  onSetDefault,
}: {
  preset: Preset
  vocabName: string | null
  isDefault?: boolean
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
  onSetDefault?: () => void
}) {
  const { t } = useTranslation()
  const tiles: { label: string; value: string }[] = [
    { label: "STT", value: preset.whisper_model },
    { label: "LLM", value: preset.llm_model },
    {
      label: "Language",
      value: `${t(`presets.lang.${preset.source_lang}`, preset.source_lang)} → ${t(`presets.lang.${preset.target_lang}`, preset.target_lang)}`,
    },
    { label: "Style", value: t(`presets.style.${normalizeStyle(preset.translation_style)}`, preset.translation_style) },
  ]
  if (preset.translation_quality) {
    tiles.push({ label: "Quality", value: t(`presets.quality.${preset.translation_quality}`, preset.translation_quality) })
  }
  if (vocabName) {
    tiles.push({ label: t("presets.dialog.vocabDictionary"), value: vocabName })
  }

  return (
    <div className="flex flex-col gap-[18px] rounded-[20px] bg-card px-7 py-6 shadow-card">
      <div className="flex items-start gap-2.5">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-lg font-extrabold">{preset.name}</h3>
            <Chip>{preset.output_format.toUpperCase()}</Chip>
            {isDefault && (
              <Chip className="bg-primary-soft text-primary-text">
                <Star className="h-3 w-3" fill="currentColor" />
                {t("presets.default")}
              </Chip>
            )}
          </div>
          {preset.description && (
            <p className="line-clamp-1 text-sm text-muted-foreground">{preset.description}</p>
          )}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="-mr-2 -mt-1 h-9 w-9 shrink-0 rounded-[10px] text-muted-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground"
              aria-label="Preset actions"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[200px]">
            <DropdownMenuItem onClick={onEdit}>
              <Pencil /> {t("presets.actions.edit")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy /> {t("presets.actions.duplicate")}
            </DropdownMenuItem>
            {onSetDefault && !isDefault && (
              <DropdownMenuItem onClick={onSetDefault}>
                <Star /> {t("presets.actions.setDefault")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onDelete} className="text-status-error focus:text-status-error">
              <Trash2 /> {t("presets.actions.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
        {tiles.map((tile) => (
          <div key={tile.label} className="flex min-w-0 flex-col gap-1 rounded-md bg-muted px-3.5 py-3">
            <span className="truncate text-xs text-muted-foreground">{tile.label}</span>
            <span className="truncate text-sm font-bold" title={tile.value}>{tile.value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Vocabulary Card ─────────────────────────────────────────────

function VocabCard({
  vocab,
  onEdit,
  onDuplicate,
  onDelete,
}: {
  vocab: Vocabulary
  onEdit: () => void
  onDuplicate: () => void
  onDelete: () => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const langPair = `${t(`presets.lang.${vocab.source_lang}`, vocab.source_lang)} → ${t(`presets.lang.${vocab.target_lang}`, vocab.target_lang)}`

  return (
    <div className="overflow-hidden rounded-[20px] bg-card shadow-card">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 px-7 py-[22px] text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary-soft text-primary-text">
          <BookOpen className="h-5 w-5" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[17px] font-extrabold">{vocab.name}</h3>
            <Chip className="h-[22px] rounded-[6px] px-[7px]">
              {t("presets.dialog.entriesCount", { count: vocab.entries.length })}
            </Chip>
          </div>
          <p className="truncate text-[13.5px] text-muted-foreground" title={vocab.description || undefined}>
            {langPair}
            {vocab.description && ` · ${vocab.description}`}
          </p>
        </div>
        <ChevronDown
          className={cn("h-5 w-5 shrink-0 text-muted-foreground transition-transform duration-150", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <>
          <div className="mx-5 rounded-[14px] bg-muted px-4 py-1.5">
            <div className="grid h-10 grid-cols-2 items-center gap-4 text-[13px] font-semibold text-muted-foreground">
              <span>{t("presets.dialog.source")}</span>
              <span>{t("presets.dialog.target")}</span>
            </div>
            {vocab.entries.map((entry) => (
              <div
                key={entry.id}
                className="grid min-h-[42px] grid-cols-2 items-center gap-4 border-t border-border py-2 text-[15px]"
              >
                <span className="break-words font-bold">{entry.source}</span>
                <span className="break-words">{entry.target}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4">
            <Button variant="secondary" size="sm" className="h-10 px-4" onClick={onEdit}>
              {t("presets.actions.edit")}
            </Button>
            <Button variant="secondary" size="sm" className="h-10 px-4" onClick={onDuplicate}>
              {t("presets.actions.duplicate")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-10 px-4 text-status-error hover:bg-status-error-soft hover:text-status-error"
              onClick={onDelete}
            >
              {t("presets.actions.delete")}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Preset Dialog ───────────────────────────────────────────────

function PresetDialog({
  open, onOpenChange, initial, vocabularies, manifest, catalog, onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: Preset
  vocabularies: Vocabulary[]
  manifest: ModelManifestEntry[]
  catalog?: ModelCatalog | null
  onSave: (data: Omit<Preset, "id" | "created_at" | "updated_at">) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [whisperModel, setWhisperModel] = useState(initial?.whisper_model ?? "large-v3")
  const [sourceLang, setSourceLang] = useState(initial?.source_lang ?? "ko")
  const [targetLang, setTargetLang] = useState(initial?.target_lang ?? "en")
  const [outputFormat, setOutputFormat] = useState(initial?.output_format ?? "srt")
  const [translationStyle, setTranslationStyle] = useState<string>(normalizeStyle(initial?.translation_style))
  const [llmModel, setLlmModel] = useState(initial?.llm_model ?? "qwen3-7b")
  const [vocabularyId, setVocabularyId] = useState(initial?.vocabulary_id ?? "none")
  const [translationQuality, setTranslationQuality] = useState(initial?.translation_quality ?? "balanced")
  const [customPrompt, setCustomPrompt] = useState(initial?.custom_translation_prompt ?? "")
  const [mediaType, setMediaType] = useState(initial?.media_type ?? "movie")

  // Reset form state whenever dialog is opened (or `initial` changes while open).
  // Without this, useState initializers only run once — editing another preset
  // would keep the previous form values and the Save button would stay disabled.
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? "")
    setDescription(initial?.description ?? "")
    setWhisperModel(initial?.whisper_model ?? "large-v3")
    setSourceLang(initial?.source_lang ?? "ko")
    setTargetLang(initial?.target_lang ?? "en")
    setOutputFormat(initial?.output_format ?? "srt")
    setTranslationStyle(normalizeStyle(initial?.translation_style))
    setLlmModel(initial?.llm_model ?? "qwen3-7b")
    setVocabularyId(initial?.vocabulary_id ?? "none")
    setTranslationQuality(initial?.translation_quality ?? "balanced")
    setCustomPrompt(initial?.custom_translation_prompt ?? "")
    setMediaType(initial?.media_type ?? "movie")
  }, [open, initial])

  function handleSave() {
    if (!name.trim()) return
    // The select lists only source→target vocabularies. An id picked for another
    // pair (or a former pivot preset's pivot→target one) would otherwise be saved
    // while the select shows "none".
    const vocab = vocabularies.find(
      (v) => v.id === vocabularyId && v.source_lang === sourceLang && v.target_lang === targetLang,
    )
    onSave({
      name: name.trim(),
      description: description.trim(),
      whisper_model: whisperModel,
      source_lang: sourceLang,
      target_lang: targetLang,
      output_format: outputFormat,
      translation_style: translationStyle,
      llm_model: llmModel,
      vocabulary_id: vocab ? vocab.id : null,
      translation_quality: translationQuality,
      custom_translation_prompt: customPrompt || undefined,
      media_type: mediaType || "movie",
      // The dialog no longer offers pivot 2-pass, so saving writes what it
      // shows: a direct translation with the one vocabulary above.
      translation_mode: "direct",
      pivot_language: initial?.pivot_language ?? "en",
      pivot_vocabulary_id: null,
    })
    onOpenChange(false)
  }

  // Helper models (the Qwen aligner) are installed STT models too, but never a choice.
  const helpers = helperModelIds(catalog ?? null)
  const whisperModels = manifest.filter((m) => m.model_type === "whisper" && m.status === "ready" && !helpers.has(m.id))
  const sttEntry = catalog?.whisper_models.find((m) => m.id === whisperModel)
  // A model that times subtitles for only some languages (Qwen3-ASR) offers only those.
  const sourceLangKeys = sttEntry?.languages
    ? LANG_KEYS.filter((k) => sttEntry.languages!.includes(k))
    : LANG_KEYS
  const llmModels = manifest.filter((m) => m.model_type === "llm" && m.status === "ready")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(820px,calc(100vh-3.5rem))] w-[680px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[680px]">
        <DialogScrollLayout
          bodyClassName="gap-[18px] pt-1"
          header={
            <DialogHeader>
              <DialogTitle>{initial ? t("presets.dialog.editPreset") : t("presets.dialog.newPreset")}</DialogTitle>
              <DialogDescription>{t("presets.dialog.presetDescription")}</DialogDescription>
            </DialogHeader>
          }
          footer={
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("presets.dialog.cancel")}</Button>
              <Button className="px-[22px]" onClick={handleSave} disabled={!name.trim()}>
                {initial ? t("presets.dialog.saveChanges") : t("presets.dialog.createPreset")}
              </Button>
            </DialogFooter>
          }
        >
          <Field label={t("presets.dialog.name")} htmlFor="preset-name">
            <Input id="preset-name" value={name} onChange={(e) => setName(e.target.value)} className="font-semibold" />
          </Field>
          <Field label={t("presets.dialog.description")} htmlFor="preset-desc">
            <Textarea
              id="preset-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="h-16 min-h-16 resize-none"
            />
          </Field>

          <div className="grid grid-cols-2 gap-x-2.5 gap-y-3">
            <Field label={t("presets.dialog.whisperModel")}>
              <Select value={whisperModel} onValueChange={setWhisperModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {whisperModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                  {whisperModels.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">{t("presets.dialog.noModelsInstalled")}</div>
                  )}
                </SelectContent>
              </Select>
              {isQwen(sttEntry) && (
                <p className="text-xs text-muted-foreground">{t("presets.dialog.qwenLanguagesNote")}</p>
              )}
            </Field>
            <Field label={t("presets.dialog.llmModel")}>
              <Select value={llmModel} onValueChange={setLlmModel}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {llmModels.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
                  ))}
                  {llmModels.length === 0 && (
                    <div className="px-3 py-2 text-sm text-muted-foreground">{t("presets.dialog.noModelsInstalled")}</div>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("presets.dialog.sourceLang")}>
              <Select value={sourceLang} onValueChange={setSourceLang}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {sourceLangKeys.map((k) => (
                    <SelectItem key={k} value={k}>{t(`presets.lang.${k}`, k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("presets.dialog.targetLang")}>
              <Select value={targetLang} onValueChange={setTargetLang}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANG_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>{t(`presets.lang.${k}`, k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("presets.dialog.outputFormat")}>
              <Select value={outputFormat} onValueChange={setOutputFormat}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="srt">SRT</SelectItem>
                  <SelectItem value="ass">ASS</SelectItem>
                  <SelectItem value="vtt">VTT</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("presets.dialog.translationStyle")}>
              <Select value={translationStyle} onValueChange={setTranslationStyle}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {STYLE_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>{t(`presets.style.${k}`, k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label={t("presets.dialog.vocabDictionary")}>
            <Select value={vocabularyId ?? "none"} onValueChange={setVocabularyId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t("presets.dialog.none")}</SelectItem>
                {vocabularies
                  .filter((v) => v.source_lang === sourceLang && v.target_lang === targetLang)
                  .map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} ({t("presets.dialog.entriesCount", { count: v.entries.length })})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label={t("settings.translation.quality.title", "Translation Quality")}>
            <div role="radiogroup" className="grid grid-cols-3 gap-0.5 rounded-[14px] bg-muted p-1">
              {(["fast", "balanced", "best"] as const).map((tier) => {
                const selected = translationQuality === tier
                return (
                  <button
                    key={tier}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTranslationQuality(tier)}
                    className={cn(
                      "h-10 rounded-[10px] text-[14.5px] outline-none transition-[background-color,color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "bg-card font-bold text-foreground shadow-segment"
                        : "font-semibold text-foreground-secondary hover:text-foreground",
                    )}
                  >
                    {t(`presets.quality.${tier}`, tier)}
                  </button>
                )
              })}
            </div>
          </Field>

          <Field
            label={
              <>
                Media Type
                <TooltipProvider delayDuration={200}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Info className="h-3.5 w-3.5 cursor-help text-muted-foreground" />
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-[260px]">
                      <p>영상 유형에 따라 번역 톤이 달라집니다. 자유롭게 입력 가능합니다.</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </>
            }
            hint={<p className="text-[12.5px] text-muted-foreground">영상 유형에 따라 번역 톤이 달라집니다. 자유롭게 입력 가능합니다.</p>}
          >
            <Input value={mediaType} onChange={(e) => setMediaType(e.target.value)} placeholder="movie, anime, drama..." />
          </Field>

          <Field label={t("presets.customPrompt", "Custom Instructions")}>
            <p className="text-[12.5px] text-muted-foreground">LLM이 이해할 수 있도록 영문으로 작성하세요.</p>
            <Textarea
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              rows={3}
              placeholder="e.g., Use casual tone, preserve honorifics, keep character names in katakana..."
              className="h-24 min-h-24 resize-none text-[14.5px] leading-[1.55]"
            />
          </Field>
        </DialogScrollLayout>
      </DialogContent>
    </Dialog>
  )
}

// ─── Vocabulary entries list (shared by both tabs in VocabDialog) ──

function EntriesTable({
  entries,
  updateEntry,
  removeEntry,
  onToggleFallback,
  toggleLabel,
}: {
  entries: VocabularyEntry[]
  updateEntry: (id: string, field: keyof VocabularyEntry, value: string) => void
  removeEntry: (id: string) => void
  onToggleFallback: (id: string) => void
  toggleLabel: string
}) {
  const { t } = useTranslation()
  if (entries.length === 0) {
    return (
      <div className="rounded-[14px] bg-muted p-6 text-center text-[13px] text-muted-foreground">
        {t("presets.vocab.tabs.empty", "아직 항목이 없습니다. 아래 '항목 추가' 버튼을 눌러 시작하세요.")}
      </div>
    )
  }
  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex flex-col gap-1.5">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-1.5">
            <Input
              value={entry.source}
              onChange={(e) => updateEntry(entry.id, "source", e.target.value)}
              placeholder={t("presets.dialog.source")}
              aria-label={t("presets.dialog.source")}
              className="h-10 min-w-0 flex-1 rounded-[10px] px-3 text-[14.5px] font-semibold"
            />
            <Input
              value={entry.target}
              onChange={(e) => updateEntry(entry.id, "target", e.target.value)}
              placeholder={t("presets.dialog.target")}
              aria-label={t("presets.dialog.target")}
              className="h-10 min-w-0 flex-1 rounded-[10px] px-3 text-[14.5px]"
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 rounded-sm text-muted-foreground [&_svg]:size-4"
                  onClick={() => onToggleFallback(entry.id)}
                  aria-label={toggleLabel}
                >
                  <ArrowLeftRight />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="left">{toggleLabel}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-sm text-muted-foreground hover:bg-status-error-soft hover:text-status-error [&_svg]:size-4"
              onClick={() => removeEntry(entry.id)}
              aria-label={t("presets.actions.delete")}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </TooltipProvider>
  )
}

// ─── Vocabulary Dialog ───────────────────────────────────────────

function VocabDialog({
  open, onOpenChange, initial, onSave,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  initial?: Vocabulary
  onSave: (data: Omit<Vocabulary, "id" | "created_at" | "updated_at">) => void
}) {
  const { t } = useTranslation()
  const [name, setName] = useState(initial?.name ?? "")
  const [description, setDescription] = useState(initial?.description ?? "")
  const [sourceLang, setSourceLang] = useState(initial?.source_lang ?? "ja")
  const [targetLang, setTargetLang] = useState(initial?.target_lang ?? "ko")
  const [entries, setEntries] = useState<VocabularyEntry[]>(
    initial?.entries ?? [{ id: "new-1", source: "", target: "" }]
  )
  const [activeTab, setActiveTab] = useState<"fewshot" | "fallback">("fewshot")

  // Reset form when dialog opens or `initial` changes (see PresetDialog above).
  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? "")
    setDescription(initial?.description ?? "")
    setSourceLang(initial?.source_lang ?? "ja")
    setTargetLang(initial?.target_lang ?? "ko")
    setEntries(initial?.entries ?? [{ id: "new-1", source: "", target: "" }])
    setActiveTab("fewshot")
  }, [open, initial])

  const fewshotEntries = entries.filter((e) => !e.fallback_only)
  const fallbackEntries = entries.filter((e) => e.fallback_only === true)

  function addEntry() {
    setEntries((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        source: "",
        target: "",
        fallback_only: activeTab === "fallback",
      },
    ])
  }

  async function handleImportCsv() {
    try {
      const path = await pickFile([{ name: "CSV", extensions: ["csv"] }])
      if (!path) return
      const rows = await readCsvFile(path)
      if (rows.length === 0) {
        toastError(t("presets.vocab.importFailed"))
        return
      }
      const mapped: VocabularyEntry[] = rows.map((row) => ({
        id: `csv-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: row.source,
        target: row.target,
        fallback_only: activeTab === "fallback",
      }))
      setEntries((prev) => [...prev, ...mapped])
      toastSuccess(t("presets.vocab.imported", { count: rows.length }))
    } catch {
      toastError(t("presets.vocab.importFailed"))
    }
  }

  function updateEntry(id: string, field: keyof VocabularyEntry, value: string) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)))
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  function toggleFallbackOnly(id: string) {
    setEntries((prev) =>
      prev.map((e) =>
        e.id === id ? { ...e, fallback_only: !e.fallback_only } : e,
      ),
    )
  }

  function handleSave() {
    if (!name.trim()) return
    const validEntries = entries.filter((e) => e.source.trim() && e.target.trim())
    onSave({
      name: name.trim(),
      description: description.trim(),
      source_lang: sourceLang,
      target_lang: targetLang,
      entries: validEntries,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(840px,calc(100vh-3.5rem))] w-[660px] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[660px]">
        <DialogScrollLayout
          bodyClassName="gap-4"
          header={
            <DialogHeader>
              <DialogTitle>{initial ? t("presets.dialog.editVocab") : t("presets.dialog.newVocab")}</DialogTitle>
              <DialogDescription>{t("presets.dialog.vocabDescription")}</DialogDescription>
            </DialogHeader>
          }
          footer={
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>{t("presets.dialog.cancel")}</Button>
              <Button className="px-[22px]" onClick={handleSave} disabled={!name.trim()}>
                {initial ? t("presets.dialog.saveChanges") : t("presets.dialog.createVocab")}
              </Button>
            </DialogFooter>
          }
        >
          <div className="grid grid-cols-2 gap-2.5">
            <Field label={t("presets.dialog.name")} htmlFor="vocab-name">
              <Input id="vocab-name" value={name} onChange={(e) => setName(e.target.value)} className="h-[46px] px-3.5 font-semibold" />
            </Field>
            <Field label={t("presets.dialog.description")} htmlFor="vocab-desc">
              <Input id="vocab-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="h-[46px] px-3.5" />
            </Field>
            <Field label={t("presets.dialog.sourceLang")}>
              <Select value={sourceLang} onValueChange={setSourceLang}>
                <SelectTrigger className="h-[46px] px-3.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANG_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>{t(`presets.lang.${k}`, k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("presets.dialog.targetLang")}>
              <Select value={targetLang} onValueChange={setTargetLang}>
                <SelectTrigger className="h-[46px] px-3.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LANG_KEYS.map((k) => (
                    <SelectItem key={k} value={k}>{t(`presets.lang.${k}`, k)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <div className="flex flex-col gap-2">
            <Label className="text-[13.5px] font-bold text-foreground-secondary">{t("presets.dialog.entries")}</Label>

            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "fewshot" | "fallback")}>
              <TabsList className="grid w-full grid-cols-2 gap-0.5 rounded-md">
                <TabsTrigger value="fewshot" className="group h-[38px] gap-1.5 rounded-[9px] text-sm">
                  {t("presets.vocab.tabs.fewshot", "Few-shot 주입")}
                  <span className="text-muted-foreground group-data-[state=active]:text-primary-text">{fewshotEntries.length}</span>
                </TabsTrigger>
                <TabsTrigger value="fallback" className="group h-[38px] gap-1.5 rounded-[9px] text-sm">
                  {t("presets.vocab.tabs.fallback", "후처리 치환")}
                  <span className="text-muted-foreground group-data-[state=active]:text-primary-text">{fallbackEntries.length}</span>
                </TabsTrigger>
              </TabsList>

              <TabsContent value="fewshot" className="flex flex-col gap-2">
                <p className="text-[12.5px] text-muted-foreground">
                  {t(
                    "presets.vocab.tabs.fewshotHint",
                    "고유명사, 용어, 스타일 예시 문장. 매 번역마다 LLM 프롬프트에 chat turn으로 주입됩니다.",
                  )}
                </p>
                <EntriesTable
                  entries={fewshotEntries}
                  updateEntry={updateEntry}
                  removeEntry={removeEntry}
                  onToggleFallback={toggleFallbackOnly}
                  toggleLabel={t("presets.vocab.moveToFallback", "→ 후처리 탭으로 이동")}
                />
              </TabsContent>

              <TabsContent value="fallback" className="flex flex-col gap-2">
                <p className="text-[12.5px] text-muted-foreground">
                  {t(
                    "presets.vocab.tabs.fallbackHint",
                    "LLM이 번역하지 못해 원문 그대로 반환할 때만 쓰이는 짧은 표현들. LLM 프롬프트에는 주입되지 않습니다.",
                  )}
                </p>
                <EntriesTable
                  entries={fallbackEntries}
                  updateEntry={updateEntry}
                  removeEntry={removeEntry}
                  onToggleFallback={toggleFallbackOnly}
                  toggleLabel={t("presets.vocab.moveToFewshot", "← Few-shot 탭으로 이동")}
                />
              </TabsContent>
            </Tabs>

            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="h-10 bg-primary-soft px-3.5 text-primary-text hover:bg-primary-soft/70"
                onClick={addEntry}
              >
                <Plus /> {t("presets.dialog.addEntry")}
              </Button>
              <Button variant="secondary" size="sm" className="h-10 px-3.5" onClick={handleImportCsv}>
                {t("presets.vocab.importCsv")}
              </Button>
            </div>
          </div>
        </DialogScrollLayout>
      </DialogContent>
    </Dialog>
  )
}

// ─── Page ────────────────────────────────────────────────────────

interface PresetsPageProps {
  presets: Preset[]
  vocabularies: Vocabulary[]
  manifest: ModelManifestEntry[]
  catalog?: ModelCatalog | null
  onAddPreset: (preset: Preset) => Promise<unknown>
  onUpdatePreset: (preset: Preset) => Promise<unknown>
  onRemovePreset: (id: string) => Promise<unknown>
  onAddVocabulary: (vocab: Vocabulary) => Promise<unknown>
  onUpdateVocabulary: (vocab: Vocabulary) => Promise<unknown>
  onRemoveVocabulary: (id: string) => Promise<unknown>
}

function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-card p-8 text-center shadow-card">
      <div className="mb-3 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] bg-primary-soft text-primary-text [&_svg]:h-8 [&_svg]:w-8">
        {icon}
      </div>
      <p className="text-[22px] font-extrabold">{title}</p>
      <p className="text-[15px] text-muted-foreground">{description}</p>
      <div className="mt-5">{action}</div>
    </div>
  )
}

export function PresetsPage({
  presets, vocabularies, manifest, catalog,
  onAddPreset, onUpdatePreset, onRemovePreset,
  onAddVocabulary, onUpdateVocabulary, onRemoveVocabulary,
}: PresetsPageProps) {
  const { t } = useTranslation()
  const [tab, setTab] = useState<"presets" | "vocabularies">("presets")
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)
  const [editingPreset, setEditingPreset] = useState<Preset | undefined>()
  const [vocabDialogOpen, setVocabDialogOpen] = useState(false)
  const [editingVocab, setEditingVocab] = useState<Vocabulary | undefined>()
  const [deleteTarget, setDeleteTarget] = useState<{ type: "preset" | "vocab"; id: string; name: string } | null>(null)

  function openNewPreset() { setEditingPreset(undefined); setPresetDialogOpen(true) }
  function openEditPreset(p: Preset) { setEditingPreset(p); setPresetDialogOpen(true) }

  function handleDuplicatePreset(p: Preset) {
    const now = new Date().toISOString()
    onAddPreset({ ...p, id: crypto.randomUUID(), name: `${p.name} (Copy)`, is_default: false, created_at: now, updated_at: now })
  }

  function handleDuplicateVocab(v: Vocabulary) {
    const now = new Date().toISOString()
    // Deep-copy entries with fresh IDs so editing the duplicate doesn't mutate the original.
    const clonedEntries: VocabularyEntry[] = v.entries.map((e) => ({
      ...e,
      id: crypto.randomUUID(),
    }))
    onAddVocabulary({
      ...v,
      id: crypto.randomUUID(),
      name: `${v.name} (Copy)`,
      entries: clonedEntries,
      created_at: now,
      updated_at: now,
    })
  }

  function handleSetDefault(presetId: string) {
    const now = new Date().toISOString()
    for (const p of presets) {
      if (p.is_default && p.id !== presetId) {
        onUpdatePreset({ ...p, is_default: false, updated_at: now })
      }
    }
    const target = presets.find((p) => p.id === presetId)
    if (target) {
      onUpdatePreset({ ...target, is_default: true, updated_at: now })
    }
  }

  function handleSavePreset(data: Omit<Preset, "id" | "created_at" | "updated_at">) {
    const now = new Date().toISOString()
    if (editingPreset) {
      onUpdatePreset({ ...editingPreset, ...data, updated_at: now })
    } else {
      onAddPreset({ ...data, id: crypto.randomUUID(), created_at: now, updated_at: now })
    }
  }

  function openNewVocab() { setEditingVocab(undefined); setVocabDialogOpen(true) }
  function openEditVocab(v: Vocabulary) { setEditingVocab(v); setVocabDialogOpen(true) }

  function handleSaveVocab(data: Omit<Vocabulary, "id" | "created_at" | "updated_at">) {
    const now = new Date().toISOString()
    if (editingVocab) {
      onUpdateVocabulary({ ...editingVocab, ...data, updated_at: now })
    } else {
      onAddVocabulary({ ...data, id: crypto.randomUUID(), created_at: now, updated_at: now })
    }
  }

  function getVocabName(id: string | null) {
    if (!id) return null
    return vocabularies.find((v) => v.id === id)?.name ?? null
  }

  return (
    <>
      <PageActions>
        {tab === "presets" ? (
          <Button className="h-[46px]" onClick={openNewPreset}><Plus /> {t("presets.newPreset", "New Preset")}</Button>
        ) : (
          <Button className="h-[46px]" onClick={openNewVocab}><Plus /> {t("presets.newVocab", "New Vocabulary")}</Button>
        )}
      </PageActions>

      <Tabs value={tab} onValueChange={(v) => setTab(v as "presets" | "vocabularies")} className="flex flex-1 flex-col gap-5">
        <div className="flex items-center gap-4">
          <TabsList className="gap-0.5">
            <TabsTrigger value="presets" className="group h-9 gap-1.5 text-sm">
              {t("presets.tabs.presets", "Job Presets")}
              <span className="text-muted-foreground group-data-[state=active]:text-primary-text">{presets.length}</span>
            </TabsTrigger>
            <TabsTrigger value="vocabularies" className="group h-9 gap-1.5 text-sm">
              {t("presets.tabs.vocabularies", "Vocabularies")}
              <span className="text-muted-foreground group-data-[state=active]:text-primary-text">{vocabularies.length}</span>
            </TabsTrigger>
          </TabsList>
          <p className="min-w-0 truncate text-sm text-muted-foreground">
            {tab === "presets"
              ? t("presets.presetsDesc", "Presets combine STT, translation, and vocabulary settings into reusable configurations.")
              : t("presets.vocabDesc", "Define how specific terms should be translated for consistency across jobs.")}
          </p>
        </div>

        <TabsContent value="presets" className="mt-0 flex flex-1 flex-col gap-3">
          {presets.map((p) => (
            <PresetCard
              key={p.id} preset={p}
              vocabName={getVocabName(p.vocabulary_id)}
              isDefault={!!p.is_default}
              onEdit={() => openEditPreset(p)}
              onDuplicate={() => handleDuplicatePreset(p)}
              onDelete={() => setDeleteTarget({ type: "preset", id: p.id, name: p.name })}
              onSetDefault={() => handleSetDefault(p.id)}
            />
          ))}
          {presets.length === 0 && (
            <EmptyState
              icon={<SlidersHorizontal />}
              title={t("presets.emptyPresets.title", "No presets yet")}
              description={t("presets.emptyPresets.description", "Create your first preset to get started.")}
              action={<Button size="lg" onClick={openNewPreset}><Plus /> {t("presets.newPreset", "New Preset")}</Button>}
            />
          )}
        </TabsContent>

        <TabsContent value="vocabularies" className="mt-0 flex flex-1 flex-col gap-3">
          {vocabularies.map((v) => (
            <VocabCard
              key={v.id}
              vocab={v}
              onEdit={() => openEditVocab(v)}
              onDuplicate={() => handleDuplicateVocab(v)}
              onDelete={() => setDeleteTarget({ type: "vocab", id: v.id, name: v.name })}
            />
          ))}
          {vocabularies.length === 0 && (
            <EmptyState
              icon={<BookOpen />}
              title={t("presets.emptyVocab.title", "No vocabularies yet")}
              description={t("presets.emptyVocab.description", "Create a vocabulary dictionary to ensure consistent translations.")}
              action={<Button size="lg" onClick={openNewVocab}><Plus /> {t("presets.newVocab", "New Vocabulary")}</Button>}
            />
          )}
        </TabsContent>
      </Tabs>

      <PresetDialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen} initial={editingPreset} vocabularies={vocabularies} manifest={manifest} catalog={catalog} onSave={handleSavePreset} />
      <VocabDialog open={vocabDialogOpen} onOpenChange={setVocabDialogOpen} initial={editingVocab} onSave={handleSaveVocab} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogIcon><Trash2 /></AlertDialogIcon>
            <AlertDialogTitle>
              {deleteTarget?.type === "preset" ? t("confirm.deletePreset") : t("confirm.deleteVocab")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.type === "preset" ? t("confirm.deletePresetMsg") : t("confirm.deleteVocabMsg")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("shared.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (!deleteTarget) return
                if (deleteTarget.type === "preset") {
                  onRemovePreset(deleteTarget.id)
                } else {
                  onRemoveVocabulary(deleteTarget.id)
                }
                setDeleteTarget(null)
              }}
            >
              {t("presets.actions.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
