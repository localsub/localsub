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
    <div className="grid grid-cols-2 gap-2">
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
    <div className="flex min-w-0 flex-col gap-1 rounded-[14px] bg-muted px-4 py-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        <p className="truncate text-xs font-semibold">{label}</p>
      </div>
      <p className="truncate text-[15px] font-bold">{value}</p>
      {sub && <p className="truncate text-[12.5px] text-muted-foreground">{sub}</p>}
    </div>
  );
}
