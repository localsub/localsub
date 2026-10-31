import { useState, useMemo, useCallback, useEffect } from "react"
import { Plus, Trash2, FileVideo, FileText, MoreHorizontal, RotateCcw, Languages, Search, PenLine, Play } from "lucide-react"
import { useTranslation } from "react-i18next"
import { toastInfo, toastError } from "@/lib/toast"
import { formatEta } from "@/lib/eta"
import { cn } from "@/lib/utils"
import { PageActions } from "@/components/page-header"
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

  const FILTER_OPTIONS: { value: FilterStatus; label: string; count: number }[] = [
    { value: "all", label: t("dashboard.filter.all", "All"), count: counts.all },
    { value: "processing", label: t("dashboard.filter.processing", "Processing"), count: counts.processing },
    { value: "pending", label: t("dashboard.filter.pending", "Pending"), count: counts.pending },
    { value: "completed", label: t("dashboard.filter.completed", "Completed"), count: counts.completed },
    { value: "failed", label: t("dashboard.filter.failed", "Failed"), count: counts.failed },
    // Rare state — only worth a filter slot while it exists
    ...(counts.interrupted > 0 || filter === "interrupted"
      ? [{ value: "interrupted" as const, label: t("dashboard.filter.interrupted", "Interrupted"), count: counts.interrupted }]
      : []),
  ]

  return (
    <div
      className="relative flex flex-col flex-1 gap-5"
      onDragOver={handlePageDragOver}
      onDragLeave={handlePageDragLeave}
      onDrop={handlePageDrop}
    >
      <PageActions>
        <Button className="h-[46px]" onClick={() => setNewJobOpen(true)}>
          <Plus />
          {t("dashboard.newJob.button", "New Job")}
        </Button>
      </PageActions>

      {/* Drag overlay */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 rounded-3xl bg-primary-soft shadow-[inset_0_0_0_3px_hsl(var(--primary))] backdrop-blur-sm">
          <div className="flex h-[88px] w-[88px] items-center justify-center rounded-3xl bg-primary text-primary-foreground shadow-[0_16px_40px_hsl(var(--primary)/0.35)]">
            <FileVideo className="h-10 w-10" />
          </div>
          <p className="mt-2 text-2xl font-extrabold text-primary-text">{t("dashboard.dropOverlay")}</p>
          <p className="text-sm text-foreground-secondary">{t("dashboard.newJob.supportedFormats")}</p>
        </div>
      )}

      {/* Filter bar */}
      {jobs.length > 0 && (
        <div className="flex items-center gap-3">
          <div className="flex shrink-0 gap-0.5 rounded-lg bg-muted p-1">
            {FILTER_OPTIONS.map((opt) => {
              const active = filter === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "flex h-9 items-center gap-1.5 whitespace-nowrap rounded-sm px-3.5 text-sm transition-[background-color,color,box-shadow] duration-150 ease-out",
                    active
                      ? "bg-card font-bold text-foreground shadow-segment"
                      : "font-semibold text-foreground-secondary hover:text-foreground",
                  )}
                >
                  {opt.label}
                  <span className={active ? "text-primary-text" : "text-muted-foreground"}>{opt.count}</span>
                </button>
              )
            })}
          </div>
          <div className="flex-1" />
          <div className="relative min-w-[140px] max-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("dashboard.search")}
              className="h-11 w-full bg-card pl-10 text-sm shadow-card"
            />
          </div>
          <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
            <SelectTrigger className="h-11 w-auto shrink-0 gap-2 whitespace-nowrap bg-card px-3.5 text-sm font-semibold text-foreground-secondary shadow-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="newest">{t("dashboard.sort.newest")}</SelectItem>
              <SelectItem value="oldest">{t("dashboard.sort.oldest")}</SelectItem>
              <SelectItem value="nameAsc">{t("dashboard.sort.nameAsc")}</SelectItem>
              <SelectItem value="nameDesc">{t("dashboard.sort.nameDesc")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Job table */}
      {filteredJobs.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl bg-card p-8 text-center shadow-card">
          <div className="mb-3 flex h-[72px] w-[72px] items-center justify-center rounded-[22px] bg-primary-soft text-primary-text">
            <FileVideo className="h-8 w-8" />
          </div>
          <p className="text-[22px] font-extrabold">{t("dashboard.empty.title", "No jobs yet")}</p>
          <p className="text-[15px] text-muted-foreground">
            {t("dashboard.empty.description", "Create a new job to start processing subtitles.")}
          </p>
          <Button size="lg" onClick={() => setNewJobOpen(true)} className="mt-5">
            <Plus />
            {t("dashboard.newJob.button", "New Job")}
          </Button>
        </div>
      ) : (
        <TooltipProvider>
          <div className="rounded-xl bg-card px-3 py-2 shadow-card">
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[30%]">{t("dashboard.table.file", "File")}</TableHead>
                <TableHead className="w-[16%]">{t("dashboard.table.preset", "Preset")}</TableHead>
                <TableHead className="w-[16%]">{t("dashboard.table.status", "Status")}</TableHead>
                <TableHead className="w-[20%]">{t("dashboard.table.progress", "Progress")}</TableHead>
                <TableHead className="text-right">{t("dashboard.table.created", "Created")}</TableHead>
                <TableHead className="w-[56px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredJobs.map((job) => (
                <TableRow
                  key={job.id}
                  className="group cursor-pointer has-[[data-state=open]]:[&>td]:bg-muted"
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
                    <div className="flex items-center gap-3.5">
                      <div className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-md bg-muted text-foreground-secondary transition-colors group-hover:bg-card">
                        {job.source_type === "subtitle" ? (
                          <FileText className="h-[18px] w-[18px]" />
                        ) : (
                          <FileVideo className="h-[18px] w-[18px]" />
                        )}
                      </div>
                      <div className="flex min-w-0 flex-col gap-1">
                        <p className="truncate text-[15px] font-bold" title={job.file_name}>{job.file_name}</p>
                        {job.duration > 0 && (
                          <p className="text-[13px] text-muted-foreground">
                            {formatDuration(job.duration)}
                          </p>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="block truncate text-sm text-foreground-secondary" title={getPresetName(job.preset_id)}>
                      {getPresetName(job.preset_id)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <JobStatusBadge status={job.status} stage={job.stage} />
                  </TableCell>
                  <TableCell>
                    {job.status === "processing" ? (
                      <div className="flex max-w-[230px] flex-col gap-2">
                        {(() => {
                          // One bar for the stage that is running now.
                          const eta = job.stage === "translating" && job.etaMs != null ? formatEta(job.etaMs) : null
                          return (
                            <>
                              <div className="flex items-baseline justify-between gap-2 text-[13px] font-semibold text-foreground-secondary">
                                <span className="truncate">
                                  {t(`dashboard.stage.${job.stage}` as never)}{" "}
                                  <span className="font-bold tabular-nums text-primary-text">{job.progress}%</span>
                                </span>
                                {eta && (
                                  <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
                                    {t(eta.key as never, { count: eta.count, minutes: eta.minutes })}
                                  </span>
                                )}
                              </div>
                              <Progress value={job.progress} className="h-1.5" />
                              {/* Subtitle imports have no STT stage to report */}
                              {job.stage === "translating" && job.source_type !== "subtitle" && (
                                <span className="text-xs text-muted-foreground">
                                  {t("dashboard.stage.stt")} {t("dashboard.stage.done")}
                                </span>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    ) : job.status === "completed" ? (
                      <span className="text-sm text-foreground-secondary">100%</span>
                    ) : job.status === "failed" ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="cursor-help text-sm font-semibold text-status-error underline decoration-dotted underline-offset-[3px]">
                            Error
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs">
                          <p>{job.error}</p>
                        </TooltipContent>
                      </Tooltip>
                    ) : job.status === "interrupted" ? (
                      <span className="text-sm tabular-nums text-foreground-secondary">
                        {job.translated_count != null && job.translated_count > 0
                          ? t("dashboard.interruptedCount", { count: job.translated_count })
                          : "--"}
                      </span>
                    ) : (
                      <span className="text-sm text-muted-foreground">--</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex flex-col items-end gap-1">
                      <span className="text-sm text-foreground-secondary">
                        {(() => {
                          const rel = getRelativeTime(job.created_at)
                          return rel ? t(rel.key as never, rel.count != null ? { count: rel.count } : undefined) : formatDateAbsolute(job.created_at, i18n.language)
                        })()}
                      </span>
                      {job.status === "completed" && job.completed_at && (
                        <span className="whitespace-nowrap text-xs text-muted-foreground">
                          {t("dashboard.stats.processedIn", { time: formatProcessingTime(job.created_at, job.completed_at) })}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="pl-0 text-right">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-[34px] w-[34px] rounded-sm opacity-0 transition-opacity hover:bg-card group-hover:opacity-100 data-[state=open]:bg-card data-[state=open]:text-foreground data-[state=open]:opacity-100"
                          aria-label="Job actions"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreHorizontal />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-[220px]">
                        {(job.status === "completed" || job.status === "processing" || job.status === "interrupted") && onOpenEditor && (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); onOpenEditor(job.id, job.file_path) }}
                          >
                            <PenLine />
                            {t("dashboard.actions.openEditor")}
                          </DropdownMenuItem>
                        )}
                        {job.status === "completed" && onRetryJob && (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); onRetryJob(job.id) }}
                          >
                            <Languages />
                            {t("dashboard.actions.retryTranslation", "Retry translation")}
                          </DropdownMenuItem>
                        )}
                        {job.status === "interrupted" && onResumeJob && (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); onResumeJob(job.id) }}
                          >
                            <Play />
                            {t("dashboard.actions.resume", "Resume translation")}
                          </DropdownMenuItem>
                        )}
                        {job.status === "failed" && onRetryJob && (
                          <DropdownMenuItem
                            onClick={(e) => { e.stopPropagation(); onRetryJob(job.id) }}
                          >
                            <RotateCcw />
                            {t("dashboard.actions.retry", "Retry")}
                          </DropdownMenuItem>
                        )}
                        {job.status !== "pending" && <DropdownMenuSeparator />}
                        <DropdownMenuItem
                          onClick={(e) => { e.stopPropagation(); onRemoveJob(job.id) }}
                          className="text-status-error focus:text-status-error"
                        >
                          <Trash2 />
                          {t("dashboard.actions.remove", "Remove")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          </div>
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
