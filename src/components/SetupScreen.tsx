import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown } from "lucide-react";
import type { SetupStatus, SetupProgress, SetupErrorKind } from "../types";
import { Progress } from "./Progress";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible";
import { FFMPEG_BUILDS, FFMPEG_SOURCE } from "../lib/links";

interface SetupScreenProps {
  status: SetupStatus;
  progress: SetupProgress | null;
  error: string | null;
  logLines: string[];
  onStart: () => void;
  onRetry: () => void;
  onReset: () => void;
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
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="mx-auto flex cursor-pointer items-center gap-1 text-xs text-slate-500 transition-colors hover:text-slate-300">
        <ChevronDown
          className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
        {t("setup.logsToggle")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div
          ref={scrollRef}
          className="mt-2 max-h-64 overflow-y-auto rounded-md bg-surface-inset p-2.5 text-left font-mono text-xs leading-relaxed text-slate-400"
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

export function SetupScreen({ status, progress, error, logLines, onStart, onRetry, onReset }: SetupScreenProps) {
  const { t } = useTranslation();

  const errorKind = progress?.error_kind ?? null;
  const knownErrorKey =
    errorKind && errorKind !== "unknown" ? ERROR_KIND_KEYS[errorKind] : null;

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[500px] rounded-2xl bg-surface p-10 text-center">
        <h1 className="mb-4 text-[1.75rem] font-bold text-slate-50">{t("app.title")}</h1>
        <p className="mb-6 whitespace-pre-line text-[0.9rem] leading-relaxed text-slate-400">
          {t("setup.description")}
        </p>

        {status === "CHECKING" && (
          <div className="flex items-center justify-center gap-2.5 p-4 text-slate-400">
            <span className="spinner" />
            <span>{t("setup.checking")}</span>
          </div>
        )}

        {status === "NEEDED" && (
          <div className="flex flex-col items-center gap-4">
            <p className="text-sm text-slate-500">
              {t("setup.needed")}
            </p>
            {/* FFmpeg is GPLv3 and is fetched from a third party, not bundled.
                Say so before the download happens, not in a file nobody reads. */}
            <p className="text-center text-xs leading-relaxed text-slate-500">
              {t("setup.ffmpegNotice")}
            </p>
            <p className="text-center text-xs leading-relaxed text-slate-500">
              {t("setup.ffmpegDownloadLabel")}:{" "}
              <a
                href={FFMPEG_BUILDS}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                gyan.dev/ffmpeg/builds
              </a>
              {" · "}
              {t("setup.ffmpegSourceLabel")}:{" "}
              <a
                href={FFMPEG_SOURCE}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                github.com/FFmpeg/FFmpeg
              </a>
            </p>
            <button
              className="cursor-pointer rounded-md bg-primary px-8 py-3 text-base font-medium text-white transition-opacity hover:opacity-85"
              onClick={onStart}
            >
              {t("setup.startButton")}
            </button>
          </div>
        )}

        {status === "IN_PROGRESS" && (
          <div className="flex flex-col gap-3">
            <Progress value={(progress?.progress ?? 0) * 100} />
            <p className="text-sm text-slate-400">
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

        {status === "ERROR" && (
          <div className="flex flex-col items-stretch gap-4">
            {knownErrorKey ? (
              <p className="rounded-md bg-surface-inset p-2.5 text-sm text-danger">
                {t(knownErrorKey)}
              </p>
            ) : (
              <>
                <p className="max-h-[120px] overflow-y-auto break-words rounded-md bg-surface-inset p-2.5 text-left text-xs text-danger">
                  {error ?? t("setup.unknownError")}
                </p>
                {logLines.length > 0 && (
                  <p className="text-xs text-slate-500">{t("setup.error.unknown")}</p>
                )}
              </>
            )}
            <SetupLogPanel logLines={logLines} />
            <div className="flex flex-col items-center gap-2">
              <button
                className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-85"
                onClick={onRetry}
              >
                {t("setup.retryButton")}
              </button>
              {/* 부분 설치가 손상돼 retry가 반복 실패할 때의 탈출구:
                  python-env를 통째로 비우고 처음부터 다시 설치. */}
              <button
                className="cursor-pointer text-xs text-slate-500 underline-offset-2 transition-colors hover:text-slate-300 hover:underline"
                onClick={onReset}
              >
                {t("setup.resetButton")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
