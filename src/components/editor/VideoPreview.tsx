import { useEffect, useRef } from "react"

interface VideoPreviewProps {
  videoElement: HTMLVideoElement | null
  currentSubtitle?: string | null
}

export function VideoPreview({ videoElement, currentSubtitle }: VideoPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container || !videoElement) return

    videoElement.className = "w-full h-full object-contain bg-black rounded-md"
    container.appendChild(videoElement)

    return () => {
      if (container.contains(videoElement)) {
        container.removeChild(videoElement)
      }
    }
  }, [videoElement])

  return (
    <div
      ref={containerRef}
      className="relative h-[160px] shrink-0 border-b bg-black/5 dark:bg-black/20"
    >
      {currentSubtitle && (
        <div className="absolute bottom-3 left-1/2 -translate-x-1/2 max-w-[90%] px-3 py-1.5 rounded bg-black/75 text-white text-sm text-center leading-snug pointer-events-none">
          {currentSubtitle}
        </div>
      )}
    </div>
  )
}
