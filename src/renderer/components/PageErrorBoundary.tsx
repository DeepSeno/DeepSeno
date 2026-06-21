import { Component, ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props { children: ReactNode; pageName: string; }
interface State { hasError: boolean; error: Error | null; }

export class PageErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(`[${this.props.pageName}] Render error:`, error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center max-w-md">
            <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
            <p className="text-sm font-mono text-neutral-600 mb-1">Module Error: {this.props.pageName}</p>
            <p className="text-xs text-neutral-400 mb-4 font-mono break-all">{this.state.error?.message}</p>
            <button onClick={() => this.setState({ hasError: false, error: null })}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-neutral-200 hover:bg-neutral-50 transition-all">
              <RotateCcw className="w-3 h-3" /> Retry
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
