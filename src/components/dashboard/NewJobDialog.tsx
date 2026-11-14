import { useState, useCallback, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogScrollLayout,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Upload, X, FileVideo, FileText, Eye, RefreshCw, Play, BookOpen, Plus, Trash2, Languages, AlertTriangle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { pickFile, checkFfmpeg, downloadFfmpeg } from "@/lib/tauriApi"
import { usePreviewPipeline } from "@/hooks/usePreviewPipeline"
import { cn } from "@/lib/utils"
import { MEDIA_EXTENSIONS, SUBTITLE_EXTENSIONS, isAcceptedFile, isSubtitleFile } from "@/lib/sourceType"
import type { Preset, Vocabulary, VocabularyEntry } from "@/types"
import { friendlySttError } from "@/lib/sttModels"

interface NewJobDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  presets: Preset[]
  vocabularies: Vocabulary[]
  onSubmit: (files: SelectedFile[], presetId: string, enableDiarization: boolean, skipTranslation: boolean) => void
  onUpdateVocabulary?: (vocab: Vocabulary) => Promise<unknown>
  onAddVocabulary?: (vocab: Vocabulary) => Promise<unknown>
  onUpdatePreset?: (preset: Preset) => Promise<unknown>
  initialFiles?: SelectedFile[]
  /** Opens the Presets page (closing this dialog), for when there is none. */
  onGoToPresets?: () => void
}

export interface SelectedFile {
  name: string
  path: string
  size: number
}

function formatSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`
  return `${(bytes / 1e6).toFixed(0)} MB`
}

function parseTimeToSeconds(timeStr: string): number | null {
  const parts = timeStr.trim().split(":")
  if (parts.length === 2) {
    const [m, s] = parts.map(Number)
    if (!isNaN(m) && !isNaN(s)) return m * 60 + s
  }
  if (parts.length === 3) {
    const [h, m, s] = parts.map(Number)
    if (!isNaN(h) && !isNaN(m) && !isNaN(s)) return h * 3600 + m * 60 + s
  }
  return null
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`
}

function InlineVocabEditor({ vocab, onSave }: { vocab: Vocabulary; onSave: (v: Vocabulary) => Promise<unknown> }) {
  const { t } = useTranslation()
  const [entries, setEntries] = useState<VocabularyEntry[]>(vocab.entries)
  const [saving, setSaving] = useState(false)

  // Sync when vocab changes externally
  useEffect(() => { setEntries(vocab.entries) }, [vocab.entries])

  function addEntry() {
    setEntries((prev) => [...prev, { id: `new-${Date.now()}`, source: "", target: "" }])
  }

  function updateEntry(id: string, field: "source" | "target", value: string) {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, [field]: value } : e)))
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((e) => e.id !== id))
  }

  async function handleSave() {
    setSaving(true)
    const valid = entries.filter((e) => e.source.trim() && e.target.trim())
    await onSave({ ...vocab, entries: valid, updated_at: new Date().toISOString() })
    setSaving(false)
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-[14px] bg-card p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-bold">{vocab.name}</span>
        <span className="text-[12.5px] text-muted-foreground">{entries.length} entries</span>
      </div>
      <div className="flex max-h-52 flex-col gap-2 overflow-y-auto p-0.5">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-2">
            <Input
              value={entry.source}
              onChange={(e) => updateEntry(entry.id, "source", e.target.value)}
              placeholder={t("dashboard.newJob.preview.source")}
              className="h-[38px] min-w-0 flex-1 rounded-[10px] px-3 text-sm"
            />
            <span className="shrink-0 text-[13px] text-muted-foreground">→</span>
            <Input
              value={entry.target}
              onChange={(e) => updateEntry(entry.id, "target", e.target.value)}
              placeholder={t("dashboard.newJob.preview.target")}
              className="h-[38px] min-w-0 flex-1 rounded-[10px] px-3 text-sm"
            />
            <button
              type="button"
              onClick={() => removeEntry(entry.id)}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-muted hover:text-status-error"
            >
              <Trash2 className="h-[15px] w-[15px]" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" className="h-9" onClick={addEntry}>
          <Plus /> {t("dashboard.newJob.preview.add")}
        </Button>
        <div className="flex-1" />
        <Button size="sm" className="h-9" onClick={handleSave} disabled={saving}>
          {saving ? t("dashboard.newJob.preview.saving") : t("dashboard.newJob.preview.save")}
        </Button>
      </div>
    </div>
  )
}

