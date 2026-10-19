// Filling the new-onboarding intake wizard's required fields in tests, as the
// provider would. Each step's required answers are filled here, so a change to
// what the intake asks (#251 made the initiative owner required and dropped the
// accountable data steward) is made once, not in every test that walks it.
import { fireEvent, within } from "@testing-library/react";

/** Fill the first step's required fields: the initiative name and its owner, Myself. */
export function fillInitiativeStep(scope: HTMLElement, name = "Collections case signals"): void {
  fireEvent.change(within(scope).getByLabelText(/initiative name/i), {
    target: { value: name },
  });
  const owner = within(scope).getByRole("group", { name: /initiative owner/i });
  fireEvent.click(within(owner).getByRole("radio", { name: /myself/i }));
}

/** Name dataset `d`'s owner `o` (both 1-based) as Someone else, with a name and email. */
export function fillDatasetOwner(
  scope: HTMLElement,
  d: number,
  o: number,
  owner: { name: string; email: string },
): void {
  const row = within(scope).getByRole("group", { name: `Dataset ${d} owner ${o}` });
  fireEvent.click(within(row).getByRole("radio", { name: /someone else/i }));
  fireEvent.change(within(row).getByLabelText("Owner's name"), { target: { value: owner.name } });
  fireEvent.change(within(row).getByLabelText("Owner's email"), {
    target: { value: owner.email },
  });
}
