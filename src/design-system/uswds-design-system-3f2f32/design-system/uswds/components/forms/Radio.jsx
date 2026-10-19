import React from "react";
import { Choice } from "./ChoiceField.jsx";

/** USWDS Radio — circular custom control for mutually-exclusive choices. */
export function Radio(props) {
  return <Choice {...props} shape="radio" />;
}
