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
        <div className="flex h-full items-center justify-center">
          <div className="flex flex-col items-center gap-4 text-center max-w-md">
            <div className="rounded-2xl bg-destructive/10 p-4 ring-1 ring-destructive/30">
              <AlertCircle className="h-8 w-8 text-destructive" />
            </div>
            <div>
              <p className="font-semibold text-lg">{i18n.t("errorBoundary.title")}</p>
              <p className="text-sm text-muted-foreground mt-1">
                {i18n.t("errorBoundary.description")}
              </p>
              {this.state.error && (
                <pre className="mt-3 max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs text-left text-muted-foreground">
                  {this.state.error.message}
                </pre>
              )}
            </div>
            <Button onClick={this.handleReset} variant="outline" size="sm">
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              {i18n.t("errorBoundary.tryAgain")}
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
