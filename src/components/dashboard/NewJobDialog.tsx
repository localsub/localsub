import { useState, useCallback, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Upload, X, FileVideo, FileText, Eye, RefreshCw, Play, BookOpen, Plus, Trash2, Languages } from "lucide-react"
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
import { isAcceptedFile, isSubtitleFile } from "@/lib/sourceType"
import type { Preset, Vocabulary, VocabularyEntry } from "@/types"

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
    <div className="rounded-md border p-3 flex flex-col gap-2 bg-background">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{vocab.name}</span>
        <span className="text-[11px] text-muted-foreground">{entries.length} entries</span>
      </div>
      <div className="flex flex-col gap-1.5 max-h-52 overflow-y-auto p-0.5 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
        {entries.map((entry) => (
          <div key={entry.id} className="flex items-center gap-1.5">
            <Input
              value={entry.source}
              onChange={(e) => updateEntry(entry.id, "source", e.target.value)}
              placeholder={t("dashboard.newJob.preview.source")}
              className="h-7 text-xs flex-1 min-w-0 focus-visible:ring-1 focus-visible:ring-offset-0"
            />
            <span className="text-muted-foreground text-xs shrink-0">→</span>
            <Input
              value={entry.target}
              onChange={(e) => updateEntry(entry.id, "target", e.target.value)}
              placeholder={t("dashboard.newJob.preview.target")}
              className="h-7 text-xs flex-1 min-w-0 focus-visible:ring-1 focus-visible:ring-offset-0"
            />
            <button
              type="button"
              onClick={() => removeEntry(entry.id)}
              className="shrink-0 p-0.5 text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={addEntry}>
          <Plus className="mr-1 h-3 w-3" /> {t("dashboard.newJob.preview.add")}
        </Button>
        <div className="flex-1" />
        <Button size="sm" className="h-7 text-xs" onClick={handleSave} disabled={saving}>
          {saving ? t("dashboard.newJob.preview.saving") : t("dashboard.newJob.preview.save")}
        </Button>
      </div>
    </div>
  )
}

export function NewJobDialog({ open, onOpenChange, presets, vocabularies, onSubmit, onUpdateVocabulary, onAddVocabulary, onUpdatePreset, initialFiles }: NewJobDialogProps) {
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
      { name: "Media", extensions: ["mp4", "mkv", "avi", "mov", "mp3", "wav", "m4a", "flac"] },
      { name: "Subtitles", extensions: ["srt", "vtt"] },
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
      <DialogContent className={`${showPreview ? "sm:max-w-3xl" : "sm:max-w-xl"} max-h-[85vh] flex flex-col overflow-hidden`}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("dashboard.newJob.title", "New Job")}</DialogTitle>
          <DialogDescription>
            {t("dashboard.newJob.description", "Upload files and select a preset to start processing.")}
          </DialogDescription>
        </DialogHeader>

        {/* Setup installs ffmpeg; this is the backstop for installs that skipped
            it, and it must sit outside the preview pane — that is where it was
            hidden while long videos silently went unchunked. */}
        {ffmpegReady === false && (
          <div className="shrink-0 flex items-center gap-2 rounded-md bg-yellow-500/10 border border-yellow-500/30 px-3 py-2 text-xs">
            <span className="text-yellow-600 dark:text-yellow-400 flex-1">
              {t("dashboard.newJob.ffmpegMissing")}
            </span>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs shrink-0"
              onClick={handleDownloadFfmpeg}
              disabled={ffmpegDownloading}
            >
              {ffmpegDownloading
                ? t("dashboard.newJob.preview.ffmpegDownloading", "Downloading...")
                : t("dashboard.newJob.preview.ffmpegInstall", "Auto Install")}
            </Button>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-y-auto [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
          <div className="flex flex-col gap-5 py-2 pr-1">
          {/* File drop zone */}
          <div
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={handleFileSelect}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") handleFileSelect() }}
            className={`flex items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors cursor-pointer ${
              files.length > 0 ? "p-3" : "flex-col p-6"
            } ${
              isDragging
                ? "border-primary bg-primary/5"
                : files.length > 0
                  ? "border-primary/40 bg-primary/5 hover:bg-primary/10"
                  : "border-muted-foreground/25 hover:border-muted-foreground/50"
            }`}
          >
            {files.length > 0 ? (
              <>
                <FileVideo className="h-4 w-4 text-primary shrink-0" />
                <span className="text-sm text-primary font-medium">{t("dashboard.newJob.preview.filesSelected", { count: files.length })}</span>
                <span className="text-xs text-muted-foreground ml-1">{t("dashboard.newJob.preview.clickToAdd")}</span>
              </>
            ) : (
              <>
                <div className="rounded-xl bg-muted/60 p-3 ring-1 ring-border">
                  <Upload className="h-5 w-5 text-muted-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {t("dashboard.newJob.dropzone", "Drag and drop files here, or click to browse")}
                </p>
                <p className="text-xs text-muted-foreground/60">
                  {t("dashboard.newJob.supportedFormats")}
                </p>
              </>
            )}
          </div>

          {/* Subtitle translation mode notice */}
          {subtitleCount > 0 && (
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="shrink-0 gap-1.5 font-medium">
                <Languages className="h-3 w-3" />
                {t("dashboard.newJob.subtitleMode.badge")}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {t("dashboard.newJob.subtitleMode.hint")}
              </span>
            </div>
          )}

          {/* File list */}
          {files.length > 0 && (
            <ScrollArea className="max-h-36">
              <div className="flex flex-col gap-1.5">
                {files.map((file, i) => (
                  <div
                    key={`${file.name}-${i}`}
                    className="flex items-center gap-3 rounded-md bg-muted/50 px-3 py-2 text-sm"
                  >
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-muted">
                      {isSubtitleFile(file.path) ? (
                        <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <FileVideo className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                    <span className="flex-1 truncate">{file.name}</span>
                    {file.size > 0 && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {formatSize(file.size)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeFile(i) }}
                      className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground transition-colors"
                      aria-label={`Remove ${file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}

          {/* Preset selection */}
          {presets.length > 0 && (
            <div className="flex flex-col gap-2.5">
              <Label className="text-sm font-medium">{t("dashboard.newJob.preset", "Preset")}</Label>
              <RadioGroup value={selectedPreset} onValueChange={setSelectedPreset}>
                <div className="flex flex-col gap-2">
                  {presets.map((preset) => (
                    <label
                      key={preset.id}
                      className={`flex items-start gap-3 rounded-lg border p-3 cursor-pointer transition-colors ${
                        selectedPreset === preset.id
                          ? "border-primary bg-primary/5"
                          : "hover:bg-muted/50"
                      }`}
                    >
                      <RadioGroupItem value={preset.id} className="mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium">{preset.name}</span>
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {preset.whisper_model.toUpperCase()} / {preset.llm_model} / {preset.output_format.toUpperCase()}
                        </p>
                      </div>
                    </label>
                  ))}
                </div>
              </RadioGroup>
              {linkedVocab && (
                <p className="text-xs text-muted-foreground">
                  {t("dashboard.newJob.linkedVocab")} <span className="font-medium text-foreground">{linkedVocab.name}</span> ({t("presets.dialog.entriesCount", { count: linkedVocab.entries.length })})
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
                  <div className={`flex items-center justify-between rounded-lg border p-3 ${allSubtitles ? "opacity-60" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <Label className="text-sm font-medium">{t("dashboard.newJob.skipTranslation", "STT Only")}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
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
                    <p className="text-xs">{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>

              {/* Speaker diarization toggle — 로직은 유지하되 UI에서만 숨김 */}
              {SHOW_DIARIZATION && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={`flex items-center justify-between rounded-lg border p-3 ${allSubtitles ? "opacity-60" : ""}`}>
                    <div className="flex-1 min-w-0">
                      <Label className="text-sm font-medium">{t("dashboard.newJob.enableDiarization", "Speaker Diarization")}</Label>
                      <p className="text-xs text-muted-foreground mt-0.5">
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
                    <p className="text-xs">{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
              )}
            </div>
          </TooltipProvider>

          {presets.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-2">
              {t("dashboard.newJob.noPresets", "No presets available. Create one in the Presets page.")}
            </p>
          )}

          {/* Preview panel */}
          {showPreview && (
            <div className="rounded-lg border bg-muted/20 p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <Eye className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">{t("dashboard.newJob.preview.title")}</span>
              </div>

              {/* The ffmpeg banner lives at the top of the dialog now. */}

              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">{t("dashboard.newJob.preview.startLabel")}</span>
                <Input
                  value={previewStart}
                  onChange={(e) => setPreviewStart(e.target.value)}
                  placeholder="MM:SS"
                  className="w-24 h-8 text-sm text-center"
                />
                <span className="text-xs text-muted-foreground shrink-0">{t("dashboard.newJob.preview.duration")}</span>
                <Select value={previewDuration} onValueChange={setPreviewDuration}>
                  <SelectTrigger className="h-8 w-[84px] text-sm">
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
                <Button
                  size="sm"
                  variant="default"
                  onClick={handleStartPreview}
                  disabled={files.length === 0 || !selectedPreset || preview.phase === "stt" || preview.phase === "translating"}
                >
                  <Play className="mr-1 h-3.5 w-3.5" />
                  {preview.hasCachedStt ? t("dashboard.newJob.preview.runSttAndTranslate") : t("dashboard.newJob.preview.run")}
                </Button>
                {preview.hasCachedStt && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleRetryPreviewTranslation}
                    disabled={preview.phase === "stt" || preview.phase === "translating"}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    {t("dashboard.newJob.preview.retryTranslation")}
                  </Button>
                )}
              </div>

              {/* Progress */}
              {(preview.phase === "stt" || preview.phase === "translating") && (
                <div className="flex flex-col gap-1.5">
                  <Progress value={preview.progress} className="h-2" />
                  <p className="text-xs text-muted-foreground">{preview.message}</p>
                </div>
              )}

              {/* Error */}
              {preview.phase === "error" && preview.error && (
                <p className="text-xs text-destructive">{preview.error}</p>
              )}

              {/* Results table — max-h scales with viewport so long previews scroll nicely instead of getting clipped to ~5 rows */}
              {preview.results.length > 0 && (
                <ScrollArea className="max-h-[50vh] min-h-48 flex-1">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs text-muted-foreground">
                        <th className="text-left py-1.5 pr-2 w-16">{t("dashboard.newJob.preview.time")}</th>
                        <th className="text-left py-1.5 pr-2">{t("dashboard.newJob.preview.original")}</th>
                        <th className="text-left py-1.5">{t("dashboard.newJob.preview.translated")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.results.map((r) => (
                        <tr key={r.index} className="border-b border-muted/50">
                          <td className="py-1.5 pr-2 text-xs text-muted-foreground whitespace-nowrap">
                            {formatTimestamp(r.start)}
                          </td>
                          <td className="py-1.5 pr-2 text-xs">{r.original}</td>
                          <td className="py-1.5 text-xs font-medium">
                            {r.translated || <span className="text-muted-foreground">...</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollArea>
              )}

              {preview.hasCachedStt && preview.phase !== "stt" && preview.phase !== "translating" && (
                <p className="text-[11px] text-muted-foreground">
                  {t("dashboard.newJob.preview.sttCached")}
                </p>
              )}

              {/* Vocab quick edit */}
              {linkedVocab && onUpdateVocabulary ? (
                <div className="flex flex-col gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-fit h-7 text-xs"
                    onClick={() => setVocabEditOpen(!vocabEditOpen)}
                  >
                    <BookOpen className="mr-1 h-3 w-3" />
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
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <BookOpen className="h-3 w-3 shrink-0" />
                  <span>{t("dashboard.newJob.preview.noVocab")}</span>
                  {onAddVocabulary && onUpdatePreset && selectedPresetData && (
                    <Button
                      variant="link"
                      size="sm"
                      className="h-5 text-xs px-0"
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
        </div>
        </div>

        <DialogFooter className="shrink-0">
          <div className="flex items-center gap-2 w-full">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* span wrapper: disabled buttons swallow hover, so the tooltip needs an enabled target */}
                  <span className="mr-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowPreview(!showPreview)}
                      disabled={files.length === 0 || !selectedPreset || previewUnavailable}
                    >
                      <Eye className="mr-1.5 h-4 w-4" />
                      {showPreview ? t("dashboard.newJob.preview.close") : t("dashboard.newJob.preview.open")}
                    </Button>
                  </span>
                </TooltipTrigger>
                {previewUnavailable && (
                  <TooltipContent side="top" className="max-w-xs">
                    <p className="text-xs">{t("dashboard.newJob.subtitleMode.unavailable")}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t("shared.cancel", "Cancel")}
            </Button>
            <Button onClick={handleSubmit} disabled={files.length === 0 || !selectedPreset}>
              {files.length > 1
                ? t("dashboard.newJob.startMultiple", { count: files.length, defaultValue: `Start ${files.length} jobs` })
                : t("dashboard.newJob.start", "Start job")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
