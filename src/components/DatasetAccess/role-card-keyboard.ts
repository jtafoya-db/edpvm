import type { KeyboardEvent } from "react";

/** Implements the native-radio arrow-key pattern for an opted-in visual role-card group. */
export function handleRoleGroupKeyDown(event: KeyboardEvent<HTMLDivElement>) {
  if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
    return;
  }
  const radios = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('button[role="radio"]'),
  );
  const current = radios.indexOf(document.activeElement as HTMLButtonElement);
  if (current < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? radios.length - 1
        : (current +
            (event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1) +
            radios.length) %
          radios.length;
  radios[next]?.focus();
  radios[next]?.click();
}
