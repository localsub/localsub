import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertCircle, RotateCcw } from "lucide-react";
import { Button } from "./ui/button";
import i18n from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info.componentStack);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full items-center justify-center px-10 py-9">
          <div className="flex w-full max-w-[440px] flex-col items-center gap-2.5 text-center">
            <div className="mb-2 flex size-16 items-center justify-center rounded-xl bg-status-error-soft text-status-error">
              <AlertCircle className="size-7" />
            </div>
            <p className="text-[22px] font-extrabold">{i18n.t("errorBoundary.title")}</p>
            <p className="text-[15px] leading-[1.55] text-foreground-secondary text-pretty">
              {i18n.t("errorBoundary.description")}
            </p>
            {this.state.error && (
              <pre className="mt-2 max-h-32 w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-card px-3.5 py-3 text-left font-mono text-xs leading-[1.6] tracking-normal text-status-error">
                {this.state.error.message}
              </pre>
            )}
            <Button onClick={this.handleReset} className="mt-2.5 px-[22px]">
              <RotateCcw />
              {i18n.t("errorBoundary.tryAgain")}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
