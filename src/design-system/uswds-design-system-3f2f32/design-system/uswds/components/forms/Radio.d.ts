import * as React from "react";

/** USWDS Radio — circular selection control for one-of-many choices. */
export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Text label shown beside the control. */
  label?: React.ReactNode;
  /** Group name — radios sharing a name are mutually exclusive. */
  name?: string;
  /** Disable the control. */
  disabled?: boolean;
}

export function Radio(props: RadioProps): React.JSX.Element;
