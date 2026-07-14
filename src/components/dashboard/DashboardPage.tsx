import { useState, useMemo, useCallback, useEffect } from "react"
import { Plus, Trash2, FileVideo, FileText, Clock, Filter, MoreHorizontal, RotateCcw, Languages, Search, ArrowUpDown, PenLine, CheckCircle2, AlertCircle, Loader2, Play, PauseCircle } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toastInfo, toastError } from "@/lib/toast"
import { formatEta } from "@/lib/eta"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import { JobStatusBadge } from "./JobStatusBadge"
import { NewJobDialog, type SelectedFile } from "./NewJobDialog"
import { isAcceptedFile } from "@/lib/sourceType"
import type { JobStatus, DashboardJob, Preset, Vocabulary } from "@/types"

type SortOption = "newest" | "oldest" | "nameAsc" | "nameDesc"

interface DashboardPageProps {
  jobs: DashboardJob[]
  presets: Preset[]
  vocabularies: Vocabulary[]
  onNewJob: (files: SelectedFile[], presetId: string, enableDiarization: boolean, skipTranslation: boolean) => void
  onRemoveJob: (id: string) => void
  onRetryJob?: (jobId: string) => void
  onResumeJob?: (jobId: string) => void
  onOpenEditor?: (jobId: string, filePath: string) => void
  onUpdateVocabulary?: (vocab: Vocabulary) => Promise<unknown>
  onAddVocabulary?: (vocab: Vocabulary) => Promise<unknown>
  onUpdatePreset?: (preset: Preset) => Promise<unknown>
}

type FilterStatus = "all" | JobStatus

