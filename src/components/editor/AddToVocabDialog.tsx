import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { toastSuccess } from "@/lib/toast"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import type { Vocabulary } from "@/types"

interface AddToVocabFormProps {
  vocabularies: Vocabulary[]
  onUpdateVocabulary: (v: Vocabulary) => Promise<Vocabulary[]>
  initialSource?: string
  initialTarget?: string
  /** Called after a successful save or when the user cancels. */
  onDone: () => void
}

/**
 * Shared "add term to vocabulary" form.
 *
 * Used by the EditPanel popover (blank fields) and by the subtitle-list
 * context menu dialog (one side prefilled from the text selection).
 * Mounting resets state, so callers should unmount it when closed.
 */
export function AddToVocabForm({ vocabularies, onUpdateVocabulary, initialSource = "", initialTarget = "", onDone }: AddToVocabFormProps) {
  const { t } = useTranslation()
  const [source, setSource] = useState(initialSource)
  const [target, setTarget] = useState(initialTarget)
  const [vocabId, setVocabId] = useState(vocabularies.length > 0 ? vocabularies[0].id : "")
  const [saving, setSaving] = useState(false)
  const sourceRef = useRef<HTMLInputElement>(null)
  const targetRef = useRef<HTMLInputElement>(null)

  // Focus the side the user still needs to fill in (after Radix's own
  // open-autofocus has settled).
  useEffect(() => {
    const el = initialSource.trim() && !initialTarget.trim() ? targetRef.current : sourceRef.current
    const id = window.setTimeout(() => el?.focus(), 0)
    return () => window.clearTimeout(id)
    // mount-only: prefill props never change while mounted
  }, [])

  if (vocabularies.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("editor.vocab.noVocabs")}</p>
  }

  const canSave = !saving && source.trim().length > 0 && target.trim().length > 0 && vocabId !== ""

  const handleSave = async () => {
    if (!canSave) return
    const vocab = vocabularies.find((v) => v.id === vocabId)
    if (!vocab) return
    const updated: Vocabulary = {
      ...vocab,
      entries: [
        ...vocab.entries,
        { id: crypto.randomUUID(), source: source.trim(), target: target.trim() },
      ],
      updated_at: new Date().toISOString(),
    }
    setSaving(true)
    try {
      await onUpdateVocabulary(updated)
      toastSuccess(t("editor.vocab.added", { name: vocab.name }), t("editor.vocab.addedDesc"))
      onDone()
    } catch {
      // error toast handled by useVocabularies
    } finally {
      setSaving(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 한국어/일본어 IME 조합 확정 Enter가 저장으로 새지 않게 가드
    if (e.key === "Enter" && !e.nativeEvent.isComposing) handleSave()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="vocab-add-source" className="text-xs">{t("editor.vocab.source")}</Label>
        <Input
          id="vocab-add-source"
          ref={sourceRef}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-8 text-sm"
          placeholder={t("editor.vocab.source")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="vocab-add-target" className="text-xs">{t("editor.vocab.target")}</Label>
        <Input
          id="vocab-add-target"
          ref={targetRef}
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={handleKeyDown}
          className="h-8 text-sm"
          placeholder={t("editor.vocab.target")}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">{t("editor.vocab.selectVocab")}</Label>
        <Select value={vocabId} onValueChange={setVocabId}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {vocabularies.map((v) => (
              <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onDone}>
          {t("shared.cancel")}
        </Button>
        <Button size="sm" disabled={!canSave} onClick={handleSave}>
          {t("editor.vocab.addToVocab")}
        </Button>
      </div>
    </div>
  )
}

interface AddToVocabDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  vocabularies: Vocabulary[]
  onUpdateVocabulary: (v: Vocabulary) => Promise<Vocabulary[]>
  prefillSource: string
  prefillTarget: string
}

/**
 * Small dialog opened from the subtitle-list context menu after the user
 * selects text in a line. The selected side is prefilled; the user types
 * the counterpart and picks the destination vocabulary.
 */
export function AddToVocabDialog({ open, onOpenChange, vocabularies, onUpdateVocabulary, prefillSource, prefillTarget }: AddToVocabDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{t("editor.vocab.addToVocab")}</DialogTitle>
          <DialogDescription>{t("editor.vocab.dialogDesc")}</DialogDescription>
        </DialogHeader>
        <AddToVocabForm
          vocabularies={vocabularies}
          onUpdateVocabulary={onUpdateVocabulary}
          initialSource={prefillSource}
          initialTarget={prefillTarget}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
