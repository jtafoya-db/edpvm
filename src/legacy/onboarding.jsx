import React from "react";
import { getData } from "./appDataBridge.js";
import { ds } from "./ds.jsx";
import { loadSchema } from "../schema";
import { ArchDiagram as EdpArchDiagram, MiniStat } from "../components/SchemaForm";
import {
  OnboardingConfirmation,
  OnboardingIntakeScreen,
} from "../components/Onboarding/OnboardingIntake";
import { MyOnboardingRequestsScreen } from "../components/Onboarding";

// Thin legacy mount for the onboarding screens (#86). The screens themselves are
// typed TSX in src/components/Onboarding; this module only injects the ported
// design-system primitives the bootstrap registers on window, plus the
// seam-backed data, and keeps the globals this module has always exposed.
const StepIndicator = ds("StepIndicator");
const Accordion = ds("Accordion");
const SCHEMA = loadSchema();

/** The design-system chrome the TSX screens compose (see src/components/Onboarding/chrome.tsx). */
export function legacyChrome() {
  return {
    Page: window.Page,
    Trail: window.Trail,
    Panel: window.Panel,
    SectionHead: window.SectionHead,
    Pill: window.Pill,
    Icon: window.AppIcon,
    StepIndicator,
    Accordion,
  };
}

// Onboard new data into the Enterprise Data Platform (EDP): the schema-driven wizard.
function OnboardingScreen({ ctx }) {
  return <OnboardingIntakeScreen ctx={ctx} domains={getData().domains} chrome={legacyChrome()} />;
}

export function MyOnboardingRequestsMount(props) {
  return <MyOnboardingRequestsScreen {...props} chrome={legacyChrome()} />;
}

// wrapper so we can use the USWDS StepIndicator with our labels
function StepIndicatorWrap({ STEPS, step }) {
  return <StepIndicator steps={STEPS} current={step} counters />;
}

// window.ArchDiagram keeps its original prop shape ({ source, ingest,
// domainName, access }); the shared component takes AppIcon explicitly.
function ArchDiagram(props) {
  return <EdpArchDiagram {...props} Icon={window.AppIcon} />;
}

// Preserve the globals this module has always exposed (docs/build-plan-p1.md).
Object.assign(window, { OnboardingScreen, MiniStat, StepIndicatorWrap, ArchDiagram });
Object.assign(window, { ROI_LEVERS: SCHEMA.optionLists.roiLevers });

export { OnboardingScreen, OnboardingConfirmation };
