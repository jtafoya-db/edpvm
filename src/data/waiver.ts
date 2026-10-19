export type LiveDataWaiverChecklist = {
  items: Array<{
    id: string;
    label: string;
    description?: string;
    required: boolean;
    attested: boolean;
    attestedBy?: string;
    attestedAt?: string;
    note?: string;
  }>;
};

// Editable starting template only; each organization must determine its own requirements.
export const DEFAULT_LIVE_DATA_WAIVER_TEMPLATE: LiveDataWaiverChecklist = {
  items: [
    {
      id: "pub-1075-safeguards",
      label: "Pub 1075 safeguards documented",
      required: true,
      attested: false,
    },
    {
      id: "data-sharing-agreement",
      label: "Data sharing agreement / ISA on file",
      required: true,
      attested: false,
    },
    {
      id: "privacy-impact-assessment",
      label: "Privacy impact assessment on file",
      required: true,
      attested: false,
    },
    {
      id: "sbu-ato-handling",
      label: "SBU / authority-to-operate handling confirmed",
      required: true,
      attested: false,
    },
  ],
};

export function createChecklist(
  template: LiveDataWaiverChecklist = DEFAULT_LIVE_DATA_WAIVER_TEMPLATE,
): LiveDataWaiverChecklist {
  return { items: template.items.map((item) => ({ ...item })) };
}

export function attest(
  checklist: LiveDataWaiverChecklist,
  itemId: string,
  by: string,
  when: string,
  note?: string,
): LiveDataWaiverChecklist {
  return {
    items: checklist.items.map((item) => {
      if (item.id !== itemId) return item;

      return {
        ...item,
        attested: true,
        attestedBy: by,
        attestedAt: when,
        ...(note === undefined ? {} : { note }),
      };
    }),
  };
}

export function isComplete(checklist: LiveDataWaiverChecklist): boolean {
  return checklist.items.every((item) => !item.required || item.attested);
}

export function remainingRequired(checklist: LiveDataWaiverChecklist) {
  return checklist.items.filter((item) => item.required && !item.attested);
}

export function waiverRequired(livesOnLiveData: boolean): boolean {
  return livesOnLiveData;
}
