import React from "react";
import { Choice } from "./ChoiceField.jsx";

/** USWDS Checkbox — square custom control with a white checkmark when checked. */
export function Checkbox(props) {
  return <Choice {...props} shape="checkbox" />;
}