export function NewJobDialog({ open, onOpenChange, presets, vocabularies, onSubmit, onUpdateVocabulary, onAddVocabulary, onUpdatePreset, initialFiles, onGoToPresets }: NewJobDialogProps) {
  const { t } = useTranslation()
  const [files, setFiles] = useState<SelectedFile[]>([])

  // Load initial files from drag & drop
  useEffect(() => {
    if (open && initialFiles && initialFiles.length > 0) {
      setFiles(initialFiles)
    }
  }, [open, initialFiles])
  const [selectedPreset, setSelectedPreset] = useState(() => {
    const defaultPreset = presets.find((p) => p.is_default)
    return defaultPreset?.id ?? presets[0]?.id ?? ""
  })
  const [enableDiarization, setEnableDiarization] = useState(false)
  // 화자 검출(diarization) 컨트롤은 UI에서만 숨긴다. 상태·전달 로직은 그대로 유지.
  const SHOW_DIARIZATION = false
  const [skipTranslation, setSkipTranslation] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [showPreview, setShowPreview] = useState(false)
  const [previewStart, setPreviewStart] = useState("00:00")
  const [previewDuration, setPreviewDuration] = useState("2")

  const [vocabEditOpen, setVocabEditOpen] = useState(false)
  const [ffmpegReady, setFfmpegReady] = useState<boolean | null>(null)
  const [ffmpegDownloading, setFfmpegDownloading] = useState(false)

  const preview = usePreviewPipeline()

  // Check ffmpeg whenever the dialog opens — NOT only when the preview pane does.
  // ffprobe decides whether a >60min file is chunked, and its absence disables
  // chunking silently, so gating this check on the preview meant users who never
  // opened it were never told.
  useEffect(() => {
    if (open && ffmpegReady === null) {
      checkFfmpeg().then(setFfmpegReady).catch(() => setFfmpegReady(false))
    }
  }, [open, ffmpegReady])

  const handleDownloadFfmpeg = useCallback(async () => {
    setFfmpegDownloading(true)
    try {
      await downloadFfmpeg()
      setFfmpegReady(true)
    } catch (e) {
      console.error("ffmpeg download failed:", e)
    } finally {
      setFfmpegDownloading(false)
    }
  }, [])

  const handleStartPreview = useCallback(() => {
    if (files.length === 0 || !selectedPreset) return
    if (isSubtitleFile(files[0].path)) return // preview runs STT — not applicable to subtitle files
    const startSec = parseTimeToSeconds(previewStart)
    if (startSec === null) return
    const endSec = startSec + Number(previewDuration) * 60
    preview.startPreview(files[0].path, selectedPreset, startSec, endSec)
  }, [files, selectedPreset, previewStart, previewDuration, preview])

  const handleRetryPreviewTranslation = useCallback(() => {
    if (!selectedPreset) return
    preview.retryTranslation(selectedPreset)
  }, [selectedPreset, preview])

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    const droppedFiles = Array.from(e.dataTransfer.files)
      // Extension check is required for subtitles: .srt/.vtt have no MIME type
      .filter((f) => f.type.startsWith("video/") || f.type.startsWith("audio/") || isAcceptedFile(f.name))
      .map((f) => ({
        name: f.name,
        path: f.name, // Tauri will resolve actual path via dialog
        size: f.size,
      }))
    setFiles((prev) => [...prev, ...droppedFiles])
  }, [])

  const handleFileSelect = useCallback(async () => {
    const path = await pickFile([
      // Same lists as drag & drop, so the picker can't drift from them
      { name: "Media", extensions: [...MEDIA_EXTENSIONS] },
      { name: "Subtitles", extensions: [...SUBTITLE_EXTENSIONS] },
    ])
    if (path) {
      const name = path.split(/[/\\]/).pop() ?? path
      setFiles((prev) => [...prev, { name, path, size: 0 }])
    }
  }, [])

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const handleSubmit = useCallback(() => {
    if (files.length === 0 || !selectedPreset) return
    onSubmit(files, selectedPreset, enableDiarization, skipTranslation)
    setFiles([])
    setEnableDiarization(false)
    setSkipTranslation(false)
    onOpenChange(false)
  }, [files, selectedPreset, enableDiarization, skipTranslation, onSubmit, onOpenChange])

  const selectedPresetData = presets.find((p) => p.id === selectedPreset)
  const linkedVocab = selectedPresetData
    ? vocabularies.find((v) => v.id === selectedPresetData.vocabulary_id)
    : null

  // Subtitle translation mode: imported .srt/.vtt files skip STT, so the
  // STT-only options (diarization, STT-only, preview) don't apply to them.
  const subtitleCount = files.filter((f) => isSubtitleFile(f.path)).length
  const allSubtitles = files.length > 0 && subtitleCount === files.length
  const previewUnavailable = files.length > 0 && isSubtitleFile(files[0].path)

  // Close an already-open preview panel if the first file becomes a subtitle
  useEffect(() => {
    if (previewUnavailable) setShowPreview(false)
  }, [previewUnavailable])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          "flex max-h-[min(840px,calc(100vh-3.5rem))] max-w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden p-0",
          showPreview ? "w-[780px] sm:max-w-[780px]" : "w-[580px] sm:max-w-[580px]",
        )}
      >
        <DialogScrollLayout
          bodyClassName={showPreview ? "gap-3.5" : "gap-5"}
          header={<>
        <DialogHeader>
          <DialogTitle>{t("dashboard.newJob.title", "New Job")}</DialogTitle>
          <DialogDescription>
            {t("dashboard.newJob.description", "Upload files and select a preset to start processing.")}
          </DialogDescription>
        </DialogHeader>

        {/* Setup installs ffmpeg; this is the backstop for installs that skipped
            it, and it must sit outside the preview pane — that is where it was
            hidden while long videos silently went unchunked. */}
        {ffmpegReady === false && (
          <div className="mt-5 flex items-center gap-3 rounded-[14px] bg-status-warning-soft px-4 py-3">
            <AlertTriangle className="h-[18px] w-[18px] shrink-0 text-status-warning" />
            <span className="flex-1 text-[13.5px] font-semibold leading-snug text-status-warning">
              {t("dashboard.newJob.ffmpegMissing")}
            </span>
            <Button
              size="sm"
              variant="secondary"
              className="h-9 shrink-0 bg-card hover:bg-card/70"
              onClick={handleDownloadFfmpeg}
              disabled={ffmpegDownloading}
            >
              {ffmpegDownloading
                ? t("dashboard.newJob.preview.ffmpegDownloading", "Downloading...")
                : t("dashboard.newJob.preview.ffmpegInstall", "Auto Install")}
            </Button>
          </div>
        )}
          </>}
          footer={
          <div className="flex w-full items-center gap-2">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper: disabled buttons swallow hover, so the tooltip needs an enabled target */}
                  <span className="mr-auto">
                    <Button
                      variant="ghost"
                      className={cn(
                        "gap-1.5 px-1.5 text-[14.5px] hover:bg-transparent [&_svg]:size-[17px]",
                        showPreview ? "text-primary-text hover:text-primary-text" : "text-foreground-secondary",
                      )}
                      onClick={() => setShowPreview(!showPreview)}
                      disabled={files.length === 0 || !selectedPreset || previewUnavailable}
                    >
                      <Eye />
                      {showPreview ? t("dashboard.newJob.preview.close") : t("dashboard.newJob.preview.open")}
                    </Button>
                  </span>
                </TooltipTrigger>
                {previewUnavailable && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p>{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {t("shared.cancel", "Cancel")}
            </Button>
            <Button className="px-[22px]" onClick={handleSubmit} disabled={files.length === 0 || !selectedPreset}>
              {files.length > 1
                ? t("dashboard.newJob.startMultiple", { count: files.length, defaultValue: `Start ${files.length} jobs` })
                : t("dashboard.newJob.start", "Start job")}
            </Button>
          </div>
          }
        >
          {/* File drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleFileSelect}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleFileSelect() }}
            className={cn(
              "flex cursor-pointer items-center rounded-[14px] outline-none transition-[background-color,box-shadow] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-ring",
              files.length > 0
                ? "h-[52px] shrink-0 gap-2 bg-primary-soft px-4 text-[14.5px] font-bold text-primary-text"
                : "flex-col justify-center gap-1.5 rounded-[18px] bg-muted px-6 py-8 text-center hover:bg-muted-hover",
              isDragging && "bg-primary-soft shadow-[inset_0_0_0_2px_hsl(var(--primary))] hover:bg-primary-soft",
            )}
          >
            {files.length > 0 ? (
              <>
                <Upload className="h-[18px] w-[18px] shrink-0" />
                <span>{t("dashboard.newJob.preview.filesSelected", { count: files.length })}</span>
                <span className="font-medium opacity-80">{t("dashboard.newJob.preview.clickToAdd")}</span>
              </>
            ) : (
              <>
                <div className="mb-2 flex h-[52px] w-[52px] items-center justify-center rounded-[16px] bg-primary-soft text-primary-text">
                  <Upload className="h-[22px] w-[22px]" />
                </div>
                <p className="text-[15px] font-bold">
                  {t("dashboard.newJob.dropzone", "Drag and drop files here, or click to browse")}
                </p>
                <p className="text-[12.5px] text-muted-foreground">
                  {t("dashboard.newJob.supportedFormats")}
                </p>
              </>
            )}
          </div>

          {/* Subtitle translation mode notice */}
          {subtitleCount > 0 && (
            <div className="flex items-center gap-2.5">
              <Badge className="shrink-0">
                <Languages className="h-3.5 w-3.5" />
                {t("dashboard.newJob.subtitleMode.badge")}
              </Badge>
              <span className="text-[12.5px] text-muted-foreground">
                {t("dashboard.newJob.subtitleMode.hint")}
              </span>
            </div>
          )}

          {/* File list */}
          {files.length > 0 && (
            <div className="flex max-h-[156px] shrink-0 flex-col gap-1.5 overflow-y-auto">
              {files.map((file, i) => (
                <div
                  key={`${file.name}-${i}`}
                  className="flex h-12 shrink-0 items-center gap-3 rounded-md bg-muted px-3.5 text-[14.5px]"
                >
                  {isSubtitleFile(file.path) ? (
                    <FileText className="h-[17px] w-[17px] shrink-0 text-muted-foreground" />
                  ) : (
                    <FileVideo className="h-[17px] w-[17px] shrink-0 text-muted-foreground" />
                  )}
                  <span className="flex-1 truncate font-semibold">{file.name}</span>
                  {file.size > 0 && (
                    <span className="shrink-0 text-[13px] text-muted-foreground">
                      {formatSize(file.size)}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeFile(i) }}
                    className="-mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                    aria-label={`Remove ${file.name}`}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Preset selection */}
          {presets.length > 0 && (
            <div className="flex flex-col gap-2">
              <Label className="text-sm font-bold text-foreground-secondary">{t("dashboard.newJob.preset", "Preset")}</Label>
              <RadioGroup value={selectedPreset} onValueChange={setSelectedPreset} className="gap-2">
                {presets.map((preset) => (
                  <label
                    key={preset.id}
                    className={cn(
                      "flex cursor-pointer items-center gap-3.5 rounded-[14px] px-[18px] py-3.5 transition-[background-color,box-shadow] duration-150 ease-out",
                      selectedPreset === preset.id
                        ? "bg-primary-soft shadow-[inset_0_0_0_2px_hsl(var(--primary))]"
                        : "bg-muted hover:bg-muted-hover",
                    )}
                  >
                    <RadioGroupItem value={preset.id} />
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <span className="truncate text-[15px] font-bold">{preset.name}</span>
                      <span className="truncate text-[12.5px] text-muted-foreground">
                        {preset.whisper_model.toUpperCase()} / {preset.llm_model} / {preset.output_format.toUpperCase()}
                      </span>
                    </div>
                  </label>
                ))}
              </RadioGroup>
              {linkedVocab && (
                <p className="text-[13px] text-muted-foreground">
                  {t("dashboard.newJob.linkedVocab")} <span className="font-bold text-foreground">{linkedVocab.name}</span> ({t("presets.dialog.entriesCount", { count: linkedVocab.entries.length })})
                </p>
              )}
            </div>
          )}

          {/* Pipeline options — STT-only, so disabled in subtitle translation mode */}
          <TooltipProvider>
            <div className="flex flex-col gap-2">
              {/* Skip translation toggle */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn("flex items-center gap-3 rounded-[14px] bg-muted px-[18px] py-3.5", allSubtitles && "opacity-60")}>
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <Label className="text-[15px] font-bold">{t("dashboard.newJob.skipTranslation", "STT Only")}</Label>
                      <p className="text-[12.5px] text-muted-foreground">
                        {t("dashboard.newJob.skipTranslationDesc", "Transcribe only — skip the translation step")}
                      </p>
                    </div>
                    <Switch
                      checked={!allSubtitles && skipTranslation}
                      onCheckedChange={setSkipTranslation}
                      disabled={allSubtitles}
                    />
                  </div>
                </TooltipTrigger>
                {allSubtitles && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p>{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>

              {/* Speaker diarization toggle — 로직은 유지하되 UI에서만 숨김 */}
              {SHOW_DIARIZATION && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn("flex items-center gap-3 rounded-[14px] bg-muted px-[18px] py-3.5", allSubtitles && "opacity-60")}>
                    <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                      <Label className="text-[15px] font-bold">{t("dashboard.newJob.enableDiarization", "Speaker Diarization")}</Label>
                      <p className="text-[12.5px] text-muted-foreground">
                        {t("dashboard.newJob.enableDiarizationDesc", "Detect and label different speakers in the audio")}
                      </p>
                    </div>
                    <Switch
                      checked={!allSubtitles && enableDiarization}
                      onCheckedChange={setEnableDiarization}
                      disabled={allSubtitles}
                    />
                  </div>
                </TooltipTrigger>
                {allSubtitles && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p>{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
              )}
            </div>
          </TooltipProvider>

          {presets.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-2 text-center">
              <p className="text-sm text-muted-foreground">
                {t("dashboard.newJob.noPresets", "No presets available. Create one in the Presets page.")}
              </p>
              {onGoToPresets && (
                <Button
                  variant="secondary"
                  onClick={() => {
                    onOpenChange(false)
                    onGoToPresets()
                  }}
                >
                  <Plus />
                  {t("dashboard.newJob.goToPresets")}
                </Button>
              )}
            </div>
          )}

          {/* Preview panel */}
          {showPreview && (
            <div className="flex flex-col gap-3.5 rounded-[20px] bg-muted p-5">
              <div className="flex items-center gap-2 text-[15px] font-extrabold">
                <Eye className="h-[17px] w-[17px] text-primary-text" />
                {t("dashboard.newJob.preview.title")}
              </div>

              {/* The ffmpeg banner lives at the top of the dialog now. */}

              <div className="flex items-center gap-2">
                <span className="shrink-0 text-[13.5px] font-bold text-foreground-secondary">{t("dashboard.newJob.preview.startLabel")}</span>
                <Input
                  value={previewStart}
                  onChange={(e) => setPreviewStart(e.target.value)}
                  placeholder="MM:SS"
                  className="h-10 w-[92px] rounded-[11px] bg-card px-2 text-center text-[14.5px] font-semibold tabular-nums"
                />
                <span className="ml-1.5 shrink-0 text-[13.5px] font-bold text-foreground-secondary">{t("dashboard.newJob.preview.duration")}</span>
                <Select value={previewDuration} onValueChange={setPreviewDuration}>
                  <SelectTrigger className="h-10 w-[88px] rounded-[11px] bg-card px-3 text-[14.5px] font-semibold [&>svg]:h-3.5 [&>svg]:w-3.5">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5].map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {m} min
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="flex-1" />
                {preview.hasCachedStt && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="h-10 rounded-[11px] bg-card hover:bg-card/70 [&_svg]:size-3.5"
                    onClick={handleRetryPreviewTranslation}
                    disabled={preview.phase === "stt" || preview.phase === "translating"}
                  >
                    <RefreshCw strokeWidth={2.4} />
                    {t("dashboard.newJob.preview.retryTranslation")}
                  </Button>
                )}
                <Button
                  size="sm"
                  className="h-10 rounded-[11px] [&_svg]:size-[13px]"
                  onClick={handleStartPreview}
                  disabled={files.length === 0 || !selectedPreset || preview.phase === "stt" || preview.phase === "translating"}
                >
                  <Play fill="currentColor" />
                  {preview.hasCachedStt ? t("dashboard.newJob.preview.runSttAndTranslate") : t("dashboard.newJob.preview.run")}
                </Button>
              </div>

              {/* Progress */}
              {(preview.phase === "stt" || preview.phase === "translating") && (
                <div className="flex flex-col gap-2">
                  <Progress value={preview.progress} className="h-1.5 bg-card" />
                  <p className="text-[12.5px] text-muted-foreground">{preview.message}</p>
                </div>
              )}

              {/* Error */}
              {preview.phase === "error" && preview.error && (
                <p className="text-[13px] font-semibold text-status-error">{friendlySttError(preview.error, t)}</p>
              )}

              {/* Results table — max-h scales with viewport so long previews scroll inside the panel */}
              {preview.results.length > 0 && (
                <div className="max-h-[50vh] overflow-y-auto rounded-[14px] bg-card px-3.5 pb-1.5">
                  <table className="w-full table-fixed border-separate border-spacing-0">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-[12.5px] font-bold text-muted-foreground [&>th]:border-b [&>th]:border-border [&>th]:pb-2 [&>th]:pt-3.5">
                        <th className="w-[74px] pr-3.5">{t("dashboard.newJob.preview.time")}</th>
                        <th className="pr-3.5">{t("dashboard.newJob.preview.original")}</th>
                        <th>{t("dashboard.newJob.preview.translated")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.results.map((r) => (
                        <tr key={r.index} className="align-top text-sm leading-[1.45] [&>td]:border-b [&>td]:border-border [&>td]:py-2.5">
                          <td className="whitespace-nowrap pr-3.5 text-[12.5px] tabular-nums text-muted-foreground">
                            {formatTimestamp(r.start)}
                          </td>
                          <td className="pr-3.5 text-foreground-secondary">{r.original}</td>
                          <td className="font-semibold">
                            {r.translated || <span className="text-muted-foreground">...</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {preview.hasCachedStt && preview.phase !== "stt" && preview.phase !== "translating" && (
                <p className="text-[12.5px] leading-normal text-muted-foreground">
                  {t("dashboard.newJob.preview.sttCached")}
                </p>
              )}

              {/* Vocab quick edit */}
              {linkedVocab && onUpdateVocabulary ? (
                <div className="flex flex-col gap-3.5">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-9 w-fit rounded-[10px] bg-card px-3 text-[13.5px] hover:bg-card/70 [&_svg]:size-3.5"
                    onClick={() => setVocabEditOpen(!vocabEditOpen)}
                  >
                    <BookOpen />
                    {vocabEditOpen ? t("dashboard.newJob.preview.closeVocab") : `${t("dashboard.newJob.preview.editVocab")} (${linkedVocab.entries.length})`}
                  </Button>
                  {vocabEditOpen && (
                    <InlineVocabEditor
                      vocab={linkedVocab}
                      onSave={async (updated) => {
                        await onUpdateVocabulary(updated)
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <BookOpen className="h-3.5 w-3.5 shrink-0" />
                  <span>{t("dashboard.newJob.preview.noVocab")}</span>
                  {onAddVocabulary && onUpdatePreset && selectedPresetData && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-auto px-0 text-[12.5px] text-primary-text"
                      onClick={async () => {
                        const now = new Date().toISOString()
                        const baseName = t("dashboard.newJob.preview.tempVocabName")
                        const existingNames = new Set(vocabularies.map((v) => v.name))
                        let vocabName = baseName
                        let counter = 1
                        while (existingNames.has(vocabName)) {
                          vocabName = `${baseName}(${counter})`
                          counter++
                        }
                        const newVocab: Vocabulary = {
                          id: crypto.randomUUID(),
                          name: vocabName,
                          description: "",
                          source_lang: selectedPresetData.source_lang,
                          target_lang: selectedPresetData.target_lang,
                          entries: [],
                          created_at: now,
                          updated_at: now,
                        }
                        await onAddVocabulary(newVocab)
                        await onUpdatePreset({ ...selectedPresetData, vocabulary_id: newVocab.id, updated_at: now })
                        setVocabEditOpen(true)
                      }}
                    >
                      {t("dashboard.newJob.preview.createVocab")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          )}
        </DialogScrollLayout>
      </DialogContent>
    </Dialog>
  )
}
