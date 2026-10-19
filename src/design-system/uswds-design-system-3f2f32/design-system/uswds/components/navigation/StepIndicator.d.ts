import * as React from "react";

/** USWDS Step Indicator — progress through a multi-step flow (e.g. a form). */
export interface StepIndicatorProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Ordered step labels. */
  steps: string[];
  /** 0-based index of the current step. */
  current?: number;
  /** Show step labels. */
  showLabels?: boolean;
  /** Show numbered/checked counters. */
  counters?: boolean;
}

export function StepIndicator(props: StepIndicatorProps): React.JSX.Element;
