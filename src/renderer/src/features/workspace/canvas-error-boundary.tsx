import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface CanvasErrorBoundaryProps {
  children: ReactNode;
  onHome: () => void;
}

/** Keep project navigation available when a canvas render or effect fails. */
export class CanvasErrorBoundary extends Component<
  CanvasErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(
      'Unable to display project canvas:',
      error,
      info.componentStack,
    );
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="grid flex-1 place-items-center p-6">
        <div role="alert" className="text-center">
          <h1 className="text-lg font-medium">画布暂时无法显示</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            请重新加载后再打开项目，已保存的内容会保留。
          </p>
          <div className="mt-5 flex justify-center gap-3">
            <Button variant="outline" onClick={this.props.onHome}>
              返回项目列表
            </Button>
            <Button onClick={() => window.location.reload()}>重新加载</Button>
          </div>
        </div>
      </main>
    );
  }
}
