// Type shim for the onboarding entrypoint (matches the bootstrap.d.ts pattern).
// onboarding.jsx registers window.OnboardingScreen and the other prototype
// globals as import side effects; it also now exports the screen and its
// post-submit confirmation so tests can mount them directly. The bundler and
// vitest load the real .jsx at runtime.
import type { ComponentType } from "react";

export declare const OnboardingScreen: ComponentType<{ ctx: unknown }>;
export declare const MyOnboardingRequestsMount: ComponentType<Record<string, unknown>>;
export declare function legacyChrome(): Record<string, unknown>;
export declare const OnboardingConfirmation: ComponentType<{
  request: unknown;
  onboarding: unknown;
  save?: unknown;
  go: (name: string, params?: unknown) => void;
  onReset: () => void;
}>;
