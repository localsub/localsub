import { useTranslation } from "react-i18next"
import { AlertTriangle, CheckCircle2, Download, Info, ShieldAlert } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { useVcRedist } from "@/hooks/useVcRedist"
import { toastError, toastSuccess, toastWarning } from "@/lib/toast"
import type { VcRedistAttempt, VcRedistStage } from "@/types"

/**
 * Missing Visual C++ runtime: what is broken, and the button that fixes it.
 *
 * Rendered in three places on purpose. Setup runs once and is remembered by a
 * marker, so an install offered *only* during setup becomes unreachable the
 * moment someone declines the elevation prompt — the app would then sit there
 * permanently broken with no way to retry. Putting the same card on the
 * dashboard and in settings means the offer survives every refusal.
 *
 * - `banner` renders nothing while the runtime is present (dashboard, setup).
 * - `section` always renders, including the healthy state (settings).
 */
export function VcRedistCard({ variant = "banner" }: { variant?: "banner" | "section" }) {
  const { t } = useTranslation()
  const { state, progress, installing, error, install, cancel } = useVcRedist()

  // Optional chaining as well as the hook's validation: this component is
  // mounted in App, so throwing here blanks the entire window.
  const missing = state?.status?.missing
  if (!missing) return null

  const coreBlocked = state?.status?.core_blocked ?? false
  const healthy = missing.length === 0

  if (healthy && variant === "banner") return null

  const handleInstall = async () => {
    const outcome = await install()
    if (outcome === "ok") {
      toastSuccess(t("vcredist.toast.installed"), t("vcredist.toast.installedBody"))
    } else if (outcome === "reboot_required") {
      toastWarning(t("vcredist.toast.reboot"), t("vcredist.toast.rebootBody"))
    } else if (outcome === "declined") {
      // Not an error: the user is allowed to say no, and the card stays put.
      toastWarning(t("vcredist.toast.declined"), t("vcredist.toast.declinedBody"))
    } else if (error) {
      toastError(t("vcredist.toast.failed"), error)
    }
  }

  if (healthy) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <CheckCircle2 className="h-4 w-4 text-status-success shrink-0" />
        <span>{t("vcredist.installed")}</span>
      </div>
    )
  }

  const tone = coreBlocked
    ? "border-status-error/40 bg-status-error/5"
    : "border-status-warning/40 bg-status-warning/5"

  return (
    <div className={`flex flex-col gap-3 rounded-lg border p-4 ${tone}`}>
      <div className="flex items-start gap-2.5">
        {coreBlocked ? (
          <ShieldAlert className="mt-0.5 h-4.5 w-4.5 shrink-0 text-status-error" />
        ) : (
          <AlertTriangle className="mt-0.5 h-4.5 w-4.5 shrink-0 text-status-warning" />
        )}
        <div className="flex flex-col gap-1">
          <p className="text-sm font-semibold">
            {coreBlocked ? t("vcredist.title") : t("vcredist.titleMinor")}
          </p>
          <p className="text-sm text-muted-foreground">
            {coreBlocked ? t("vcredist.bodyCore") : t("vcredist.bodyMinor")}
          </p>
          <p className="text-xs text-muted-foreground/80">
            {t("vcredist.missingList", { list: missing.join(", ") })}
          </p>
        </div>
      </div>

      {state.last_attempt && !installing && (
        <LastAttempt attempt={state.last_attempt} />
      )}

      {installing ? (
        <InstallProgress
          stage={progress?.stage ?? "download"}
          done={progress?.bytes_downloaded ?? 0}
          total={progress?.bytes_total ?? 0}
          onCancel={cancel}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {/* Said before the click, not after: the prompt names Microsoft, not
              LocalSub, and an unexplained elevation dialog reads as malware. */}
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {t("vcredist.uacNotice")}
          </p>
          <div>
            <Button size="sm" onClick={handleInstall}>
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {state.last_attempt ? t("vcredist.retry") : t("vcredist.install")}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

const MB = 1024 * 1024

function InstallProgress({
  stage,
  done,
  total,
  onCancel,
}: {
  stage: VcRedistStage
  done: number
  total: number
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium">{t(`vcredist.stage.${stage}`)}</span>
        {stage === "download" && total > 0 && (
          <span className="text-muted-foreground tabular-nums">
            {(done / MB).toFixed(1)} / {(total / MB).toFixed(1)} MB
          </span>
        )}
      </div>
      {stage === "download" ? (
        <Progress value={pct} className="h-1.5" />
      ) : (
        <p className="text-xs text-muted-foreground">{t(`vcredist.stageHint.${stage}`)}</p>
      )}
      {/* Only the download can be interrupted; once Microsoft's installer owns
          the screen the choice is the user's, in their dialog. */}
      {stage === "download" && (
        <div>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("vcredist.cancel")}
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * One line saying where the previous attempt stopped.
 *
 * `outcome === null` is the interesting case: the record is written when an
 * attempt starts and updated when it ends, so a missing outcome means the app
 * was closed or killed mid-run. Without that distinction an interrupted attempt
 * and a declined one would both show as "it just did not work".
 */
function LastAttempt({ attempt }: { attempt: VcRedistAttempt }) {
  const { t } = useTranslation()

  const when = new Date(attempt.at_epoch_secs * 1000).toLocaleString()
  const stage = t(`vcredist.stage.${attempt.stage}`)

  let summary: string
  let hint: string | null = null

  if (attempt.outcome === null) {
    summary = t("vcredist.last.interrupted", { stage, when })
    hint =
      attempt.stage === "download" && attempt.bytes_total > 0
        ? t("vcredist.last.partialDownload", {
            done: (attempt.bytes_downloaded / MB).toFixed(1),
            total: (attempt.bytes_total / MB).toFixed(1),
          })
        : null
  } else if (attempt.outcome === "declined") {
    summary = t("vcredist.last.declined", { when })
    hint = t("vcredist.hint.declined")
  } else if (attempt.outcome === "failed") {
    summary = t("vcredist.last.failed", { stage, when })
    hint = t(`vcredist.hint.${attempt.stage}`)
  } else if (attempt.outcome === "reboot_required") {
    summary = t("vcredist.last.rebootRequired", { when })
    hint = t("vcredist.hint.reboot")
  } else {
    summary = t("vcredist.last.ok", { when })
  }

  return (
    <div className="flex flex-col gap-1 rounded-md bg-background/60 px-3 py-2">
      <p className="text-xs font-medium">{summary}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      {attempt.detail && (
        <p className="text-xs text-muted-foreground/70 break-all">{attempt.detail}</p>
      )}
      {attempt.exit_code !== null && attempt.outcome === "failed" && (
        <p className="text-xs text-muted-foreground/70 tabular-nums">
          {t("vcredist.exitCode", { code: attempt.exit_code })}
        </p>
      )}
    </div>
  )
}
