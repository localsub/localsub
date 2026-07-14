import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useTranslation } from "react-i18next"

interface ShortcutsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SHORTCUTS = [
  { category: "shortcuts.playback" as const, items: [
    { keys: "Space", action: "shortcuts.playPause" as const },
  ]},
  { category: "shortcuts.editing" as const, items: [
    { keys: "Ctrl+Shift+S", action: "shortcuts.split" as const },
    { keys: "Ctrl+Shift+M", action: "shortcuts.merge" as const },
    { keys: "Delete", action: "shortcuts.delete" as const },
  ]},
  { category: "shortcuts.general" as const, items: [
    { keys: "Ctrl+S", action: "shortcuts.save" as const },
    { keys: "Ctrl+Z", action: "shortcuts.undo" as const },
    { keys: "Ctrl+Y", action: "shortcuts.redo" as const },
    { keys: "Ctrl+F", action: "shortcuts.find" as const },
    { keys: "Escape", action: "shortcuts.closeFind" as const },
  ]},
]

export function ShortcutsDialog({ open, onOpenChange }: ShortcutsDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title", "Keyboard Shortcuts")}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          {SHORTCUTS.map((group) => (
            <div key={group.category}>
              <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">
                {t(group.category)}
              </h4>
              <div className="flex flex-col gap-1">
                {group.items.map((shortcut) => (
                  <div
                    key={shortcut.keys}
                    className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-muted/50"
                  >
                    <span className="text-sm">{t(shortcut.action)}</span>
                    <div className="flex items-center gap-1">
                      {shortcut.keys.split("+").map((key) => (
                        <kbd
                          key={key}
                          className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted px-1.5 text-[11px] font-medium text-muted-foreground"
                        >
                          {key}
                        </kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
