// Driving the resubmit wizard (#222) from a request card in tests: open it,
// and step through it as the provider would, with the wizard's own buttons.
import { fireEvent, within } from "@testing-library/react";

/** Open the full intake wizard on a sent-back request's card and return it. */
export function openResubmitWizard(card: HTMLElement): HTMLElement {
  fireEvent.click(within(card).getByRole("button", { name: "Review the intake and resubmit" }));
  return within(card).getByRole("region", { name: /^Edit the intake for/ });
}

/** The label of the wizard step showing. */
export function currentStep(wizard: HTMLElement): string {
  return wizard.querySelector('[aria-current="step"]')?.textContent ?? "";
}

/** Press Continue until the wizard shows the step labelled `label`. */
export function continueTo(wizard: HTMLElement, label: string): void {
  for (let i = 0; i < 10 && currentStep(wizard) !== label; i++) {
    fireEvent.click(within(wizard).getByRole("button", { name: /^Continue/ }));
  }
  if (currentStep(wizard) !== label) {
    throw new Error(`The wizard stopped at ${currentStep(wizard)}, not ${label}.`);
  }
}

/** Press Continue through to the last step and return its resubmit button. */
export function continueToResubmit(wizard: HTMLElement): HTMLElement {
  continueTo(wizard, "Review & submit");
  return within(wizard).getByRole("button", { name: /Answer and resubmit|Resubmitting/ });
}

/** Press Back until the wizard shows the step labelled `label`. */
export function backTo(wizard: HTMLElement, label: string): void {
  for (let i = 0; i < 10 && currentStep(wizard) !== label; i++) {
    fireEvent.click(within(wizard).getByRole("button", { name: /^Back/ }));
  }
  if (currentStep(wizard) !== label) {
    throw new Error(`The wizard stopped at ${currentStep(wizard)}, not ${label}.`);
  }
}
