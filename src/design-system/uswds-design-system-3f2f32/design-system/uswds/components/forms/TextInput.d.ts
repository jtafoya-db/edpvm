import * as React from "react";

/**
 * USWDS Text Input — labelled single-line field with hint + error support.
 *
 * @startingPoint section="Forms" subtitle="Labelled text fields incl. hint & error states" viewport="480x520"
 */
export interface TextInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "width"> {
  /** Field label. */
  label?: React.ReactNode;
  /** Explicit id (auto-generated if omitted). */
  id?: string;
  /** Helper text shown under the label. */
  hint?: React.ReactNode;
  /** Error message — also switches the field to its error styling. */
  error?: React.ReactNode;
  /** Marks the field required and shows a red asterisk. */
  required?: boolean;
  /** Input type. */
  type?: string;
  /** Field width preset. */
  width?: "sm" | "md" | "default" | "lg" | "full";
}

export function TextInput(props: TextInputProps): React.JSX.Element;
