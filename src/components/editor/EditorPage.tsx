import { useState, useCallback, useMemo, useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { Save, Download, FileText, Undo2, Redo2, Search, Video, VideoOff, Loader2, Keyboard } from "lucide-react"
import { toastSuccess, toastError, toastWarning } from "@/lib/toast"
import { convertFileSrc } from "@tauri-apps/api/core"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Waveform } from "./Waveform"
import { SubtitleList } from "./SubtitleList"
import { EditPanel } from "./EditPanel"
import { PlaybackControls } from "./PlaybackControls"
import { FindReplaceBar } from "./FindReplaceBar"
import { WaveformMinimap } from "./WaveformMinimap"
import { VideoPreview } from "./VideoPreview"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { loadJobSubtitles, saveJobSubtitles, exportSubtitles, startTranslate, cancelTranslate } from "@/lib/tauriApi"
import { listen } from "@tauri-apps/api/event"
import { TimeShiftPopover, type TimeShiftScope } from "./TimeShiftPopover"
import { RefusalToolbar, type RefusalBatchProgress } from "./RefusalToolbar"
import { splitLine, mergeLines, reindex, getSplitTime, canSplit, canMerge, shiftLines } from "@/lib/subtitleOps"
import { detectRefusal, type RefusalHit, type RefusalReason } from "@/lib/refusalDetect"
import { useHistory } from "@/hooks/useHistory"
import { isSubtitleFile } from "@/lib/sourceType"
import type { SubtitleLine, Vocabulary } from "@/types"

export interface SearchMatch {
  lineId: string
  field: "original" | "translated"
  startIdx: number
  length: number
}

interface EditorPageProps {
  jobId: string | null
  filePath: string | null
  outputDir: string
  subtitleFormat: string
  /** 잡의 프리셋 — 재번역이 본 번역과 같은 톤/용어집/언어 설정을 쓰게 한다. */
  presetId?: string
  vocabularies?: Vocabulary[]
  onUpdateVocabulary?: (v: Vocabulary) => Promise<Vocabulary[]>
  liveLines?: SubtitleLine[]
}

