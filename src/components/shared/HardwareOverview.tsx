import { useTranslation } from "react-i18next";
import { Cpu, MemoryStick, Monitor, Microchip } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { HardwareInfo } from "../../types";

interface HardwareOverviewProps {
  hardware: HardwareInfo;
}

export function HardwareOverview({ hardware }: HardwareOverviewProps) {
  const { t } = useTranslation();

  return (
    <div className="grid grid-cols-2 gap-3">
      <HwCard
        icon={Cpu}
        label={t("wizard.environment.cpuCard")}
        value={hardware.cpu_name}
        sub={`${hardware.cpu_cores} cores`}
      />
      <HwCard
        icon={MemoryStick}
        label={t("wizard.environment.ramCard")}
        value={`${hardware.total_ram_gb.toFixed(1)} GB`}
        sub={`${hardware.available_ram_gb.toFixed(1)} GB free`}
      />
      <HwCard
        icon={Monitor}
        label={t("wizard.environment.gpuCard")}
        value={hardware.gpu?.name ?? t("wizard.environment.noGpu")}
        sub={hardware.gpu ? `${hardware.gpu.vram_mb} MB VRAM` : undefined}
      />
      <HwCard
        icon={Microchip}
        label={t("wizard.environment.diskCard")}
        value={hardware.avx2_support ? "AVX2" : hardware.avx_support ? "AVX" : "SSE"}
        sub={t("wizard.environment.instructionSet")}
      />
    </div>
  );
}

function HwCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-lg bg-surface-inset p-3">
      <div className="mb-1 flex items-center gap-1.5">
        <Icon className="h-3.5 w-3.5 text-slate-500" />
        <p className="text-xs font-medium uppercase tracking-wider text-slate-500">
          {label}
        </p>
      </div>
      <p className="truncate text-sm font-medium text-slate-200">{value}</p>
      {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
    </div>
  );
}
