import * as React from "react";

/** USWDS Checkbox — square selection control. */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Text label shown beside the control. */
  label?: React.ReactNode;
  /** Group name. */
  name?: string;
  /** Disable the control. */
  disabled?: boolean;
}

export function Checkbox(props: CheckboxProps): React.JSX.Element;
