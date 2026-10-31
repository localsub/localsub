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

    videoElement.className = "h-full w-full object-contain"
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
      className="relative h-[160px] shrink-0 overflow-hidden rounded-md bg-black"
    >
      {currentSubtitle && (
        <div className="pointer-events-none absolute bottom-3.5 left-1/2 max-w-[90%] -translate-x-1/2 text-center text-[17px] font-bold leading-snug text-white [text-shadow:0_0_3px_#000,0_1px_3px_#000]">
          {currentSubtitle}
        </div>
      )}
    </div>
  )
}