function formatDuration(sec: number) {
  if (sec <= 0) return "--"
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

function getRelativeTime(iso: string): { key: string; count?: number } | null {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return { key: "dashboard.time.justNow" }
  if (mins < 60) return { key: "dashboard.time.minsAgo", count: mins }
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return { key: "dashboard.time.hrsAgo", count: hrs }
  return null
}

function formatDateAbsolute(iso: string, locale: string) {
  const dateLocale = locale === "ko" ? "ko-KR" : "en-US"
  return new Date(iso).toLocaleDateString(dateLocale, { month: "short", day: "numeric" })
}

function formatProcessingTime(createdAt: string, completedAt?: string) {
  if (!completedAt) return null
  const diffMs = new Date(completedAt).getTime() - new Date(createdAt).getTime()
  if (diffMs < 0) return null
  const secs = Math.floor(diffMs / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  if (mins < 60) return `${mins}m ${remainSecs}s`
  const hrs = Math.floor(mins / 60)
  return `${hrs}h ${mins % 60}m`
}

export function DashboardPage({
  jobs,
  presets,
  vocabularies,
  onNewJob,
  onRemoveJob,
  onRetryJob,
  onResumeJob,
  onOpenEditor,
  onUpdateVocabulary,
  onAddVocabulary,
  onUpdatePreset,
}: DashboardPageProps) {
  const { t, i18n } = useTranslation()
  const [newJobOpen, setNewJobOpen] = useState(false)
  const [filter, setFilter] = useState<FilterStatus>("all")
  const [search, setSearch] = useState("")
  const [sort, setSort] = useState<SortOption>("newest")
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [droppedFiles, setDroppedFiles] = useState<SelectedFile[] | undefined>(undefined)

  // Tauri native drag-and-drop: provides full file paths
  useEffect(() => {
    let unlisten: (() => void) | undefined
    import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) => {
      getCurrentWebviewWindow().onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDraggingOver(true)
        } else if (event.payload.type === "leave") {
          setIsDraggingOver(false)
        } else if (event.payload.type === "drop") {
          setIsDraggingOver(false)
          const mediaFiles = event.payload.paths
            // Extension-based: .srt/.vtt have no MIME type, so media + subtitle
            // files are both matched by extension (see lib/sourceType)
            .filter(isAcceptedFile)
            .map((p) => ({
              name: p.split(/[/\\]/).pop() ?? p,
              path: p,
              size: 0,
            }))
          if (mediaFiles.length > 0) {
            setDroppedFiles(mediaFiles)
            setNewJobOpen(true)
          }
        }
      }).then((fn) => { unlisten = fn })
    })
    return () => { unlisten?.() }
  }, [])

  // Fallback: prevent default browser drop behavior
  const handlePageDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handlePageDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const handlePageDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  const filteredJobs = useMemo(() => {
    let result = filter === "all" ? jobs : jobs.filter((j) => j.status === filter)
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      result = result.filter((j) => j.file_name.toLowerCase().includes(q))
    }
    result = [...result].sort((a, b) => {
      switch (sort) {
        case "oldest": return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        case "nameAsc": return a.file_name.localeCompare(b.file_name)
        case "nameDesc": return b.file_name.localeCompare(a.file_name)
        default: return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      }
    })
    return result
  }, [jobs, filter, search, sort])

  const counts = useMemo(() => {
    const c: Record<JobStatus, number> & { all: number } = {
      all: jobs.length,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
    }
    for (const j of jobs) c[j.status] = (c[j.status] ?? 0) + 1
    return c
  }, [jobs])

  function getPresetName(presetId: string) {
    return presets.find((p) => p.id === presetId)?.name ?? "Unknown"
  }

  const FILTER_OPTIONS: { value: FilterStatus; label: string }[] = [
    { value: "all", label: `${t("dashboard.filter.all", "All")} (${counts.all})` },
    { value: "processing", label: `${t("dashboard.filter.processing", "Processing")} (${counts.processing})` },
    { value: "pending", label: `${t("dashboard.filter.pending", "Pending")} (${counts.pending})` },
    { value: "completed", label: `${t("dashboard.filter.completed", "Completed")} (${counts.completed})` },
    { value: "failed", label: `${t("dashboard.filter.failed", "Failed")} (${counts.failed})` },
    // Rare state — only worth a filter slot while it exists
    ...(counts.interrupted > 0 || filter === "interrupted"
      ? [{ value: "interrupted" as const, label: `${t("dashboard.filter.interrupted", "Interrupted")} (${counts.interrupted})` }]
      : []),
  ]

  return (
    <div
      className="relative flex flex-col flex-1"
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/5 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-2 text-primary">
            <FileVideo className="h-10 w-10" />
            <p className="text-sm font-medium">{t("dashboard.dropOverlay")}</p>
          </div>
        </div>
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 border-b px-0 pb-3 mb-4">
        <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-muted">
          <Filter className="h-3 w-3 text-muted-foreground" />
        </div>
        {FILTER_OPTIONS.map((opt) => (
          <Button
            key={opt.value}
            variant={filter === opt.value ? "secondary" : "ghost"}
            size="sm"
            onClick={() => setFilter(opt.value)}
            className="h-7 text-xs"
          >
            {opt.label}
          </Button>
        ))}
        <div className="flex-1" />
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("dashboard.search")}
            className="h-7 w-40 pl-8 text-xs"
          />
        </div>
        <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
          <SelectTrigger className="h-7 w-36 text-xs">
            <ArrowUpDown className="mr-1.5 h-3 w-3" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">{t("dashboard.sort.newest")}</SelectItem>
            <SelectItem value="oldest">{t("dashboard.sort.oldest")}</SelectItem>
            <SelectItem value="nameAsc">{t("dashboard.sort.nameAsc")}</SelectItem>
            <SelectItem value="nameDesc">{t("dashboard.sort.nameDesc")}</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" onClick={() => setNewJobOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          {t("dashboard.newJob.button", "New Job")}
        </Button>
      </div>

      {/* Stats summary */}
      {jobs.length > 0 && (
        <div className="flex items-center gap-4 mb-4 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CheckCircle2 className="h-3 w-3 text-green-500" />
            {counts.completed} {t("dashboard.filter.completed")}
          </span>
          <span className="inline-flex items-center gap-1">
            <Loader2 className="h-3 w-3 text-blue-500" />
            {counts.processing} {t("dashboard.filter.processing")}
          </span>
          <span className="inline-flex items-center gap-1">
            <AlertCircle className="h-3 w-3 text-red-500" />
            {counts.failed} {t("dashboard.filter.failed")}
          </span>
          {counts.interrupted > 0 && (
            <span className="inline-flex items-center gap-1">
              <PauseCircle className="h-3 w-3 text-status-warning" />
              {counts.interrupted} {t("dashboard.filter.interrupted")}
            </span>
          )}
        </div>
      )}

      {/* Job table */}
      {filteredJobs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
          <div className="rounded-2xl bg-muted/60 p-4 ring-1 ring-border">
            <FileVideo className="h-8 w-8 text-muted-foreground/70" />
          </div>
          <div>
            <p className="font-medium">{t("dashboard.empty.title", "No jobs yet")}</p>
            <p className="text-sm text-muted-foreground mt-1">
              {t("dashboard.empty.description", "Create a new job to start processing subtitles.")}
            </p>
          </div>
          <Button size="sm" onClick={() => setNewJobOpen(true)} className="mt-2">
            <Plus className="mr-1.5 h-4 w-4" />
            {t("dashboard.newJob.button", "New Job")}
          </Button>
        </div>
      ) : (
        <TooltipProvider>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[300px]">{t("dashboard.table.file", "File")}</TableHead>
                <TableHead>{t("dashboard.table.preset", "Preset")}</TableHead>
                <TableHead>{t("dashboard.table.status", "Status")}</TableHead>
                <TableHead>{t("dashboard.table.progress", "Progress")}</TableHead>
                <TableHead className="text-right">{t("dashboard.table.created", "Created")}</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredJobs.map((job) => (
                <TableRow
                  key={job.id}
                  className="group cursor-pointer"
                  onClick={() => {
                    if (job.status === "completed" || job.status === "processing" || job.status === "interrupted") {
                      // Interrupted jobs have checkpointed lines worth inspecting
                      onOpenEditor?.(job.id, job.file_path)
                    } else if (job.status === "pending") {
                      toastInfo(t("toast.jobStillProcessing"))
                    } else if (job.status === "failed") {
                      toastError(t("toast.jobFailedClick"), job.error)
                    }
                  }}
                >
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                        {job.source_type === "subtitle" ? (
                          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
                        ) : (
                          <FileVideo className="h-3.5 w-3.5 text-muted-foreground" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{job.file_name}</p>
                        {job.duration > 0 && (
                          <p className="text-xs text-muted-foreground">
                            {formatDuration(job.duration)}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="text-sm text-muted-foreground">
                      {getPresetName(job.preset_id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <JobStatusBadge status={job.status} stage={job.stage} />
                  </TableCell>
                  <TableCell>
                    {job.status === "processing" ? (
                      <div className="flex flex-col gap-1 min-w-[140px]">
                        {/* Subtitle imports have no STT stage — show only translation progress */}
                        {job.source_type !== "subtitle" && (
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] text-muted-foreground w-8 shrink-0">STT</span>
                            <Progress
                              value={job.stage === "stt" ? job.progress : 100}
                              className="h-1.5 flex-1"
                            />
                            <span className="text-[10px] tabular-nums text-muted-foreground w-7 text-right">
                              {job.stage === "stt" ? `${job.progress}%` : "100%"}
                            </span>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground w-8 shrink-0">{t("dashboard.table.translate", "번역")}</span>
                          <Progress
                            value={job.stage === "translating" ? job.progress : job.stage === "stt" || job.stage === "diarizing" ? 0 : 100}
                            className="h-1.5 flex-1"
                          />
                          <span className="text-[10px] tabular-nums text-muted-foreground w-7 text-right">
                            {job.stage === "translating" ? `${job.progress}%` : job.stage === "stt" || job.stage === "diarizing" ? "—" : "100%"}
                          </span>
                        </div>
                        {job.stage === "translating" && job.etaMs != null && (() => {
                          const eta = formatEta(job.etaMs)
                          return (
                            <span className="text-[10px] tabular-nums text-muted-foreground text-right">
                              {t(eta.key as never, { count: eta.count, minutes: eta.minutes })}
                            </span>
                          )
                        })()}
                      </div>
                    ) : job.status === "completed" ? (
                      <span className="text-xs text-muted-foreground">100%</span>
                    ) : job.status === "failed" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-xs text-status-error cursor-help">
                            Error
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p className="text-xs">{job.error}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : job.status === "interrupted" ? (
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {job.translated_count != null && job.translated_count > 0
                          ? t("dashboard.interruptedCount", { count: job.translated_count })
                          : "--"}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-col items-end gap-0.5">
                      <div className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        {(() => {
                          const rel = getRelativeTime(job.created_at)
                          return rel ? t(rel.key as never, rel.count != null ? { count: rel.count } : undefined) : formatDateAbsolute(job.created_at, i18n.language)
                        })()}
                      </div>
                      {job.status === "completed" && job.completed_at && (
                        <span className="text-[10px] text-muted-foreground/60">
                          {t("dashboard.stats.processedIn", { time: formatProcessingTime(job.created_at, job.completed_at) })}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity"
                          aria-label="Job actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {(job.status === "completed" || job.status === "processing" || job.status === "interrupted") && onOpenEditor && (
                          <>
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); onOpenEditor(job.id, job.file_path) }}
                            >
                              <PenLine className="mr-2 h-3.5 w-3.5" />
                              {t("dashboard.actions.openEditor")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        {job.status === "completed" && onRetryJob && (
                          <>
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); onRetryJob(job.id) }}
                            >
                              <Languages className="mr-2 h-3.5 w-3.5" />
                              {t("dashboard.actions.retryTranslation", "Retry translation")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        {job.status === "interrupted" && onResumeJob && (
                          <>
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); onResumeJob(job.id) }}
                            >
                              <Play className="mr-2 h-3.5 w-3.5" />
                              {t("dashboard.actions.resume", "Resume translation")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        {(job.status === "failed" || job.status === "processing") && onRetryJob && (
                          <>
                            <DropdownMenuItem
                              onClick={(e) => { e.stopPropagation(); onRetryJob(job.id) }}
                            >
                              <RotateCcw className="mr-2 h-3.5 w-3.5" />
                              {t("dashboard.actions.retry", "Retry")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                          </>
                        )}
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); onRemoveJob(job.id) }}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          {t("dashboard.actions.remove", "Remove")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TooltipProvider>
      )}

      <NewJobDialog
        open={newJobOpen}
        onOpenChange={(open) => {
          setNewJobOpen(open)
          if (!open) setDroppedFiles(undefined)
        }}
        presets={presets}
        vocabularies={vocabularies}
        onSubmit={onNewJob}
        onUpdateVocabulary={onUpdateVocabulary}
        onAddVocabulary={onAddVocabulary}
        onUpdatePreset={onUpdatePreset}
        initialFiles={droppedFiles}
      />
    </div>
  )
}
