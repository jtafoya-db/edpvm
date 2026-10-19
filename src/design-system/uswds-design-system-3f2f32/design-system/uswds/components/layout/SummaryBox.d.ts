import * as React from "react";

/** USWDS Summary Box — scannable summary of key information / jump links. */
export interface SummaryBoxProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Bold heading. */
  heading?: React.ReactNode;
  children?: React.ReactNode;
}

export function SummaryBox(props: SummaryBoxProps): React.JSX.Element;
