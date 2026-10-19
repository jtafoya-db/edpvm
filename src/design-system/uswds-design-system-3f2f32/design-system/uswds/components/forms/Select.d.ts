import * as React from "react";

/** USWDS Select — labelled native dropdown. */
export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "width"> {
  label?: React.ReactNode;
  id?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  width?: "sm" | "md" | "default" | "lg" | "full";
  children?: React.ReactNode;
}

export function Select(props: SelectProps): React.JSX.Element;
