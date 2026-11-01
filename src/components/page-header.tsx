import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"

// The header is rendered by App (above the runtime banner), but its right-hand
// actions and the editor's file line belong to the page. Pages portal them in
// with <PageActions> / <PageMeta> instead of App knowing every page's buttons.
interface HeaderSlots {
  actions: HTMLElement | null
  meta: HTMLElement | null
  setActions: (el: HTMLElement | null) => void
  setMeta: (el: HTMLElement | null) => void
}

const HeaderSlotsContext = createContext<HeaderSlots | null>(null)

export function PageHeaderProvider({ children }: { children: ReactNode }) {
  const [actions, setActions] = useState<HTMLElement | null>(null)
  const [meta, setMeta] = useState<HTMLElement | null>(null)
  const value = useMemo(() => ({ actions, meta, setActions, setMeta }), [actions, meta])
  return <HeaderSlotsContext.Provider value={value}>{children}</HeaderSlotsContext.Provider>
}

interface PageHeaderProps {
  title: string
  description?: string
  /** Editor: smaller title, the page supplies its own meta line. */
  compact?: boolean
}

export function PageHeader({ title, description, compact }: PageHeaderProps) {
  const slots = useContext(HeaderSlotsContext)
  // On a narrow window the sidebar is an off-canvas sheet whose own toggle is
  // inside it, so the header carries the only way to open it.
  const { isMobile } = useSidebar()
  return (
    <header className="flex shrink-0 items-end gap-4">
      {isMobile && <SidebarTrigger className="mt-0.5 shrink-0 self-start" />}
      <div className="flex min-w-0 flex-col gap-1.5">
        <h1
          className={cn(
            "font-extrabold leading-tight",
            compact ? "text-2xl tracking-[-0.03em]" : "text-[28px] tracking-[-0.03em]",
          )}
        >
          {title}
        </h1>
        {description && <p className="truncate text-[15px] text-muted-foreground">{description}</p>}
        <div ref={slots?.setMeta} className="min-w-0 truncate text-[15px] text-muted-foreground empty:hidden" />
      </div>
      <div ref={slots?.setActions} className="ml-auto flex shrink-0 items-center gap-2 empty:hidden" />
    </header>
  )
}

export function PageActions({ children }: { children: ReactNode }) {
  const target = useContext(HeaderSlotsContext)?.actions
  return target ? createPortal(children, target) : null
}

export function PageMeta({ children }: { children: ReactNode }) {
  const target = useContext(HeaderSlotsContext)?.meta
  return target ? createPortal(children, target) : null
}
