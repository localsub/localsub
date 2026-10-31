import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd, KbdGroup } from "@/components/ui/kbd"
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
      <DialogContent className="max-w-[520px] gap-[18px] p-[30px] sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("shortcuts.title", "Keyboard Shortcuts")}</DialogTitle>
        </DialogHeader>
        {SHORTCUTS.map((group) => (
          <section key={group.category} className="flex flex-col gap-1.5">
            <h4 className="text-[13px] font-bold text-muted-foreground">{t(group.category)}</h4>
            <div className="rounded-[14px] bg-muted px-3.5 py-1">
              {group.items.map((shortcut) => (
                <div key={shortcut.keys} className="flex h-[42px] items-center justify-between gap-4">
                  <span className="text-[14.5px] font-semibold">{t(shortcut.action)}</span>
                  <KbdGroup>
                    {shortcut.keys.split("+").map((key) => (
                      <Kbd
                        key={key}
                        className="h-[26px] min-w-[26px] rounded-[7px] bg-card px-[7px] text-xs shadow-[0_1px_0_hsl(var(--border)),0_0_0_1px_hsl(var(--border))]"
                      >
                        {key}
                      </Kbd>
                    ))}
                  </KbdGroup>
                </div>
              ))}
            </div>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  )
}
