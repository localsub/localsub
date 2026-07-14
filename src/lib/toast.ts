import { toast } from "sonner"

export interface ToastAction {
  label: string
  onClick: () => void
}

export function toastSuccess(message: string, description?: string, action?: ToastAction) {
  toast.success(message, { description, action })
}

export function toastError(message: string, description?: string) {
  toast.error(message, { description })
}

export function toastInfo(message: string, description?: string) {
  toast.info(message, { description })
}

export function toastWarning(message: string, description?: string) {
  toast.warning(message, { description })
}
