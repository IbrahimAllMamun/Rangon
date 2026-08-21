"use client";

import * as React from "react";

interface Props {
  children: React.ReactNode;
  fallback: React.ReactNode;
  /** Named in the console so a boundary that fires is identifiable. */
  label: string;
}

/**
 * Component-level error boundary.
 *
 * Next's `error.tsx` replaces a whole route segment, which is the wrong blast
 * radius for a widget: a navbar that throws would blank the page under it. This
 * keeps the failure local and renders a usable substitute
 * (docs/architecture/navigation.md §6).
 */
export class ErrorBoundary extends React.Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(`${this.props.label} failed to render:`, error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