export function EditorPage({ jobId, filePath, outputDir, subtitleFormat, presetId, vocabularies, onUpdateVocabulary, liveLines: liveLinesFromPipeline }: EditorPageProps) {
  const { t } = useTranslation()
  const { present: lines, push: pushLines, undo, redo, reset: resetLines, canUndo, canRedo } = useHistory<SubtitleLine[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [isPlaying, setIsPlaying] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [playbackRate, setPlaybackRate] = useState(1)

  // Media state (audio or video)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const [mediaReady, setMediaReady] = useState(false)
  const [mediaDuration, setMediaDuration] = useState<number | null>(null)
  const [peaks, setPeaks] = useState<number[]>([])
  const [volume, setVolume] = useState(1)
  const [showVideo, setShowVideo] = useState(true)
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(null)

  // Zoom & Pan state
  const [zoomLevel, setZoomLevel] = useState(1)

  // Live mode
  const liveMode = !!liveLinesFromPipeline
  const displayLines = liveMode ? liveLinesFromPipeline : lines

  // Always-fresh lines for async flows (batch retranslate loop spans renders)
  const linesRef = useRef(lines)
  linesRef.current = lines

  // Refusal detection — derived data, never stored: editing a line recomputes
  // and clears its flag automatically. Per-line memoized on (original, translated).
  const refusalCacheRef = useRef(new Map<string, { original: string; translated: string; hit: RefusalHit | null }>())
  const refusalMap = useMemo(() => {
    const cache = refusalCacheRef.current
    const map = new Map<string, RefusalReason>()
    const seen = new Set<string>()
    for (const line of displayLines) {
      seen.add(line.id)
      // Lines still waiting for translation aren't failures
      if (line.status === "untranslated") continue
      let entry = cache.get(line.id)
      if (!entry || entry.original !== line.original_text || entry.translated !== line.translated_text) {
        entry = {
          original: line.original_text,
          translated: line.translated_text,
          hit: detectRefusal(line.original_text, line.translated_text),
        }
        cache.set(line.id, entry)
      }
      if (entry.hit) map.set(line.id, entry.hit.reason)
    }
    // Drop cache entries for removed lines
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id)
    }
    return map
  }, [displayLines])

  // "Problems only" filter — auto-deactivates when the last flag clears
  const [showProblemsOnly, setShowProblemsOnly] = useState(false)
  const problemFilterActive = showProblemsOnly && refusalMap.size > 0
  const visibleLines = useMemo(
    () => (problemFilterActive ? displayLines.filter((l) => refusalMap.has(l.id)) : displayLines),
    [problemFilterActive, displayLines, refusalMap],
  )

  // Auto-save
  const [autoSaveStatus, setAutoSaveStatus] = useState<"idle" | "saving" | "saved">("idle")
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (liveMode || !dirty || !jobId) return
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    autoSaveTimerRef.current = setTimeout(async () => {
      setAutoSaveStatus("saving")
      try {
        await saveJobSubtitles(jobId, lines)
        setAutoSaveStatus("saved")
        setDirty(false)
        setTimeout(() => setAutoSaveStatus("idle"), 2000)
      } catch (e) {
        console.error("Auto-save failed:", e)
        setAutoSaveStatus("idle")
      }
    }, 30000)
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current)
    }
  }, [dirty, jobId, lines, liveMode])

  // When liveMode ends (pipeline completes), reload from disk
  const prevLiveModeRef = useRef(liveMode)
  useEffect(() => {
    if (prevLiveModeRef.current && !liveMode && jobId) {
      // Transition from live → edit: reload final result from disk
      loadJobSubtitles(jobId)
        .then((data) => {
          resetLines(data)
          setDirty(false)
        })
        .catch((e) => {
          console.error("Failed to reload subtitles after pipeline:", e)
          toastError(t("toast.subtitleLoadFailed"))
        })
    }
    prevLiveModeRef.current = liveMode
  }, [liveMode, jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Find & Replace state
  const [findOpen, setFindOpen] = useState(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [findQuery, setFindQuery] = useState("")
  const [replaceQuery, setReplaceQuery] = useState("")
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [searchOriginal, setSearchOriginal] = useState(false)
  const [matchIndex, setMatchIndex] = useState(0)

  // Load subtitles when jobId changes
  useEffect(() => {
    if (!jobId) {
      resetLines([])
      setSelectedId(null)
      setCurrentTime(0)
      setDirty(false)
      return
    }

    loadJobSubtitles(jobId)
      .then((data) => {
        resetLines(data)
        setSelectedId(null)
        setCurrentTime(0)
        setDirty(false)
      })
      .catch((e) => {
        console.error("Failed to load subtitles:", e)
        toastError(t("toast.subtitleLoadFailed"))
      })
  }, [jobId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Subtitle-import jobs have no media file — the "file" is the .srt/.vtt
  // itself, so waveform/playback/video UI is omitted entirely.
  const isSubtitleSource = useMemo(() => !!filePath && isSubtitleFile(filePath), [filePath])

  // Detect video file by extension
  const isVideo = useMemo(() => {
    if (!filePath) return false
    const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
    return ["mp4", "mkv", "avi", "mov", "webm"].includes(ext)
  }, [filePath])

  // Media lifecycle: create HTMLAudioElement or HTMLVideoElement when filePath changes
  useEffect(() => {
    // Reset media state
    setMediaReady(false)
    setMediaDuration(null)
    setPeaks([])
    setVideoElement(null)

    if (mediaRef.current) {
      mediaRef.current.pause()
      mediaRef.current.src = ""
      mediaRef.current = null
    }

    // Subtitle sources have no media to load (and must not toast a load error)
    if (!filePath || isSubtitleSource) return

    const assetUrl = convertFileSrc(filePath)
    const media = isVideo ? document.createElement("video") : new Audio()
    mediaRef.current = media
    media.volume = volume
    media.playbackRate = playbackRate

    if (isVideo) {
      setVideoElement(media as HTMLVideoElement)
    }

    const onLoadedMetadata = () => {
      setMediaDuration(media.duration)
      setMediaReady(true)
    }
    const onTimeUpdate = () => {
      setCurrentTime(media.currentTime)
    }
    const onEnded = () => {
      setIsPlaying(false)
    }
    const onError = () => {
      console.warn("Media load failed, falling back to timer simulation")
      setMediaReady(false)
      toastWarning(t("toast.mediaLoadFailed"))
    }

    media.addEventListener("loadedmetadata", onLoadedMetadata)
    media.addEventListener("timeupdate", onTimeUpdate)
    media.addEventListener("ended", onEnded)
    media.addEventListener("error", onError)
    media.src = assetUrl

    return () => {
      media.removeEventListener("loadedmetadata", onLoadedMetadata)
      media.removeEventListener("timeupdate", onTimeUpdate)
      media.removeEventListener("ended", onEnded)
      media.removeEventListener("error", onError)
      media.pause()
      media.src = ""
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filePath, isVideo, isSubtitleSource])

  // Peaks extraction after audio is ready
  // Skip for large files (>200MB) to avoid WebView2 OOM crash
  const MAX_PEAK_EXTRACT_BYTES = 200 * 1024 * 1024
  useEffect(() => {
    if (!mediaReady || !filePath) return

    const assetUrl = convertFileSrc(filePath)
    let cancelled = false

    async function extractPeaks() {
      try {
        // Check file size first via HEAD request to avoid loading huge files into memory
        const headResp = await fetch(assetUrl, { method: "HEAD" })
        const contentLength = Number(headResp.headers.get("content-length") ?? "0")
        if (contentLength > MAX_PEAK_EXTRACT_BYTES) {
          console.info(`Skipping peak extraction: file too large (${(contentLength / 1e6).toFixed(0)} MB)`)
          if (!cancelled) setPeaks([])
          return
        }

        const response = await fetch(assetUrl)
        const arrayBuffer = await response.arrayBuffer()
        const audioCtx = new AudioContext()
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)

        if (cancelled) { audioCtx.close(); return }

        // Mono mixdown
        const numChannels = audioBuffer.numberOfChannels
        const length = audioBuffer.length
        const mono = new Float32Array(length)
        for (let ch = 0; ch < numChannels; ch++) {
          const channelData = audioBuffer.getChannelData(ch)
          for (let i = 0; i < length; i++) {
            mono[i] += channelData[i] / numChannels
          }
        }

        // Bucket into 2000 max-amplitude peaks
        const bucketCount = Math.min(2000, length)
        const bucketSize = Math.floor(length / bucketCount)
        const result: number[] = []
        for (let b = 0; b < bucketCount; b++) {
          let max = 0
          const start = b * bucketSize
          const end = Math.min(start + bucketSize, length)
          for (let i = start; i < end; i++) {
            const abs = Math.abs(mono[i])
            if (abs > max) max = abs
          }
          result.push(max)
        }

        if (!cancelled) setPeaks(result)
        audioCtx.close()
      } catch (e) {
        console.warn("Peak extraction failed:", e)
        if (!cancelled) setPeaks([])
      }
    }

    extractPeaks()
    return () => { cancelled = true }
  }, [mediaReady, filePath])

  // Sync volume to audio element
  useEffect(() => {
    if (mediaRef.current) mediaRef.current.volume = volume
  }, [volume])

  // Sync playback rate to audio element
  useEffect(() => {
    if (mediaRef.current) mediaRef.current.playbackRate = playbackRate
  }, [playbackRate])

  // Current subtitle for video overlay
  const currentSubtitle = useMemo(() => {
    const active = displayLines.find((l) => currentTime >= l.start_time && currentTime <= l.end_time)
    if (!active) return null
    return active.translated_text || active.original_text || null
  }, [displayLines, currentTime])

  const subtitleDuration = useMemo(() => {
    if (lines.length === 0) return 0
    return Math.max(...lines.map((l) => l.end_time))
  }, [lines])

  const duration = mediaDuration ?? subtitleDuration

  // Zoom & Pan
  const visibleDuration = useMemo(() => duration / zoomLevel, [duration, zoomLevel])
  const [viewStart, setViewStart] = useState(0)

  const handleZoomIn = useCallback(() => {
    setZoomLevel((z) => Math.min(z * 2, 16))
  }, [])

  const handleZoomOut = useCallback(() => {
    setZoomLevel((z) => {
      const next = Math.max(z / 2, 1)
      if (next === 1) setViewStart(0)
      return next
    })
  }, [])

  const handleViewStartChange = useCallback(
    (vs: number) => {
      setViewStart(Math.max(0, Math.min(vs, Math.max(duration - visibleDuration, 0))))
    },
    [duration, visibleDuration],
  )

  // Auto-follow playhead during playback
  useEffect(() => {
    if (!isPlaying || zoomLevel <= 1) return
    if (currentTime < viewStart || currentTime > viewStart + visibleDuration) {
      setViewStart(Math.max(0, currentTime - visibleDuration * 0.25))
    }
  }, [currentTime, isPlaying, zoomLevel, viewStart, visibleDuration])

  // Reset zoom when job changes
  useEffect(() => {
    setZoomLevel(1)
    setViewStart(0)
  }, [jobId])

  const selectedLine = useMemo(
    () => lines.find((l) => l.id === selectedId) ?? null,
    [lines, selectedId],
  )

  // Timer simulation fallback (only when audio is NOT ready)
  useEffect(() => {
    if (mediaReady) return // real audio handles timeupdate
    if (!isPlaying) return
    const intervalMs = 100
    const interval = setInterval(() => {
      setCurrentTime((t) => {
        if (t >= duration) {
          setIsPlaying(false)
          return 0
        }
        return t + (intervalMs / 1000) * playbackRate
      })
    }, intervalMs)
    return () => clearInterval(interval)
  }, [mediaReady, isPlaying, duration, playbackRate])

  // Auto-select subtitle during playback (Sprint 4)
  useEffect(() => {
    if (!isPlaying) return
    const active = lines.find((l) => currentTime >= l.start_time && currentTime <= l.end_time)
    if (active && active.id !== selectedId) {
      setSelectedId(active.id)
    }
  }, [currentTime, isPlaying, lines, selectedId])

  const handleUpdateLine = useCallback((id: string, updates: Partial<SubtitleLine>) => {
    const updated = lines.map((l) => (l.id === id ? { ...l, ...updates } : l))
    pushLines(updated)
    setDirty(true)
  }, [lines, pushLines])

  const handleUpdateLineTiming = useCallback((id: string, update: { start_time?: number; end_time?: number }) => {
    if (liveMode) return
    const line = lines.find((l) => l.id === id)
    if (!line) return
    const newStart = update.start_time ?? line.start_time
    const newEnd = update.end_time ?? line.end_time
    // Validate: start < end, minimum 0.1s
    if (newEnd - newStart < 0.1) return
    if (newStart < 0) return
    handleUpdateLine(id, { start_time: newStart, end_time: newEnd })
  }, [lines, liveMode, handleUpdateLine])

  const handleSave = useCallback(async () => {
    if (!jobId) return
    try {
      await saveJobSubtitles(jobId, lines)
      setDirty(false)
      toastSuccess(t("toast.subtitleSaved"))
    } catch (e) {
      console.error("Failed to save subtitles:", e)
      toastError(t("toast.subtitleSaveFailed"))
    }
  }, [jobId, lines, t])

  const handleExport = useCallback(async () => {
    if (!jobId || lines.length === 0) return
    try {
      const segments = lines.map((l) => ({
        index: l.index,
        start: l.start_time,
        end: l.end_time,
        text: l.original_text,
        translated: l.translated_text || undefined,
      }))
      await exportSubtitles(segments, subtitleFormat, outputDir, jobId)
      toastSuccess(t("toast.exportSuccess"))
    } catch (e) {
      console.error("Failed to export:", e)
      toastError(t("toast.exportFailed"))
    }
  }, [jobId, lines, subtitleFormat, outputDir, t])

  const handleSplitLine = useCallback((id: string) => {
    const idx = lines.findIndex((l) => l.id === id)
    if (idx < 0) return
    const line = lines[idx]
    if (!canSplit(line)) return
    const time = getSplitTime(line, currentTime)
    const [first, second] = splitLine(line, time)
    const next = [...lines]
    next.splice(idx, 1, first, second)
    pushLines(reindex(next))
    setSelectedId(first.id)
    setDirty(true)
  }, [lines, currentTime, pushLines])

  const handleMergeWithNext = useCallback((id: string) => {
    const idx = lines.findIndex((l) => l.id === id)
    if (idx < 0 || idx >= lines.length - 1) return
    const merged = mergeLines(lines[idx], lines[idx + 1])
    const next = [...lines]
    next.splice(idx, 2, merged)
    pushLines(reindex(next))
    setSelectedId(merged.id)
    setDirty(true)
  }, [lines, pushLines])

  const handleDeleteLine = useCallback((id: string) => {
    const next = reindex(lines.filter((l) => l.id !== id))
    pushLines(next)
    if (selectedId === id) setSelectedId(null)
    setDirty(true)
  }, [lines, pushLines, selectedId])

  const handleTimeShift = useCallback((deltaSeconds: number, scope: TimeShiftScope) => {
    let range: { from: number; to: number } | undefined
    if (scope === "selection") {
      const idx = lines.findIndex((l) => l.id === selectedId)
      if (idx < 0) return // 선택이 사라진 경우 전체 시프트로 떨어지지 않게 중단
      range = { from: idx, to: idx }
    }
    pushLines(shiftLines(lines, deltaSeconds, range))
    setDirty(true)
  }, [lines, selectedId, pushLines])

  const [retranslating, setRetranslating] = useState(false)
  const [batchProgress, setBatchProgress] = useState<RefusalBatchProgress | null>(null)
  const batchCancelRef = useRef(false)
  // The in-flight retranslate job, so a batch cancel can abort it server-side
  const activeRetranslateRef = useRef<{ abort: () => void } | null>(null)

  // Sends one segment and resolves with its translation (null on 30s timeout
  // or abort). Throws if the translate job fails to start. Events are matched
  // by job_id so a late event from a timed-out line can't settle the next one.
  const translateLineAndWait = useCallback(async (line: SubtitleLine): Promise<string | null> => {
    let settle: (value: string | null) => void = () => {}
    const done = new Promise<string | null>((resolve) => { settle = resolve })
    let jobId: string | null = null
    // Abandoning a line must also free the LLM, or its late result could
    // contaminate the next job and the server stays busy.
    const cancelJob = () => {
      if (jobId !== null) cancelTranslate(jobId).catch(console.error)
    }
    const timeout = setTimeout(() => {
      cancelJob()
      settle(null)
    }, 30000)
    // Register the listener before starting the job so the event can't be
    // missed; events that land before our job id is known are buffered.
    const buffered: Array<{ job_id: string; translated: string }> = []
    const unlistenPromise = listen<{ job_id: string; index: number; translated: string }>("translate-segment", (event) => {
      if (jobId === null) {
        buffered.push(event.payload)
      } else if (event.payload.job_id === jobId) {
        settle(event.payload.translated)
      }
    })
    try {
      await unlistenPromise
      const job = await startTranslate([{ index: line.index, start: line.start_time, end: line.end_time, text: line.original_text }], presetId)
      jobId = job.id
      activeRetranslateRef.current = { abort: () => { cancelJob(); settle(null) } }
      for (const seg of buffered) {
        if (seg.job_id === jobId) settle(seg.translated)
      }
      buffered.length = 0
      return await done
    } finally {
      activeRetranslateRef.current = null
      clearTimeout(timeout)
      unlistenPromise.then((fn) => fn()).catch(() => {})
    }
  }, [presetId])

  // Apply a finished translation against the freshest lines; the target may
  // have been deleted while we awaited the LLM.
  const applyTranslation = useCallback((id: string, translated: string) => {
    const current = linesRef.current
    if (!current.some((l) => l.id === id)) return
    pushLines(current.map((l) => (l.id === id ? { ...l, translated_text: translated } : l)))
    setDirty(true)
  }, [pushLines])

  const handleRetranslate = useCallback(async (id: string) => {
    const line = linesRef.current.find((l) => l.id === id)
    if (!line) return
    setRetranslating(true)
    try {
      const translated = await translateLineAndWait(line)
      if (translated !== null) applyTranslation(id, translated)
    } catch (e) {
      toastError(String(e))
    } finally {
      setRetranslating(false)
    }
  }, [translateLineAndWait, applyTranslation])

  // Batch-retranslate all flagged lines, one at a time (server handles a single
  // job at a time; sequential also keeps the cancel point between lines).
  const handleRetranslateFlagged = useCallback(async () => {
    if (liveMode || retranslating || batchProgress) return
    const targets = linesRef.current.filter((l) => refusalMap.has(l.id))
    if (targets.length === 0) return
    batchCancelRef.current = false
    setBatchProgress({ done: 0, total: targets.length })
    setRetranslating(true)
    try {
      for (let i = 0; i < targets.length; i++) {
        if (batchCancelRef.current) break
        const target = targets[i]
        const translated = await translateLineAndWait(target)
        if (translated !== null) applyTranslation(target.id, translated)
        setBatchProgress({ done: i + 1, total: targets.length })
      }
    } catch (e) {
      toastError(String(e))
    } finally {
      setRetranslating(false)
      setBatchProgress(null)
    }
  }, [liveMode, retranslating, batchProgress, refusalMap, translateLineAndWait, applyTranslation])

  const handleCancelBatch = useCallback(() => {
    batchCancelRef.current = true
    // Abort the in-flight line too — otherwise it would run to completion
    // (or 30s timeout) and keep the LLM busy after the user cancelled.
    activeRetranslateRef.current?.abort()
  }, [])

  const handleTogglePlay = useCallback(() => {
    if (isSubtitleSource) return // no media, nothing to play
    if (mediaReady && mediaRef.current) {
      if (isPlaying) {
        mediaRef.current.pause()
      } else {
        mediaRef.current.play()
      }
    }
    setIsPlaying((p) => !p)
  }, [isSubtitleSource, mediaReady, isPlaying])

  // Find & Replace: compute matches
  const searchMatches = useMemo<SearchMatch[]>(() => {
    if (!findQuery) return []
    const matches: SearchMatch[] = []
    const query = caseSensitive ? findQuery : findQuery.toLowerCase()
    for (const line of lines) {
      if (searchOriginal) {
        const text = caseSensitive ? line.original_text : line.original_text.toLowerCase()
        let idx = 0
        while ((idx = text.indexOf(query, idx)) !== -1) {
          matches.push({ lineId: line.id, field: "original", startIdx: idx, length: findQuery.length })
          idx += findQuery.length
        }
      } else {
        const text = caseSensitive ? line.translated_text : line.translated_text.toLowerCase()
        let idx = 0
        while ((idx = text.indexOf(query, idx)) !== -1) {
          matches.push({ lineId: line.id, field: "translated", startIdx: idx, length: findQuery.length })
          idx += findQuery.length
        }
      }
    }
    return matches
  }, [lines, findQuery, caseSensitive, searchOriginal])

  // Reset matchIndex when matches change
  useEffect(() => {
    if (matchIndex >= searchMatches.length) {
      setMatchIndex(0)
    }
  }, [searchMatches.length, matchIndex])

  // Navigate to current match
  useEffect(() => {
    if (searchMatches.length > 0 && matchIndex < searchMatches.length) {
      setSelectedId(searchMatches[matchIndex].lineId)
    }
  }, [matchIndex, searchMatches])

  const handlePrevMatch = useCallback(() => {
    if (searchMatches.length === 0) return
    setMatchIndex((i) => (i - 1 + searchMatches.length) % searchMatches.length)
  }, [searchMatches.length])

  const handleNextMatch = useCallback(() => {
    if (searchMatches.length === 0) return
    setMatchIndex((i) => (i + 1) % searchMatches.length)
  }, [searchMatches.length])

  const handleReplace = useCallback(() => {
    if (searchMatches.length === 0) return
    const match = searchMatches[matchIndex]
    const line = lines.find((l) => l.id === match.lineId)
    if (!line) return
    const field = match.field === "original" ? "original_text" : "translated_text"
    const text = line[field]
    const newText = text.slice(0, match.startIdx) + replaceQuery + text.slice(match.startIdx + match.length)
    handleUpdateLine(match.lineId, { [field]: newText })
  }, [searchMatches, matchIndex, replaceQuery, lines, handleUpdateLine])

  const handleReplaceAll = useCallback(() => {
    if (searchMatches.length === 0 || !findQuery) return
    const updated = lines.map((line) => {
      const field = searchOriginal ? "original_text" : "translated_text"
      const text = line[field]
      if (caseSensitive) {
        const newText = text.split(findQuery).join(replaceQuery)
        return newText !== text ? { ...line, [field]: newText } : line
      } else {
        const regex = new RegExp(findQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
        const newText = text.replace(regex, replaceQuery)
        return newText !== text ? { ...line, [field]: newText } : line
      }
    })
    pushLines(updated)
    setDirty(true)
  }, [searchMatches.length, findQuery, replaceQuery, caseSensitive, searchOriginal, lines, pushLines])

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      const isEditing = tag === "INPUT" || tag === "TEXTAREA"

      // Ctrl+F — Find & Replace
      if (e.ctrlKey && !e.shiftKey && e.key === "f") {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      // Escape — Close Find & Replace
      if (e.key === "Escape" && findOpen) {
        e.preventDefault()
        setFindOpen(false)
        return
      }
      // Ctrl+Z — Undo (always)
      if (e.ctrlKey && !e.shiftKey && e.key === "z") {
        e.preventDefault()
        undo()
        setDirty(true)
        return
      }
      // Ctrl+Y or Ctrl+Shift+Z — Redo (always)
      if ((e.ctrlKey && e.key === "y") || (e.ctrlKey && e.shiftKey && e.key === "Z")) {
        e.preventDefault()
        redo()
        setDirty(true)
        return
      }
      // Ctrl+S — Save (always)
      if (e.ctrlKey && !e.shiftKey && e.key === "s") {
        e.preventDefault()
        handleSave()
        return
      }
      // Space — Play/Pause (not in text fields)
      if (e.key === " " && !isEditing) {
        e.preventDefault()
        handleTogglePlay()
        return
      }
      // Delete — Delete subtitle (not in text fields)
      if (e.key === "Delete" && !isEditing && selectedId) {
        e.preventDefault()
        handleDeleteLine(selectedId)
        return
      }
      // Ctrl+Shift+S — Split
      if (e.ctrlKey && e.shiftKey && e.key === "S" && selectedId) {
        e.preventDefault()
        handleSplitLine(selectedId)
        return
      }
      // Ctrl+Shift+M — Merge
      if (e.ctrlKey && e.shiftKey && e.key === "M" && selectedId) {
        e.preventDefault()
        handleMergeWithNext(selectedId)
      }
    }
    window.addEventListener("keydown", handler)
    return () => window.removeEventListener("keydown", handler)
  }, [selectedId, handleSplitLine, handleMergeWithNext, handleDeleteLine, handleSave, handleTogglePlay, undo, redo, findOpen])

  const canSplitLine = useMemo(() => {
    return selectedLine ? canSplit(selectedLine) : false
  }, [selectedLine])

  const canMergeLine = useMemo(() => {
    return selectedLine ? canMerge(selectedLine, lines) : false
  }, [selectedLine, lines])

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time)
    if (mediaRef.current) {
      mediaRef.current.currentTime = time
    }
  }, [])

  const handleSkipPrev = useCallback(() => {
    const prev = [...lines].reverse().find((l) => l.start_time < currentTime - 0.5)
    if (prev) {
      setCurrentTime(prev.start_time)
      setSelectedId(prev.id)
      if (mediaRef.current) mediaRef.current.currentTime = prev.start_time
    } else {
      setCurrentTime(0)
      if (mediaRef.current) mediaRef.current.currentTime = 0
    }
  }, [lines, currentTime])

  const handleSkipNext = useCallback(() => {
    const next = lines.find((l) => l.start_time > currentTime + 0.1)
    if (next) {
      setCurrentTime(next.start_time)
      setSelectedId(next.id)
      if (mediaRef.current) mediaRef.current.currentTime = next.start_time
    }
  }, [lines, currentTime])

  // Empty state
  if (!jobId) {
    return (
      <div className="flex flex-1 items-center justify-center text-center">
        <div className="flex flex-col items-center gap-3">
          <div className="rounded-2xl bg-muted/60 p-4 ring-1 ring-border">
            <FileText className="h-8 w-8 text-muted-foreground/70" />
          </div>
          <div>
            <p className="font-medium">{t("editor.empty.title")}</p>
            <p className="text-sm text-muted-foreground mt-1">{t("editor.empty.description")}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-1 pb-3 border-b">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {displayLines.length} {t("editor.subtitlesCount")}
          </span>
          {liveMode && (
            <span className="inline-flex items-center gap-1.5 text-xs text-orange-500 font-medium">
              <Loader2 className="h-3 w-3 animate-spin" />
              {t("editor.processing")}
            </span>
          )}
          {!liveMode && dirty && (
            <span className="text-xs text-yellow-500">{t("editor.unsaved")}</span>
          )}
          {!liveMode && autoSaveStatus === "saving" && (
            <span className="text-xs text-muted-foreground">{t("editor.autoSaving")}</span>
          )}
          {!liveMode && autoSaveStatus === "saved" && (
            <span className="text-xs text-green-500">{t("editor.autoSaved")}</span>
          )}
          <RefusalToolbar
            count={refusalMap.size}
            filterActive={problemFilterActive}
            onFilterChange={setShowProblemsOnly}
            onRetranslateAll={handleRetranslateFlagged}
            retranslateDisabled={liveMode || retranslating}
            progress={batchProgress}
            onCancel={handleCancelBatch}
          />
        </div>
        <TooltipProvider>
          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={undo} disabled={liveMode || !canUndo}>
                  <Undo2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("editor.undo")} <kbd className="ml-1 text-[10px] opacity-60">Ctrl+Z</kbd></p></TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={redo} disabled={liveMode || !canRedo}>
                  <Redo2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("editor.redo")} <kbd className="ml-1 text-[10px] opacity-60">Ctrl+Y</kbd></p></TooltipContent>
            </Tooltip>
            <div className="w-px h-4 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={handleSave} disabled={liveMode || !dirty}>
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {t("editor.save")}
                </Button>
              </TooltipTrigger>
              <TooltipContent><p><kbd className="text-[10px] opacity-60">Ctrl+S</kbd></p></TooltipContent>
            </Tooltip>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={liveMode || displayLines.length === 0}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("editor.export.label")}
            </Button>
            <div className="w-px h-4 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={findOpen ? "secondary" : "ghost"}
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setFindOpen((o) => !o)}
                >
                  <Search className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("editor.findReplace.title")} <kbd className="ml-1 text-[10px] opacity-60">Ctrl+F</kbd></p></TooltipContent>
            </Tooltip>
            <TimeShiftPopover
              disabled={liveMode || lines.length === 0}
              hasSelection={!!selectedLine}
              onApply={handleTimeShift}
            />
            {isVideo && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={showVideo ? "secondary" : "ghost"}
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setShowVideo((v) => !v)}
                  >
                    {showVideo ? <Video className="h-3.5 w-3.5" /> : <VideoOff className="h-3.5 w-3.5" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent><p>{showVideo ? t("editor.video.hide") : t("editor.video.show")}</p></TooltipContent>
              </Tooltip>
            )}
            <div className="w-px h-4 bg-border mx-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={() => setShortcutsOpen(true)}
                >
                  <Keyboard className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent><p>{t("shortcuts.title")}</p></TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />

      {/* Find & Replace bar */}
      {findOpen && (
        <FindReplaceBar
          findQuery={findQuery}
          replaceQuery={replaceQuery}
          caseSensitive={caseSensitive}
          searchOriginal={searchOriginal}
          matchCount={searchMatches.length}
          matchIndex={matchIndex}
          onFindQueryChange={setFindQuery}
          onReplaceQueryChange={setReplaceQuery}
          onCaseSensitiveChange={setCaseSensitive}
          onSearchOriginalChange={setSearchOriginal}
          onPrevMatch={handlePrevMatch}
          onNextMatch={handleNextMatch}
          onReplace={handleReplace}
          onReplaceAll={handleReplaceAll}
          onClose={() => setFindOpen(false)}
        />
      )}

      {/* Main content: waveform + panels */}
      <div className="flex flex-1 flex-col min-h-0">
        {/* Video preview (visible when video file + toggled on) */}
        {isVideo && showVideo && videoElement && (
          <VideoPreview videoElement={videoElement} currentSubtitle={currentSubtitle} />
        )}

        {/* Waveform / playback UI — omitted for subtitle imports (no media file) */}
        {!isSubtitleSource && (
          <>
            {/* Minimap (visible only when zoomed) */}
            {zoomLevel > 1 && (
              <WaveformMinimap
                peaks={peaks}
                duration={duration}
                viewStart={viewStart}
                visibleDuration={visibleDuration}
                onViewStartChange={handleViewStartChange}
              />
            )}

            {/* Waveform */}
            <div className="h-[80px] border-b shrink-0">
              <Waveform
                lines={displayLines}
                currentTime={currentTime}
                selectedId={selectedId}
                duration={duration}
                peaks={peaks}
                viewStart={viewStart}
                visibleDuration={visibleDuration}
                onSeek={handleSeek}
                onSelect={setSelectedId}
                onViewStartChange={handleViewStartChange}
                onZoomIn={handleZoomIn}
                onZoomOut={handleZoomOut}
                onUpdateLineTiming={liveMode ? undefined : handleUpdateLineTiming}
              />
            </div>

            {/* Playback controls */}
            <PlaybackControls
              currentTime={currentTime}
              duration={duration}
              isPlaying={isPlaying}
              volume={volume}
              playbackRate={playbackRate}
              onTogglePlay={handleTogglePlay}
              onSeek={handleSeek}
              onSkipPrev={handleSkipPrev}
              onSkipNext={handleSkipNext}
              onVolumeChange={setVolume}
              onPlaybackRateChange={setPlaybackRate}
            />
          </>
        )}

        {/* Subtitle list + Edit panel */}
        <ResizablePanelGroup className="flex-1 min-h-0">
          <ResizablePanel defaultSize={55} minSize={30}>
            <SubtitleList
              lines={visibleLines}
              selectedId={selectedId}
              currentTime={currentTime}
              onSelect={setSelectedId}
              onSeek={handleSeek}
              onSplit={handleSplitLine}
              onMergeWithNext={handleMergeWithNext}
              onDelete={liveMode ? undefined : handleDeleteLine}
              highlightMatches={findOpen ? searchMatches : undefined}
              currentMatchIndex={findOpen ? matchIndex : undefined}
              vocabularies={vocabularies}
              onUpdateVocabulary={onUpdateVocabulary}
              readOnly={liveMode}
              refusals={refusalMap}
            />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel defaultSize={45} minSize={25}>
            <EditPanel
              line={selectedLine}
              onUpdateLine={handleUpdateLine}
              onSplit={handleSplitLine}
              onMergeWithNext={handleMergeWithNext}
              onDelete={handleDeleteLine}
              onRetranslate={handleRetranslate}
              canSplitLine={canSplitLine}
              canMergeLine={canMergeLine}
              retranslating={retranslating}
              vocabularies={vocabularies}
              onUpdateVocabulary={onUpdateVocabulary}
            />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  )
}
