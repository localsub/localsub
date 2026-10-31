import type { ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Section title + one-line description above a settings card. */
export function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="text-xl font-extrabold">{title}</h3>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
    </div>
  )
}

/** White card holding a stack of SettingsRow, divided by hairlines. */
export function SettingsCard({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col rounded-xl bg-card px-6 py-2 shadow-card", className)}>
      {children}
    </div>
  )
}

export function SettingsRow({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn("flex flex-col gap-3 border-b border-border py-5 last:border-b-0", className)}>
      {children}
    </div>
  )
}
