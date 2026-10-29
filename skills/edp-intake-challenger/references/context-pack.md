# IRS and EDP intake context pack

Use this material to ask useful questions and explain review implications. It is decision context, not evidence that a particular intake satisfies a requirement.

## Architecture review

The current wizard recognizes three approved ingestion patterns:

- **EFTU secure file transfer** for scheduled file drops.
- **Informatica ETL** for Informatica-managed extraction and loading into EDP bronze tables.
- **EPZ bucket landing zone** for source-written objects that EDP ingests from the landing bucket.

An alternative such as a direct database link, API, stream, or custom connector is not automatically rejected, but it adds an EDP architecture consultation. Databricks-native access, Tableau, and Power BI are the current approved consumption choices. Other tools or outbound extracts likewise add consultation. Never rewrite an off-pattern choice as approved; make its operational need and constraints explicit enough for consultation.

## Sensitive data path

SBU data requires appropriate handling. An `SBU (FTI)` selection specifically adds a Publication 1075 safeguards review to the intake path. Challenge an FTI draft that says nothing about its safeguard-relevant scope, intended users, access, or handling, but do not invent controls or assert compliance. The useful next step is to identify missing facts for the safeguards path and the initiative point of contact—not to provide a compliance determination.

## Business value review

EDP business and ROI review scores the request against the selected mission-value lever(s), quantified benefit, platform cost/sizing, and a traceable explanation of how the onboarding causes the outcome. The six current levers and their useful measures are:

1. **Reduce fraud and improper payments** — refund fraud or improper payments prevented per year.
2. **Reduce the tax gap** — additional assessments or collections enabled per year.
3. **Better taxpayer services** — faster case resolution or fewer taxpayer touches.
4. **Reduce cost and contractor support** — contractor hours or O&M dollars avoided per year.
5. **Reduce IT spend / retire duplicate systems** — license, hosting, or duplicate-system costs retired per year.
6. **Improve data quality, security and compliance posture** — rework, audit findings, or manual controls avoided per year.

A dollar or hours estimate is not self-defending. Reviewers need the selected lever, baseline, calculation method, time horizon, accountable beneficiary, and avoidance of double-counting. Only suggest concrete numbers already present in the request. Otherwise ask the user to supply the missing basis.

## Concrete MVP test

A concrete MVP identifies the source dataset, target domain, approved or consultation-bound flow, first consumer/use case, delivery owner, refresh cadence, volume, transformation complexity, user population, measurable outcome, and explicit exclusions or later phases. A vague ask says only “centralize data,” “enable analytics,” or “use AI,” omits the first decision or workflow enabled, lacks a bounded cohort/time period, or bundles unrelated consumers and outcomes.

Challenge the gap without expanding the project into an ideal future state. Prefer the smallest end-to-end slice that can prove a selected ROI lever. Proposed wording must distinguish user-supplied facts from prompts such as `[provide baseline]` or `[name first consumer]`.

## Delivery and sizing

The delivery choice affects EDP capacity review: self-service uses approved templates and guidance; guided or platform-built delivery consumes platform engineering capacity. Sizing depends on data volume, load frequency, transformation complexity, and query users. Challenge unexplained estimates and contradictions, but do not recalculate or certify the wizard's indicative cost estimate.
