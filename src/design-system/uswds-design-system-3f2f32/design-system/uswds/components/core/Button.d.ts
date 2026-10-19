import * as React from "react";

/**
 * USWDS Button — the primary call-to-action element.
 *
 * @startingPoint section="Core" subtitle="Primary, secondary, outline & more — all states" viewport="700x200"
 */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. */
  variant?: "default" | "secondary" | "base" | "accent-cool" | "accent-warm" | "outline" | "unstyled";
  /** Size. `big` uses the large type step and roomier padding. */
  size?: "default" | "big";
  /** Disable the button (also sets aria-disabled). */
  disabled?: boolean;
  /** Material Icons ligature name, e.g. "file_download". */
  icon?: string;
  /** Which side the icon sits on. */
  iconPosition?: "left" | "right";
  children?: React.ReactNode;
}

export function Button(props: ButtonProps): React.JSX.Element;
