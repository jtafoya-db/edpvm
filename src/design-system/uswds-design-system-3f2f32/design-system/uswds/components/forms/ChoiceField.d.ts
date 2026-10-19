import * as React from "react";

/**
 * USWDS Choice — the shared checkbox/radio field that `Checkbox` and `Radio`
 * build on. Renders the control plus its bound `<label>`.
 */
export interface ChoiceProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  /** Text label shown beside the control. */
  label?: React.ReactNode;
  /** Control shape. */
  shape?: "checkbox" | "radio";
  /** Group name. */
  name?: string;
  /** Disable the control. */
  disabled?: boolean;
}

export function Choice(props: ChoiceProps): React.JSX.Element;
