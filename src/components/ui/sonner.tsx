import { Check, Info } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'
import { Toaster as Sonner } from 'sonner'

type ToasterProps = React.ComponentProps<typeof Sonner>

/** The "!" glyph from the design: a stem and a dot, no ring around it. */
function Bang() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v4M12 16h.01" />
    </svg>
  )
}

const Toaster = ({ ...props }: ToasterProps) => {
  const { resolvedTheme } = useTheme()

  return (
    <Sonner
      theme={resolvedTheme as ToasterProps['theme']}
      className="toaster group"
      style={{ '--width': '380px' } as React.CSSProperties}
      icons={{
        success: <Check strokeWidth={3} />,
        error: <Bang />,
        warning: <Bang />,
        info: <Info strokeWidth={2.6} />,
      }}
      toastOptions={{
        // Sonner's own skin sits on [data-styled=true] selectors that outrank
        // utility classes, so it is switched off and the toast is drawn here.
        unstyled: true,
        classNames: {
          toast:
            'flex w-[var(--width)] items-start gap-3 rounded-[18px] bg-card px-[18px] py-4 font-sans text-[13px] text-foreground shadow-[0_12px_40px_rgba(0,0,0,0.16),0_0_0_1px_hsl(var(--border))] [&>*]:transition-opacity data-[expanded=false]:data-[front=false]:[&>*]:opacity-0',
          content: 'flex min-w-0 flex-1 flex-col gap-[3px]',
          title: 'text-[14.5px] font-bold leading-snug',
          description: 'text-[13px] leading-[1.45] text-muted-foreground',
          icon: 'flex size-[26px] shrink-0 items-center justify-center rounded-full [&_svg]:size-3.5',
          success: '[&_[data-icon]]:bg-status-success [&_[data-icon]]:text-status-success-foreground',
          error: '[&_[data-icon]]:bg-status-error [&_[data-icon]]:text-status-error-foreground',
          warning: '[&_[data-icon]]:bg-status-warning [&_[data-icon]]:text-status-warning-foreground',
          info: '[&_[data-icon]]:bg-primary [&_[data-icon]]:text-primary-foreground',
          actionButton:
            'h-8 shrink-0 cursor-pointer self-center rounded-[10px] bg-primary px-3 text-[13px] font-bold text-primary-foreground transition-colors hover:bg-primary/90',
          cancelButton:
            'h-8 shrink-0 cursor-pointer self-center rounded-[10px] bg-muted px-3 text-[13px] font-bold text-foreground-secondary transition-colors hover:bg-muted-hover',
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
