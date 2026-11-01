import { useCallback, useEffect, useState } from "react"

interface ScrollEdges {
  /** Content is taller than the container. */
  overflowing: boolean
  atTop: boolean
  atBottom: boolean
}

/**
 * Tracks whether a scroll container is overflowing and which ends are visible,
 * so dialogs can show a header divider once scrolled and a bottom fade while
 * more content remains. Returns a callback ref — dialog bodies mount inside a
 * portal after the owner renders, so a plain ref would be read too early.
 */
export function useScrollEdges<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ overflowing: false, atTop: true, atBottom: true })

  useEffect(() => {
    if (!el) return
    const update = () => {
      const overflowing = el.scrollHeight - el.clientHeight > 1
      const next = {
        overflowing,
        atTop: el.scrollTop <= 1,
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
      }
      setEdges((prev) =>
        prev.overflowing === next.overflowing && prev.atTop === next.atTop && prev.atBottom === next.atBottom ? prev : next,
      )
    }
    update()
    el.addEventListener("scroll", update, { passive: true })
    if (typeof ResizeObserver === "undefined") {
      return () => el.removeEventListener("scroll", update)
    }
    // The content grows (preview rows, vocab editor) without the container resizing
    const observer = new ResizeObserver(update)
    observer.observe(el)
    for (const child of Array.from(el.children)) observer.observe(child)
    return () => {
      el.removeEventListener("scroll", update)
      observer.disconnect()
    }
  }, [el])

  const ref = useCallback((node: T | null) => setEl(node), [])
  return { ref, ...edges }
}
