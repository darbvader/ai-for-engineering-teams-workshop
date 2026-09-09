'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  /** Subtree to guard. */
  children: ReactNode;
  /** Rendered in place of `children` after a crash. Defaults to a fallback card. */
  fallback?: ReactNode;
  /** Shown in the default fallback card so the user knows which widget failed. */
  title?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Reusable class-based error boundary.
 *
 * React has no hook equivalent, so this stays a class component. Its job is
 * containment: a widget that throws during render degrades to a small fallback
 * card instead of blanking the whole dashboard.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    // Logged for the developer; nothing from the error reaches the rendered
    // fallback, which stays deliberately generic.
    console.error('[ErrorBoundary] caught a render error', error, errorInfo);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    if (this.props.fallback !== undefined) {
      return this.props.fallback;
    }

    return (
      <section
        role="alert"
        className="rounded-lg border border-red-200 bg-white p-4 shadow-sm dark:border-red-900 dark:bg-neutral-900"
      >
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-neutral-50">
          {this.props.title ?? 'Something went wrong'}
        </h2>
        <p className="text-sm text-gray-600 dark:text-neutral-400">
          This section could not be displayed. The rest of the dashboard is unaffected.
        </p>
      </section>
    );
  }
}
