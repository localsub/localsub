import { useRef, useEffect, useCallback } from "react"
import type { SubtitleLine } from "@/types"

interface WaveformProps {
  lines: SubtitleLine[]
  currentTime: number
  selectedId: string | null
  duration: number
  peaks?: number[]
  viewStart: number
  visibleDuration: number
  onSeek: (time: number) => void
  onSelect: (id: string) => void
  onViewStartChange: (viewStart: number) => void
  onZoomIn: () => void
  onZoomOut: () => void
  onUpdateLineTiming?: (id: string, update: { start_time?: number; end_time?: number }) => void
}

interface ResizeState {
  lineId: string
  edge: "left" | "right"
  startX: number
  origStart: number
  origEnd: number
}

export function Waveform({
  lines,
  currentTime,
  selectedId,
  duration,
  peaks,
  viewStart,
  visibleDuration,
  onSeek,
  onSelect,
  onViewStartChange,
  onZoomIn,
  onZoomOut,
  onUpdateLineTiming,
}: WaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startX: number; startViewStart: number; moved: boolean } | null>(null)
  const resizeRef = useRef<ResizeState | null>(null)

  const timeToX = useCallback(
    (t: number, w: number) => ((t - viewStart) / visibleDuration) * w,
    [viewStart, visibleDuration],
  )

  const xToTime = useCallback(
    (x: number, w: number) => viewStart + (x / w) * visibleDuration,
    [viewStart, visibleDuration],
  )

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext("2d")
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const rect = canvas.getBoundingClientRect()
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    ctx.scale(dpr, dpr)

    const w = rect.width
    const h = rect.height

    // Read theme colors from CSS variables
    const s = getComputedStyle(document.documentElement)
    const v = (name: string) => s.getPropertyValue(name).trim()
    const isDark = document.documentElement.classList.contains("dark")

    // Background
    ctx.fillStyle = `hsl(${v("--waveform-bg")})`
    ctx.fillRect(0, 0, w, h)

    // Grid lines — dynamic interval based on visible duration
    const gridInterval =
      visibleDuration > 300
        ? 60
        : visibleDuration > 120
          ? 30
          : visibleDuration > 60
            ? 10
            : visibleDuration > 20
              ? 5
              : visibleDuration > 5
                ? 1
                : 0.5

    ctx.strokeStyle = `hsl(${v("--waveform-grid")} / 0.5)`
    ctx.lineWidth = 0.5

    const gridStart = Math.floor(viewStart / gridInterval) * gridInterval
    for (let t = gridStart; t <= viewStart + visibleDuration; t += gridInterval) {
      const x = timeToX(t, w)
      if (x < -1 || x > w + 1) continue
      ctx.beginPath()
      ctx.moveTo(x, 0)
      ctx.lineTo(x, h)
      ctx.stroke()

      // Time label
      ctx.fillStyle = `hsl(${v("--waveform-label")})`
      ctx.font = "10px Inter, sans-serif"
      const min = Math.floor(t / 60)
      const sec = Math.floor(t % 60)
      const label =
        gridInterval < 1
          ? `${min}:${String(sec).padStart(2, "0")}.${Math.round((t % 1) * 10)}`
          : `${min}:${String(sec).padStart(2, "0")}`
      ctx.fillText(label, x + 2, h - 4)
    }

    // Waveform peaks — only visible range
    if (peaks && peaks.length > 0) {
      const centerY = h / 2
      const maxBarH = h * 0.4
      const dur = Math.max(duration, 1)
      const peakStartIdx = Math.max(0, Math.floor((viewStart / dur) * peaks.length) - 1)
      const peakEndIdx = Math.min(peaks.length, Math.ceil(((viewStart + visibleDuration) / dur) * peaks.length) + 1)
      const barW = Math.max((w / ((peakEndIdx - peakStartIdx) || 1)), 1)

      ctx.fillStyle = `hsl(${v("--waveform")} / ${isDark ? 0.35 : 0.25})`
      for (let i = peakStartIdx; i < peakEndIdx; i++) {
        const peakTime = (i / peaks.length) * dur
        const x = timeToX(peakTime, w)
        if (x < -barW || x > w + barW) continue
        const barH = peaks[i] * maxBarH
        if (barH < 0.5) continue
        ctx.fillRect(x, centerY - barH, barW, barH * 2)
      }
    }

    // Subtitle blocks — only visible range
    const trackH = 24
    const trackY = (h - trackH) / 2 - 6

    for (const line of lines) {
      // Skip if completely outside visible range
      if (line.end_time < viewStart || line.start_time > viewStart + visibleDuration) continue

      const x1 = timeToX(line.start_time, w)
      const x2 = timeToX(line.end_time, w)
      const bw = Math.max(x2 - x1, 2)

      const isSelected = line.id === selectedId
      const hasTranslation = line.translated_text.length > 0

      if (isSelected) {
        ctx.fillStyle = `hsl(${v("--subtitle-highlight")} / ${isDark ? 0.6 : 0.4})`
      } else if (hasTranslation) {
        ctx.fillStyle = `hsl(${v("--waveform-block-active")} / ${isDark ? 0.35 : 0.25})`
      } else {
        ctx.fillStyle = `hsl(${v("--waveform-block")} / ${isDark ? 0.3 : 0.25})`
      }

      ctx.beginPath()
      ctx.roundRect(x1, trackY, bw, trackH, 3)
      ctx.fill()

      // Border for selected
      if (isSelected) {
        ctx.strokeStyle = `hsl(${v("--waveform-block-border")})`
        ctx.lineWidth = 1.5
        ctx.stroke()
      }

      // Text label (if wide enough)
      if (bw > 30) {
        ctx.fillStyle = `hsl(${v("--waveform-text")})`
        ctx.font = "10px Inter, sans-serif"
        ctx.save()
        ctx.beginPath()
        ctx.rect(x1 + 3, trackY, bw - 6, trackH)
        ctx.clip()
        ctx.fillText(line.original_text, x1 + 4, trackY + 15)
        ctx.restore()
      }
    }

    // Playhead
    const phX = timeToX(currentTime, w)
    if (phX >= -2 && phX <= w + 2) {
      ctx.strokeStyle = `hsl(${v("--playhead")})`
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(phX, 0)
      ctx.lineTo(phX, h)
      ctx.stroke()

      // Playhead triangle
      ctx.fillStyle = `hsl(${v("--playhead")})`
      ctx.beginPath()
      ctx.moveTo(phX - 5, 0)
      ctx.lineTo(phX + 5, 0)
      ctx.lineTo(phX, 6)
      ctx.closePath()
      ctx.fill()
    }
  }, [lines, currentTime, selectedId, duration, peaks, viewStart, visibleDuration, timeToX])

  useEffect(() => {
    draw()
  }, [draw])

  // Resize observer
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw])

  // Wheel zoom
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const mouseX = e.clientX - rect.left
      const mouseTime = viewStart + (mouseX / rect.width) * visibleDuration

      if (e.deltaY < 0) {
        onZoomIn()
        // After zoom in, center on mouse position
        const newVisibleDuration = visibleDuration / 2
        const newStart = Math.max(0, Math.min(mouseTime - (mouseX / rect.width) * newVisibleDuration, Math.max(duration, 1) - newVisibleDuration))
        onViewStartChange(newStart)
      } else {
        onZoomOut()
        // After zoom out, center on mouse position
        const newVisibleDuration = Math.min(visibleDuration * 2, Math.max(duration, 1))
        const newStart = Math.max(0, Math.min(mouseTime - (mouseX / rect.width) * newVisibleDuration, Math.max(duration, 1) - newVisibleDuration))
        onViewStartChange(newStart)
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", handleWheel)
  }, [viewStart, visibleDuration, duration, onZoomIn, onZoomOut, onViewStartChange])

  // Edge hit test: detect if mouse is near left/right edge of a subtitle block
  const EDGE_PX = 6
  const trackH = 24

  const hitTestEdge = useCallback(
    (clientX: number, clientY: number): { lineId: string; edge: "left" | "right" } | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      const h = rect.height
      const trackY = (h - trackH) / 2 - 6

      // Only detect edges within the track Y range
      if (y < trackY || y > trackY + trackH) return null

      for (const line of lines) {
        if (line.end_time < viewStart || line.start_time > viewStart + visibleDuration) continue
        const x1 = timeToX(line.start_time, rect.width)
        const x2 = timeToX(line.end_time, rect.width)

        if (Math.abs(x - x1) <= EDGE_PX) return { lineId: line.id, edge: "left" }
        if (Math.abs(x - x2) <= EDGE_PX) return { lineId: line.id, edge: "right" }
      }
      return null
    },
    [lines, viewStart, visibleDuration, timeToX],
  )

  // Hover cursor change for edge detection
  const handleMouseMoveHover = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (dragRef.current || resizeRef.current) return
      const canvas = canvasRef.current
      if (!canvas) return
      const hit = hitTestEdge(e.clientX, e.clientY)
      canvas.style.cursor = hit && onUpdateLineTiming ? "col-resize" : "crosshair"
    },
    [hitTestEdge, onUpdateLineTiming],
  )

  // Drag pan / Resize
  function handleMouseDown(e: React.MouseEvent<HTMLCanvasElement>) {
    // Check for edge resize first
    if (onUpdateLineTiming) {
      const hit = hitTestEdge(e.clientX, e.clientY)
      if (hit) {
        const line = lines.find((l) => l.id === hit.lineId)
        if (line) {
          resizeRef.current = {
            lineId: hit.lineId,
            edge: hit.edge,
            startX: e.clientX,
            origStart: line.start_time,
            origEnd: line.end_time,
          }
          return
        }
      }
    }
    dragRef.current = { startX: e.clientX, startViewStart: viewStart, moved: false }
  }

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      // Handle resize — just consume the event; actual update happens on mouseUp
      if (resizeRef.current) return

      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      if (Math.abs(dx) > 3) dragRef.current.moved = true
      if (!dragRef.current.moved) return

      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const timeDelta = -(dx / rect.width) * visibleDuration
      const newStart = Math.max(0, Math.min(dragRef.current.startViewStart + timeDelta, Math.max(duration, 1) - visibleDuration))
      onViewStartChange(newStart)
    }

    const handleMouseUp = (e: MouseEvent) => {
      // Handle resize end
      if (resizeRef.current && onUpdateLineTiming) {
        const canvas = canvasRef.current
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          const dx = e.clientX - resizeRef.current.startX
          const timeDelta = (dx / rect.width) * visibleDuration
          const MIN_DURATION = 0.1

          if (resizeRef.current.edge === "left") {
            const newStart = Math.max(0, resizeRef.current.origStart + timeDelta)
            if (resizeRef.current.origEnd - newStart >= MIN_DURATION) {
              onUpdateLineTiming(resizeRef.current.lineId, { start_time: newStart })
            }
          } else {
            const newEnd = Math.max(0, resizeRef.current.origEnd + timeDelta)
            if (newEnd - resizeRef.current.origStart >= MIN_DURATION) {
              onUpdateLineTiming(resizeRef.current.lineId, { end_time: newEnd })
            }
          }
        }
        resizeRef.current = null
        return
      }

      if (!dragRef.current) return
      const wasDrag = dragRef.current.moved
      dragRef.current = null

      // If not a drag, treat as click (seek / select)
      if (!wasDrag) {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const x = e.clientX - rect.left
        const t = xToTime(x, rect.width)

        // Check if clicked on a subtitle block
        const clicked = lines.find((l) => t >= l.start_time && t <= l.end_time)
        if (clicked) {
          onSelect(clicked.id)
        }
        onSeek(Math.max(0, Math.min(t, duration)))
      }
    }

    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [visibleDuration, duration, onViewStartChange, lines, onSelect, onSeek, xToTime, onUpdateLineTiming])

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[80px]">
      <canvas
        ref={canvasRef}
        className="w-full h-full cursor-crosshair"
        role="img"
        aria-label="Waveform timeline"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMoveHover}
      />
    </div>
  )
}
