import { useRef, useEffect, useCallback } from "react"

interface WaveformMinimapProps {
  peaks: number[]
  duration: number
  viewStart: number
  visibleDuration: number
  onViewStartChange: (viewStart: number) => void
}

export function WaveformMinimap({
  peaks,
  duration,
  viewStart,
  visibleDuration,
  onViewStartChange,
}: WaveformMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const draggingRef = useRef(false)

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
    const dur = Math.max(duration, 1)

    const s = getComputedStyle(document.documentElement)
    const v = (name: string) => s.getPropertyValue(name).trim()

    // Background
    ctx.fillStyle = `hsl(${v("--waveform-bg")})`
    ctx.fillRect(0, 0, w, h)

    // Peaks
    if (peaks.length > 0) {
      const centerY = h / 2
      const maxBarH = h * 0.4
      const barW = Math.max(w / peaks.length, 1)
      ctx.fillStyle = `hsl(${v("--waveform")} / 0.3)`
      for (let i = 0; i < peaks.length; i++) {
        const x = (i / peaks.length) * w
        const barH = peaks[i] * maxBarH
        if (barH < 0.5) continue
        ctx.fillRect(x, centerY - barH, barW, barH * 2)
      }
    }

    // Visible area highlight
    const x1 = (viewStart / dur) * w
    const x2 = ((viewStart + visibleDuration) / dur) * w
    ctx.fillStyle = `hsl(${v("--primary")} / 0.15)`
    ctx.fillRect(x1, 0, x2 - x1, h)
    ctx.strokeStyle = `hsl(${v("--primary")} / 0.5)`
    ctx.lineWidth = 1
    ctx.strokeRect(x1, 0, x2 - x1, h)
  }, [peaks, duration, viewStart, visibleDuration])

  useEffect(() => {
    draw()
  }, [draw])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver(() => draw())
    observer.observe(container)
    return () => observer.disconnect()
  }, [draw])

  const handlePointer = useCallback(
    (clientX: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const ratio = x / rect.width
      const dur = Math.max(duration, 1)
      const newStart = Math.max(0, Math.min(ratio * dur - visibleDuration / 2, dur - visibleDuration))
      onViewStartChange(newStart)
    },
    [duration, visibleDuration, onViewStartChange],
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      draggingRef.current = true
      handlePointer(e.clientX)
    },
    [handlePointer],
  )

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (draggingRef.current) handlePointer(e.clientX)
    }
    const handleMouseUp = () => {
      draggingRef.current = false
    }
    window.addEventListener("mousemove", handleMouseMove)
    window.addEventListener("mouseup", handleMouseUp)
    return () => {
      window.removeEventListener("mousemove", handleMouseMove)
      window.removeEventListener("mouseup", handleMouseUp)
    }
  }, [handlePointer])

  return (
    <div ref={containerRef} className="relative w-full h-[30px] border-b cursor-pointer">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        onMouseDown={handleMouseDown}
      />
    </div>
  )
}
