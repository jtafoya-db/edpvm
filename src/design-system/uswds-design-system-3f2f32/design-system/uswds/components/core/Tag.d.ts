import * as React from "react";

/** USWDS Tag — small uppercase label/pill for metadata, status, or category. */
export interface TagProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Background color token. */
  color?: "base" | "primary" | "primary-dark" | "secondary" | "accent-cool" | "accent-warm" | "success" | "light";
  /** `big` uses a larger type step and padding. */
  size?: "default" | "big";
  children?: React.ReactNode;
}

export function Tag(props: TagProps): React.JSX.Element;
