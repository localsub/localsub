import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown } from "lucide-react";
import type { SetupStatus, SetupProgress, SetupErrorKind } from "../types";
import { Progress } from "./Progress";
import { LocalSubLogo } from "./localsub-logo";
import { Button } from "./ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { VcRedistCard } from "@/components/shared/VcRedistCard"
import { cn } from "@/lib/utils";
import { FFMPEG_BUILDS, FFMPEG_SOURCE, LOG_DIR_HINT } from "../lib/links";

interface SetupScreenProps {
  status: SetupStatus;
  progress: SetupProgress | null;
  error: string | null;
  logLines: string[];
  onStart: () => void;
  onRetry: () => void;
  onReset: () => void;
  onOpenLogs: () => void;
}

const ERROR_KIND_KEYS = {
  network: "setup.error.network",
  disk: "setup.error.disk",
  no_wheel: "setup.error.noWheel",
  integrity: "setup.error.integrity",
} as const satisfies Record<Exclude<SetupErrorKind, "unknown">, string>;

/** Collapsible live log viewer with auto-scroll to the latest line. */
function SetupLogPanel({ logLines }: { logLines: string[] }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [open, logLines]);

  if (logLines.length === 0) return null;

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full">
      <CollapsibleTrigger className="mx-auto flex cursor-pointer items-center gap-1 rounded-sm text-[13px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDown
          className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {t("setup.logsToggle")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={scrollRef}
          className="mt-2 max-h-64 overflow-y-auto rounded-md bg-muted px-3.5 py-3 text-left font-mono text-[11.5px] leading-[1.7] tracking-normal text-foreground-secondary"
        >
          {logLines.map((line, i) => (
            <div key={i} className="whitespace-pre-wrap break-all">
              {line}
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SetupScreen({
  status,
  progress,
  error,
  logLines,
  onStart,
  onRetry,
  onReset,
  onOpenLogs,
}: SetupScreenProps) {
  const { t } = useTranslation();

  const errorKind = progress?.error_kind ?? null;
  const knownErrorKey =
    errorKind && errorKind !== "unknown" ? ERROR_KIND_KEYS[errorKind] : null;

  const isError = status === "ERROR";

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div
        className={cn(
          "flex w-full flex-col items-center gap-3.5 rounded-3xl bg-card text-center shadow-card",
          isError ? "max-w-[680px] px-10 pb-8 pt-10" : "max-w-[648px] px-11 pb-9 pt-11",
        )}
      >
        {isError ? (
          <div className="mb-1.5 flex size-14 items-center justify-center rounded-[18px] bg-status-error-soft text-status-error">
            <AlertCircle className="size-[26px]" />
          </div>
        ) : (
          <LocalSubLogo className="mb-2 h-14 w-14 scale-150" />
        )}
        <h1
          className={cn(
            "font-extrabold tracking-[-0.03em]",
            isError ? "text-2xl" : "text-[28px]",
          )}
        >
          {t("app.title")}
        </h1>
        {!isError && (
          <p className="whitespace-pre-line text-[15px] leading-[1.6] text-foreground-secondary">
            {t("setup.description")}
          </p>
        )}

        {status === "CHECKING" && (
          <div className="mt-1.5 flex items-center justify-center gap-2.5 p-4 text-sm font-semibold text-muted-foreground">
            <span className="spinner" />
            <span>{t("setup.checking")}</span>
          </div>
        )}

        {status === "NEEDED" && (
          <>
            <p className="mt-1.5 w-full rounded-lg bg-muted p-3.5 text-[14.5px] font-semibold">
              {t("setup.needed")}
            </p>
            {/* FFmpeg is GPLv3 and is fetched from a third party, not bundled.
                Say so before the download happens, not in a file nobody reads. */}
            <p className="text-[12.5px] leading-[1.6] text-muted-foreground">
              {t("setup.ffmpegNotice")}
            </p>
            <p className="text-[12.5px] leading-[1.6] text-muted-foreground">
              {t("setup.ffmpegDownloadLabel")}:{" "}
              <a
                href={FFMPEG_BUILDS}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary-text hover:underline"
              >
                gyan.dev/ffmpeg/builds
              </a>
              {" · "}
              {t("setup.ffmpegSourceLabel")}:{" "}
              <a
                href={FFMPEG_SOURCE}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-primary-text hover:underline"
              >
                github.com/FFmpeg/FFmpeg
              </a>
            </p>
            {/* Offered here too, on the same principle as the FFmpeg notice
                above: say it before the install, not in a file nobody reads.
                Renders nothing when the runtime is already present, and the
                install is never started automatically — the Windows elevation
                prompt has to be the direct result of a click, or it reads as
                something the app did behind the user's back. */}
            <div className="w-full text-left empty:hidden">
              <VcRedistCard />
            </div>
            <Button
              className="mt-3.5 h-14 w-full rounded-[16px] text-[17px]"
              onClick={onStart}
            >
              {t("setup.startButton")}
            </Button>
          </>
        )}

        {status === "IN_PROGRESS" && (
          <div className="mt-1.5 flex w-full flex-col gap-3">
            <Progress value={(progress?.progress ?? 0) * 100} />
            <p className="text-sm font-semibold text-foreground-secondary">
              {progress?.message ?? t("setup.startingFallback")}
            </p>
            {logLines.length > 0 && (
              <p className="h-5 truncate font-mono text-xs text-muted-foreground">
                {logLines[logLines.length - 1]}
              </p>
            )}
            <SetupLogPanel logLines={logLines} />
          </div>
        )}

        {isError && (
          <>
            {knownErrorKey ? (
              <p className="w-full rounded-lg bg-status-error-soft px-4 py-3.5 text-left text-[14.5px] font-semibold leading-[1.55] text-status-error">
                {t(knownErrorKey)}
              </p>
            ) : (
              <>
                <p className="max-h-[120px] w-full overflow-y-auto break-words rounded-lg bg-status-error-soft px-4 py-3.5 text-left font-mono text-xs leading-[1.6] tracking-normal text-status-error">
                  {error ?? t("setup.unknownError")}
                </p>
                {logLines.length > 0 && (
                  <p className="text-[13px] text-muted-foreground">{t("setup.error.unknown")}</p>
                )}
              </>
            )}
            <SetupLogPanel logLines={logLines} />
            <div className="mt-1.5 flex items-center gap-2">
              <Button className="h-[50px] px-[22px] text-[15.5px]" onClick={onRetry}>
                {t("setup.retryButton")}
              </Button>
              {/* 로그는 설치 폴더가 아니라 %APPDATA%에 있다. 그걸 모르면
                  사용자는 보고할 것을 못 찾는다 — 여기가 유일한 안내다. */}
              <Button
                variant="secondary"
                className="h-[50px] px-[22px] text-[15.5px]"
                onClick={onOpenLogs}
              >
                {t("setup.openLogsButton")}
              </Button>
            </div>
            {/* 파일 관리자가 안 열리는 경우를 위해 경로 자체도 노출한다. */}
            <code className="font-mono text-xs tracking-normal text-muted-foreground">{LOG_DIR_HINT}</code>
            {/* 부분 설치가 손상돼 retry가 반복 실패할 때의 탈출구:
                python-env를 통째로 비우고 처음부터 다시 설치. */}
            <button
              className="cursor-pointer rounded-sm text-[13px] font-semibold text-muted-foreground underline underline-offset-[3px] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={onReset}
            >
              {t("setup.resetButton")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
