export {};
/* ============================================================================
   IRS Entitlements Discovery & Access Broker — sample catalog data
   Plain JS (no JSX). Assigned to window.AppData. Loaded before the app scripts.
   All content is fictional sample data for a wireframe/prototype.
   ============================================================================ */
(function () {
  // ---- Current user (the person using the app) -----------------------------
  const user = {
    // Local-dev seed only. In a deployed app the real signed-in Databricks
    // identity (resolved server-side via /api/session) replaces this; the seed
    // is the fallback for local dev / tests where no server is reachable.
    principalId: "seed-dana-whitfield",
    name: "Dana Whitfield",
    initials: "DW",
    title: "Tenant Data Analyst",
    tenant: "RAAS — Research, Applied Analytics & Statistics",
    email: "dana.whitfield@example.gov",
    isOnboardingLead: true,
    isAdmin: true,
  };

  // ---- Source systems ------------------------------------------------------
  const systems = [
    { id: "mef", name: "Modernized e-File (MeF)", short: "MeF", org: "Submission Processing", type: "Filing intake" },
    { id: "imf", name: "Individual Master File (IMF)", short: "IMF", org: "Submission Processing", type: "Master file" },
    { id: "bmf", name: "Business Master File (BMF)", short: "BMF", org: "Submission Processing", type: "Master file" },
    { id: "ptin", name: "PTIN Registration System", short: "PTIN", org: "Return Preparer Office", type: "Registry" },
    { id: "hptin", name: "Historical PTIN (HPTIN)", short: "HPTIN", org: "Return Preparer Office", type: "Registry archive" },
    { id: "irworks", name: "IRWorks Case Management", short: "IRWorks", org: "Enforcement Ops", type: "Case management" },
    { id: "idrs", name: "Integrated Data Retrieval System (IDRS)", short: "IDRS", org: "Account Management", type: "Account system" },
    { id: "cade2", name: "CADE 2", short: "CADE 2", org: "Submission Processing", type: "Account settlement" },
    { id: "aims", name: "Audit Information Mgmt System (AIMS)", short: "AIMS", org: "Examination", type: "Exam system" },
    { id: "irp", name: "Information Returns Processing (IRP)", short: "IRP", org: "Submission Processing", type: "Information returns" },
  ];
  const sys = (id) => systems.find((s) => s.id === id);

  // ---- Business domains (periodic-table taxonomy) --------------------------
  const domains = [
    { id: "individual-filing", name: "Individual Filing", code: "IF-01", color: "primary",
      tags: ["Filing", "Individual Tax", "Taxpayer Accounts"],
      aliases: ["1040", "Individual returns", "IMF"],
      description: "Individual taxpayer returns, account balances, refunds, and filing history sourced from IMF and CADE 2.",
      useCases: ["Refund trend analysis", "Filing season operations", "Individual account research"],
      systems: ["imf", "cade2", "mef"], steward: "Marcus Liu", owner: "Individual Returns Data Council" },
    { id: "business-filing", name: "Business Filing", code: "BF-02", color: "accent-cool",
      tags: ["Filing", "Business Tax", "Entities"],
      aliases: ["BMF", "Business returns", "Entity"],
      description: "Business entity returns, registrations, and curated taxpayer summaries sourced from the Business Master File.",
      useCases: ["Entity population analysis", "Business compliance research", "Filing volume reporting"],
      systems: ["bmf", "mef"], steward: "Priya Nadar", owner: "Business Returns Data Council" },
    { id: "modernized-efile", name: "Modernized e-File", code: "MF-03", color: "accent-warm",
      tags: ["Filing", "Electronic Filing", "Submission Processing"],
      aliases: ["MeF", "e-File", "Submissions"],
      description: "Electronic submission intake, filing status, acknowledgements, and reject analysis across return types.",
      useCases: ["Filing status monitoring", "Reject root-cause analysis", "Submission throughput"],
      systems: ["mef"], steward: "Erin Coyle", owner: "Submission Processing Council" },
    { id: "preparer-practitioner", name: "Preparer & Practitioner", code: "PP-04", color: "success",
      tags: ["Tax Professionals", "Credentials", "Oversight"],
      aliases: ["PTIN", "Preparers", "Practitioner oversight"],
      description: "Paid preparer registrations, credentials, continuing education, and oversight signals.",
      useCases: ["Preparer oversight", "Credential verification", "CE compliance tracking"],
      systems: ["ptin", "hptin"], steward: "Janet Osei", owner: "Return Preparer Office" },
    { id: "enforcement-collections", name: "Enforcement & Collections", code: "EC-05", color: "secondary",
      tags: ["Enforcement", "Collections", "Case Management"],
      aliases: ["Collections", "Balance due", "Cases"],
      description: "Collections inventory, balance-due accounts, and enforcement case signals. Predominantly FTI.",
      useCases: ["Case prioritization", "Balance-due inventory", "Treatment-stream analytics"],
      systems: ["irworks", "idrs"], steward: "Carlos Reyes", owner: "Collection Strategy Council" },
    { id: "compliance-exam", name: "Compliance & Exam", code: "CE-06", color: "primary",
      tags: ["Compliance", "Examination", "Case Management"],
      aliases: ["Exam", "Audit", "AIMS"],
      description: "Examination case inventory, outcomes, and audit selection signals from AIMS and IRWorks.",
      useCases: ["Exam outcome analysis", "Workload selection research", "Coverage reporting"],
      systems: ["aims", "irworks"], steward: "Helen Park", owner: "Examination Data Council" },
    { id: "taxpayer-identity", name: "Taxpayer Identity", code: "TI-07", color: "accent-cool",
      tags: ["Identity", "Authentication", "Fraud Prevention"],
      aliases: ["Identity", "Authentication", "Verification"],
      description: "Identity verification events, authentication signals, and identity-theft indicators.",
      useCases: ["Identity assurance analytics", "Fraud signal research", "Authentication monitoring"],
      systems: ["idrs", "cade2"], steward: "Sam Whitfield", owner: "Identity Assurance Council" },
    { id: "information-returns", name: "Information Returns", code: "IR-08", color: "accent-warm",
      tags: ["Information Reporting", "Document Matching", "Withholding"],
      aliases: ["IRP", "1099", "W-2", "Payer"],
      description: "Information return documents (1099, W-2), payer directories, and matching populations.",
      useCases: ["Underreporter analysis", "Payer population research", "Document matching"],
      systems: ["irp"], steward: "Lena Brooks", owner: "Information Reporting Council" },
  ];
  const dom = (id) => domains.find((d) => d.id === id);

  // ---- Access bundles ------------------------------------------------------
  // component types: bears_role | sailpoint_group | dbx_workspace | dbx_entitlement | dbx_group | uc_grant
  const bundles = [
    {
      id: "analyst-starter", name: "Analyst Starter Pack", persona: "Tenant Analyst", color: "primary",
      description: "The default toolkit for a new tenant analyst: analytics workspace access, SQL warehouse, and read access to your domain's curated Gold layer.",
      sla: "3–5 business days", bearsRequired: true, approvalModel: "Manager → Data steward → BEARS",
      approvers: ["Tenant manager", "Domain data steward", "BEARS workflow"],
      prerequisites: [], requestable: true,
      components: [
        { type: "dbx_workspace", label: "Analytics Workspace membership", scope: "ws-analytics-prod" },
        { type: "dbx_entitlement", label: "Workspace access + Databricks SQL", scope: "Workspace access, SQL" },
        { type: "dbx_group", label: "Account group: analysts-tenant", scope: "analysts-tenant" },
        { type: "uc_grant", label: "USE CATALOG + USE SCHEMA on domain Gold", scope: "prod_*.{domain}_curated" },
        { type: "uc_grant", label: "SELECT on curated Gold tables", scope: "prod_*.{domain}_curated.*" },
        { type: "bears_role", label: "BEARS role: DBX-ANALYST-BASE", scope: "DBX-ANALYST-BASE" },
        { type: "sailpoint_group", label: "SailPoint group: DBX_Analyst_Base", scope: "DBX_Analyst_Base" },
      ],
      unlocks: ["Analytics Prod workspace", "Databricks SQL editor", "Curated Gold tables for one domain", "AI/BI dashboards"],
    },
    {
      id: "fti-analyst-reader", name: "FTI Analyst Reader", persona: "FTI-cleared Analyst", color: "secondary",
      description: "Read access to Federal Tax Information (FTI) datasets. Requires active FTI authorization and adds enhanced audit logging. Smallest sufficient FTI grant.",
      sla: "5–8 business days", bearsRequired: true, approvalModel: "Manager → FTI officer → Security → BEARS",
      approvers: ["Tenant manager", "FTI authorizing official", "Security review", "BEARS workflow"],
      prerequisites: ["analytics-workspace"], requestable: true,
      components: [
        { type: "dbx_group", label: "Account group: fti-readers", scope: "fti-readers" },
        { type: "uc_grant", label: "SELECT on FTI-tagged datasets in scope", scope: "FTI tag = in-scope" },
        { type: "uc_grant", label: "Row/column policy: FTI masking applied", scope: "policy: fti_mask" },
        { type: "bears_role", label: "BEARS role: FTI-DATA-READ", scope: "FTI-DATA-READ" },
        { type: "sailpoint_group", label: "SailPoint group: FTI_Authorized_Users", scope: "FTI_Authorized_Users" },
      ],
      unlocks: ["FTI-classified curated datasets", "Enhanced audit-logged access", "FTI domain dashboards"],
    },
    {
      id: "domain-consumer", name: "Domain Consumer Access", persona: "Report Consumer", color: "accent-cool",
      description: "Lightweight, view-only access to a single domain's published dashboards, Genie Spaces, and apps — no SQL editor or notebooks.",
      sla: "1–3 business days", bearsRequired: false, approvalModel: "Manager → Domain steward",
      approvers: ["Tenant manager", "Domain data steward"],
      prerequisites: [], requestable: true,
      components: [
        { type: "dbx_entitlement", label: "Workspace access (consumer)", scope: "Consumer access only" },
        { type: "dbx_group", label: "Account group: {domain}-consumers", scope: "{domain}-consumers" },
        { type: "uc_grant", label: "SELECT on published reporting views", scope: "prod_*.{domain}_reporting.*" },
      ],
      unlocks: ["Domain AI/BI dashboards", "Domain Genie Spaces", "Published reporting views"],
    },
    {
      id: "analytics-workspace", name: "Analytics Workspace Access", persona: "All analytics users", color: "primary",
      description: "Baseline membership in the shared Analytics Prod workspace. A prerequisite for most analyst and FTI bundles.",
      sla: "1–2 business days", bearsRequired: true, approvalModel: "Manager → Platform",
      approvers: ["Tenant manager", "Platform operations"],
      prerequisites: [], requestable: true,
      components: [
        { type: "dbx_workspace", label: "Analytics Workspace membership", scope: "ws-analytics-prod" },
        { type: "dbx_entitlement", label: "Workspace access", scope: "Workspace access" },
        { type: "bears_role", label: "BEARS role: DBX-WS-ANALYTICS", scope: "DBX-WS-ANALYTICS" },
        { type: "sailpoint_group", label: "SailPoint group: DBX_WS_Analytics", scope: "DBX_WS_Analytics" },
      ],
      unlocks: ["Analytics Prod workspace shell", "Cluster + SQL warehouse attach"],
    },
    {
      id: "sandbox-writer", name: "Data Engineer Sandbox Writer", persona: "Data Engineer", color: "accent-warm",
      description: "Read/write access to a tenant sandbox catalog for prototyping pipelines and curated views. No production write access.",
      sla: "3–5 business days", bearsRequired: true, approvalModel: "Manager → Platform → BEARS",
      approvers: ["Tenant manager", "Platform operations", "BEARS workflow"],
      prerequisites: ["analytics-workspace"], requestable: true,
      components: [
        { type: "dbx_workspace", label: "Engineering Workspace membership", scope: "ws-engineering" },
        { type: "dbx_entitlement", label: "Workspace access + cluster create", scope: "Workspace, cluster create" },
        { type: "dbx_group", label: "Account group: sandbox-writers", scope: "sandbox-writers" },
        { type: "uc_grant", label: "ALL PRIVILEGES on sandbox catalog", scope: "sandbox_{tenant}.*" },
        { type: "bears_role", label: "BEARS role: DBX-ENG-SANDBOX", scope: "DBX-ENG-SANDBOX" },
        { type: "sailpoint_group", label: "SailPoint group: DBX_Eng_Sandbox", scope: "DBX_Eng_Sandbox" },
      ],
      unlocks: ["Tenant sandbox catalog (read/write)", "Engineering workspace", "Cluster creation"],
    },
    {
      id: "consumer-reporting", name: "Consumer Reporting Starter Pack", persona: "Executive / Viewer", color: "success",
      description: "The lightest possible footprint: dashboard and Genie viewing across your tenant's published surfaces. No data download.",
      sla: "1–2 business days", bearsRequired: false, approvalModel: "Manager",
      approvers: ["Tenant manager"],
      prerequisites: [], requestable: true,
      components: [
        { type: "dbx_entitlement", label: "Workspace access (view only)", scope: "View only" },
        { type: "dbx_group", label: "Account group: reporting-viewers", scope: "reporting-viewers" },
        { type: "uc_grant", label: "SELECT on tenant reporting views", scope: "tenant reporting.*" },
      ],
      unlocks: ["All published tenant dashboards", "Genie Space viewing"],
    },
  ];
  const bun = (id) => bundles.find((b) => b.id === id);

  // ---- Data assets ---------------------------------------------------------
  // assetType: table | view | dashboard | genie
  // requiredBundles: [{ bundle, requirement: "required"|"alternative"|"optional", note }]
  const datasets = [
    {
      id: "ptin-preparer-profiles", assetType: "table",
      name: "dim_preparer_profile", businessName: "PTIN Curated Preparer Profiles",
      domain: "preparer-practitioner", system: "ptin", classification: "PII", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Daily · 06:00 ET", popularity: 94,
      owner: "Return Preparer Office", steward: "Janet Osei",
      catalog: "prod_preparer", schema: "ptin_curated", object: "dim_preparer_profile", workspace: "Analytics Prod",
      tags: ["Preparer", "Curated", "Gold", "PII"],
      description: "One row per active paid preparer with current PTIN status, credentials, location, and oversight flags. The certified Gold dimension used across preparer-oversight reporting.",
      requiredBundles: [
        { bundle: "analyst-starter", requirement: "required", note: "Grants SELECT on the preparer Gold layer." },
        { bundle: "domain-consumer", requirement: "alternative", note: "View-only path if you only need dashboards." },
      ],
      unlocks: ["Preparer Oversight Dashboard", "Preparer Genie Space", "Join to CE records"],
      lineage: ["ptin.raw.registrations", "prod_preparer.ptin_silver.preparer_clean", "prod_preparer.ptin_curated.dim_preparer_profile"],
    },
    {
      id: "bmf-taxpayer-summary", assetType: "table",
      name: "fact_taxpayer_summary", businessName: "BMF Curated Taxpayer Summary",
      domain: "business-filing", system: "bmf", classification: "FTI", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Weekly · Mon 04:00 ET", popularity: 88,
      owner: "Business Returns Data Council", steward: "Priya Nadar",
      catalog: "prod_business", schema: "bmf_curated", object: "fact_taxpayer_summary", workspace: "Analytics Prod",
      tags: ["BMF", "FTI", "Gold", "Entity"],
      description: "Curated per-entity summary of business filing activity, balances, and entity attributes. Contains Federal Tax Information — FTI authorization required.",
      requiredBundles: [
        { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI authorization to read FTI-tagged data." },
      ],
      unlocks: ["Business Filing dashboards", "Entity population analysis", "Join to entity registry"],
      lineage: ["bmf.raw.returns", "prod_business.bmf_silver.returns_clean", "prod_business.bmf_curated.fact_taxpayer_summary"],
    },
    {
      id: "mef-filing-status-daily", assetType: "view",
      name: "vw_filing_status_daily", businessName: "MeF Filing Status Daily View",
      domain: "modernized-efile", system: "mef", classification: "FTI", certification: "Certified",
      usageType: "Operational (read)", freshness: "Hourly", popularity: 91,
      owner: "Submission Processing Council", steward: "Erin Coyle",
      catalog: "prod_submission", schema: "mef_reporting", object: "vw_filing_status_daily", workspace: "Analytics Prod",
      tags: ["MeF", "FTI", "Daily", "Operational"],
      description: "Daily snapshot of submission counts by status (accepted, rejected, pending) across return types. Drives filing-season operational monitoring.",
      requiredBundles: [
        { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI-tagged operational view." },
      ],
      unlocks: ["Filing Season Operations Dashboard", "Submission throughput Genie Space"],
      lineage: ["mef.raw.submissions", "prod_submission.mef_silver.submissions_clean", "prod_submission.mef_reporting.vw_filing_status_daily"],
    },
    {
      id: "enforcement-case-signals", assetType: "table",
      name: "gold_case_signals", businessName: "Enforcement Case Signals Gold View",
      domain: "enforcement-collections", system: "irworks", classification: "FTI", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Daily · 05:00 ET", popularity: 79,
      owner: "Collection Strategy Council", steward: "Carlos Reyes",
      catalog: "prod_enforcement", schema: "cases_curated", object: "gold_case_signals", workspace: "Enforcement Analytics",
      tags: ["Enforcement", "FTI", "Gold", "Restricted"],
      description: "Curated case-level signals supporting collection treatment-stream analytics. Restricted FTI dataset in a dedicated enforcement workspace.",
      requiredBundles: [
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI authorization required." },
        { bundle: "analytics-workspace", requirement: "required", note: "Plus Enforcement Analytics workspace add-on." },
      ],
      unlocks: ["Enforcement Case Signals Dashboard", "Treatment-stream Genie Space"],
      lineage: ["irworks.raw.cases", "prod_enforcement.cases_silver.cases_clean", "prod_enforcement.cases_curated.gold_case_signals"],
    },
    {
      id: "imf-account-balances", assetType: "table",
      name: "fact_account_balance", businessName: "IMF Account Balance Snapshot",
      domain: "individual-filing", system: "imf", classification: "FTI", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Daily · 03:00 ET", popularity: 85,
      owner: "Individual Returns Data Council", steward: "Marcus Liu",
      catalog: "prod_individual", schema: "imf_curated", object: "fact_account_balance", workspace: "Analytics Prod",
      tags: ["IMF", "FTI", "Gold"],
      description: "Daily individual-account balance snapshot derived from IMF. Core fact table for individual account research and refund analytics.",
      requiredBundles: [
        { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI-tagged account data." },
      ],
      unlocks: ["Individual Account Research dashboards", "Refund analytics"],
      lineage: ["imf.raw.accounts", "prod_individual.imf_silver.accounts_clean", "prod_individual.imf_curated.fact_account_balance"],
    },
    {
      id: "irp-1099-summary", assetType: "table",
      name: "fact_1099_summary", businessName: "Information Return 1099 Summary",
      domain: "information-returns", system: "irp", classification: "FTI", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Monthly", popularity: 72,
      owner: "Information Reporting Council", steward: "Lena Brooks",
      catalog: "prod_irp", schema: "irp_curated", object: "fact_1099_summary", workspace: "Analytics Prod",
      tags: ["IRP", "1099", "FTI", "Gold"],
      description: "Aggregated 1099 information-return totals by payer and recipient population, used in underreporter and matching analysis.",
      requiredBundles: [
        { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI-tagged information returns." },
      ],
      unlocks: ["Underreporter analysis", "Document matching Genie Space"],
      lineage: ["irp.raw.documents", "prod_irp.irp_silver.docs_clean", "prod_irp.irp_curated.fact_1099_summary"],
    },
    {
      id: "ptin-continuing-ed", assetType: "table",
      name: "dim_continuing_education", businessName: "Preparer Continuing Education Records",
      domain: "preparer-practitioner", system: "hptin", classification: "Internal", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Weekly", popularity: 54,
      owner: "Return Preparer Office", steward: "Janet Osei",
      catalog: "prod_preparer", schema: "ptin_curated", object: "dim_continuing_education", workspace: "Analytics Prod",
      tags: ["Preparer", "Internal", "CE"],
      description: "Continuing-education completion records by preparer and cycle. Internal classification — no FTI authorization required.",
      requiredBundles: [
        { bundle: "analyst-starter", requirement: "required", note: "Grants SELECT on preparer Gold layer." },
        { bundle: "domain-consumer", requirement: "alternative", note: "Dashboard-only path." },
      ],
      unlocks: ["CE compliance tracking", "Join to preparer profiles"],
      lineage: ["hptin.raw.ce", "prod_preparer.ptin_silver.ce_clean", "prod_preparer.ptin_curated.dim_continuing_education"],
    },
    {
      id: "exam-case-outcomes", assetType: "table",
      name: "fact_exam_outcomes", businessName: "Exam Case Outcomes (AIMS)",
      domain: "compliance-exam", system: "aims", classification: "FTI", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Weekly", popularity: 68,
      owner: "Examination Data Council", steward: "Helen Park",
      catalog: "prod_exam", schema: "aims_curated", object: "fact_exam_outcomes", workspace: "Analytics Prod",
      tags: ["Exam", "FTI", "Gold", "AIMS"],
      description: "Closed examination outcomes with adjustment amounts and disposition codes, used for coverage and outcome analytics.",
      requiredBundles: [
        { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI-tagged exam data." },
      ],
      unlocks: ["Exam Outcome Analysis dashboards", "Coverage reporting"],
      lineage: ["aims.raw.exams", "prod_exam.aims_silver.exams_clean", "prod_exam.aims_curated.fact_exam_outcomes"],
    },
    {
      id: "identity-verification-events", assetType: "table",
      name: "fact_identity_events", businessName: "Taxpayer Identity Verification Events",
      domain: "taxpayer-identity", system: "idrs", classification: "PII", certification: "Review pending",
      usageType: "Analytical (read)", freshness: "Daily", popularity: 61,
      owner: "Identity Assurance Council", steward: "Sam Whitfield",
      catalog: "prod_identity", schema: "idn_curated", object: "fact_identity_events", workspace: "Analytics Prod",
      tags: ["Identity", "PII", "Authentication"],
      description: "Identity verification and authentication events used for assurance analytics and fraud-signal research. Certification review in progress.",
      requiredBundles: [
        { bundle: "analyst-starter", requirement: "required", note: "Grants SELECT on identity Gold layer." },
      ],
      unlocks: ["Identity Assurance dashboards", "Fraud signal research"],
      lineage: ["idrs.raw.auth_events", "prod_identity.idn_silver.events_clean", "prod_identity.idn_curated.fact_identity_events"],
    },
    {
      id: "bmf-entity-registry", assetType: "table",
      name: "dim_business_entity", businessName: "BMF Entity Registry",
      domain: "business-filing", system: "bmf", classification: "Internal", certification: "Certified",
      usageType: "Reference (read)", freshness: "Daily", popularity: 70,
      owner: "Business Returns Data Council", steward: "Priya Nadar",
      catalog: "prod_business", schema: "bmf_curated", object: "dim_business_entity", workspace: "Analytics Prod",
      tags: ["BMF", "Internal", "Reference"],
      description: "Reference dimension of business entities with EIN, name, NAICS, and entity type. Internal classification — broadly available for joins.",
      requiredBundles: [
        { bundle: "analyst-starter", requirement: "required", note: "Grants SELECT on business Gold layer." },
        { bundle: "domain-consumer", requirement: "alternative", note: "Dashboard-only path." },
      ],
      unlocks: ["Entity joins across business datasets", "Population framing"],
      lineage: ["bmf.raw.entities", "prod_business.bmf_silver.entities_clean", "prod_business.bmf_curated.dim_business_entity"],
    },
    {
      id: "collections-balance-due", assetType: "view",
      name: "vw_balance_due_inventory", businessName: "Collections Balance Due Inventory",
      domain: "enforcement-collections", system: "idrs", classification: "FTI", certification: "Certified",
      usageType: "Operational (read)", freshness: "Daily", popularity: 64,
      owner: "Collection Strategy Council", steward: "Carlos Reyes",
      catalog: "prod_enforcement", schema: "collections_reporting", object: "vw_balance_due_inventory", workspace: "Enforcement Analytics",
      tags: ["Collections", "FTI", "Operational"],
      description: "Open balance-due inventory by treatment stream and aging bucket. Restricted FTI operational view.",
      requiredBundles: [
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI authorization required." },
        { bundle: "analytics-workspace", requirement: "required", note: "Plus Enforcement Analytics workspace add-on." },
      ],
      unlocks: ["Collections operations dashboards", "Inventory aging reports"],
      lineage: ["idrs.raw.balances", "prod_enforcement.collections_silver.balances_clean", "prod_enforcement.collections_reporting.vw_balance_due_inventory"],
    },
    {
      id: "mef-rejects-analysis", assetType: "table",
      name: "fact_submission_rejects", businessName: "MeF Submission Rejects Analysis",
      domain: "modernized-efile", system: "mef", classification: "Internal", certification: "Certified",
      usageType: "Analytical (read)", freshness: "Daily", popularity: 58,
      owner: "Submission Processing Council", steward: "Erin Coyle",
      catalog: "prod_submission", schema: "mef_curated", object: "fact_submission_rejects", workspace: "Analytics Prod",
      tags: ["MeF", "Internal", "Quality"],
      description: "Submission reject reasons and counts by business rule, used for root-cause and quality analysis. Internal classification.",
      requiredBundles: [
        { bundle: "analyst-starter", requirement: "required", note: "Grants SELECT on submission Gold layer." },
      ],
      unlocks: ["Reject root-cause analysis", "Business-rule quality reports"],
      lineage: ["mef.raw.rejects", "prod_submission.mef_silver.rejects_clean", "prod_submission.mef_curated.fact_submission_rejects"],
    },
    {
      id: "preparer-oversight-dashboard", assetType: "dashboard",
      name: "Preparer Oversight Dashboard", businessName: "Preparer Oversight Dashboard",
      domain: "preparer-practitioner", system: "ptin", classification: "PII", certification: "Certified",
      usageType: "Consume (view)", freshness: "Daily", popularity: 82,
      owner: "Return Preparer Office", steward: "Janet Osei",
      catalog: "prod_preparer", schema: "—", object: "AI/BI Dashboard", workspace: "Analytics Prod",
      tags: ["Dashboard", "AI/BI", "Preparer"],
      description: "Published AI/BI dashboard summarizing preparer population, credential status, and oversight signals. View-only consumers can access via the consumer bundle.",
      requiredBundles: [
        { bundle: "domain-consumer", requirement: "required", note: "Consumer view access — fastest path." },
        { bundle: "analyst-starter", requirement: "alternative", note: "Full analyst access also unlocks it." },
      ],
      unlocks: ["Interactive oversight views", "Export to PDF"],
      lineage: ["dim_preparer_profile", "dim_continuing_education", "Preparer Oversight Dashboard"],
    },
    {
      id: "enforcement-genie", assetType: "genie",
      name: "Enforcement Genie Space", businessName: "Enforcement Treatment-Stream Genie Space",
      domain: "enforcement-collections", system: "irworks", classification: "FTI", certification: "Certified",
      usageType: "Consume (ask)", freshness: "Daily", popularity: 49,
      owner: "Collection Strategy Council", steward: "Carlos Reyes",
      catalog: "prod_enforcement", schema: "—", object: "Genie Space", workspace: "Enforcement Analytics",
      tags: ["Genie", "AI", "Enforcement", "FTI"],
      description: "Natural-language Genie Space over curated enforcement case signals. Ask questions about treatment streams in plain English. Restricted FTI surface.",
      requiredBundles: [
        { bundle: "fti-analyst-reader", requirement: "required", note: "FTI authorization required." },
      ],
      unlocks: ["Ask questions in natural language", "Generated SQL + charts"],
      lineage: ["gold_case_signals", "Enforcement Genie Space"],
    },
  ];
  const ds = (id) => datasets.find((d) => d.id === id);

  // ---- Seed requests (request + status history) ---------------------------
  // step states: done | active | blocked | pending
  const STAGES = ["Access request submitted", "Domain owner review", "EDP access review", "BEARS entitlements created", "Databricks provisioning", "Access active"];
  const requests = [
    {
      id: "REQ-2041", title: "Enforcement Case Signals — FTI read access",
      submittedAt: "May 28, 2026", status: "In progress", overall: "In EDP access review",
      purpose: "Treatment-stream analytics for the Q3 collections prioritization study.",
      items: [
        { ref: "asset", id: "enforcement-case-signals", kind: "Dataset" },
        { bundle: "fti-analyst-reader", kind: "Bundle" },
        { bundle: "analytics-workspace", kind: "Bundle" },
      ],
      subRequests: [
        { system: "Access request submitted", status: "done", detail: "Cart resolved to bundles + entitlements · May 28" },
        { system: "Domain owner review", status: "done", detail: "Need-to-know confirmed by M. Liu (domain steward) · May 29" },
        { system: "EDP access review", status: "active", detail: "FTI safeguards + bundle-to-entitlement mapping under review", ticket: "EDPA-2041" },
        { system: "BEARS entitlements created", status: "pending", detail: "Automated once EDP review approves — no manual step" },
        { system: "Databricks provisioning: users, Unity Catalog & compute", status: "pending", detail: "Users, Unity Catalog grants and compute provisioned automatically" },
        { system: "Access active, registered & notified", status: "pending", detail: "Requester notified; entitlement tracked for recertification" },
      ],
      stageIndex: 2,
    },
    {
      id: "REQ-2038", title: "Analyst Starter Pack — Individual Filing",
      submittedAt: "May 12, 2026", status: "Completed", overall: "Access active",
      purpose: "Refund trend analysis for filing-season operations.",
      items: [
        { bundle: "analyst-starter", kind: "Bundle" },
        { ref: "asset", id: "imf-account-balances", kind: "Dataset" },
      ],
      subRequests: [
        { system: "Access request submitted", status: "done", detail: "Bundles resolved · May 12" },
        { system: "Domain owner review", status: "done", detail: "Approved by M. Liu (domain steward) · May 13" },
        { system: "EDP access review", status: "done", detail: "Non-SBU bundle mapping confirmed · May 14", ticket: "EDPA-2038" },
        { system: "BEARS entitlements created", status: "done", detail: "DBX-ANALYST-BASE created automatically", ticket: "BEARS-551877" },
        { system: "Databricks provisioning: users, Unity Catalog & compute", status: "done", detail: "Users, UC grants and warehouse applied · May 15" },
        { system: "Access active, registered & notified", status: "done", detail: "Notified · May 15; recertification due Nov 15" },
      ],
      stageIndex: 5,
    },
    {
      id: "REQ-2052", title: "Sandbox Writer — RAAS tenant",
      submittedAt: "Jun 2, 2026", status: "Action needed", overall: "Provisioning failed",
      purpose: "Prototype curated pipeline for the preparer oversight refresh.",
      items: [
        { bundle: "sandbox-writer", kind: "Bundle" },
      ],
      subRequests: [
        { system: "Access request submitted", status: "done", detail: "Bundles resolved · Jun 2" },
        { system: "Domain owner review", status: "done", detail: "Approved by domain steward · Jun 3" },
        { system: "EDP access review", status: "done", detail: "Approved by EDP access team · Jun 3", ticket: "EDPA-2052" },
        { system: "BEARS entitlements created", status: "done", detail: "DBX-ENG-SANDBOX created", ticket: "BEARS-560912" },
        { system: "Databricks provisioning: users, Unity Catalog & compute", status: "blocked", detail: "UC grant failed: sandbox catalog not found for tenant", error: "UC_CATALOG_NOT_FOUND" },
        { system: "Access active, registered & notified", status: "pending", detail: "Blocked until provisioning is retried" },
      ],
      stageIndex: 4,
    },
  ];

  // ---- My current access ---------------------------------------------------
  const myAccess = {
    workspaces: [
      { name: "Analytics Prod", entitlement: "Workspace access + Databricks SQL", since: "May 15, 2026" },
    ],
    bundles: [
      { bundle: "analytics-workspace", since: "May 15, 2026", status: "active" },
      { bundle: "analyst-starter", since: "May 15, 2026", status: "active" },
      { bundle: "domain-consumer", since: "Apr 30, 2026", status: "expiring", expires: "Jun 30, 2026", domain: "individual-filing" },
    ],
    domains: ["individual-filing"],
    recentAssets: ["imf-account-balances", "individual-refund-status", "mef-filing-status-daily"],
  };

  // individual-refund-status referenced above — add it
  datasets.push({
    id: "individual-refund-status", assetType: "view",
    name: "vw_refund_status_daily", businessName: "Individual Refund Status Daily",
    domain: "individual-filing", system: "cade2", classification: "FTI", certification: "Certified",
    usageType: "Operational (read)", freshness: "Daily", popularity: 76,
    owner: "Individual Returns Data Council", steward: "Marcus Liu",
    catalog: "prod_individual", schema: "cade_reporting", object: "vw_refund_status_daily", workspace: "Analytics Prod",
    tags: ["IMF", "FTI", "Refund", "Operational"],
    description: "Daily refund processing status counts by stage. Operational view for filing-season refund monitoring.",
    requiredBundles: [
      { bundle: "analytics-workspace", requirement: "required", note: "Workspace membership prerequisite." },
      { bundle: "fti-analyst-reader", requirement: "required", note: "FTI-tagged refund data." },
    ],
    unlocks: ["Refund monitoring dashboards", "Filing-season operations"],
    lineage: ["cade2.raw.refunds", "prod_individual.cade_silver.refunds_clean", "prod_individual.cade_reporting.vw_refund_status_daily"],
  });

  // ---- Onboarding starter recommendations by persona ----------------------
  const onboardingPersonas = [
    { id: "analyst", label: "Data Analyst", desc: "Builds analysis in SQL & notebooks", bundles: ["analytics-workspace", "analyst-starter"] },
    { id: "fti-analyst", label: "FTI-cleared Analyst", desc: "Works with Federal Tax Information", bundles: ["analytics-workspace", "analyst-starter", "fti-analyst-reader"] },
    { id: "consumer", label: "Report Consumer", desc: "Views dashboards & Genie Spaces", bundles: ["domain-consumer"] },
    { id: "engineer", label: "Data Engineer", desc: "Builds pipelines in a sandbox", bundles: ["analytics-workspace", "sandbox-writer"] },
    { id: "executive", label: "Executive / Viewer", desc: "Light reporting access only", bundles: ["consumer-reporting"] },
  ];

  // ---- Admin: enterprise onboarding pipeline (all tenants) ----------------
  // kind: access (existing data) | onboard (new data into EDP)
  // state: intake | review | ccb | provisioning | live | blocked | returned
  const pipeline = [
    {
      id: "ONB-118", kind: "onboard", title: "PTIN preparer compliance feed", tenant: "RPO — Return Preparer Office",
      requester: "Alicia Grant", submittedAt: "Jun 1, 2026", state: "ccb", stage: "Intake CCB",
      nextAction: "CCB vote scheduled Jun 12", owner: "EDP Change Control Board", ageDays: 11,
      jira: "EDP-4412", jiraStatus: "In CCB Review", monthlyCost: 4820, roi: 3.1, sensitivity: "SBU (FTI)",
      pattern: "Informatica", delivery: "Platform-team pipeline development",
      decisions: [
        { at: "Jun 1", actor: "Alicia Grant (tenant)", decision: "Submitted", note: "Business case + AI-assisted sizing attached.", jira: "EDP-4412" },
        { at: "Jun 4", actor: "EDP business office", decision: "Approved", note: "ROI 3.1x, payback 11 months. Funding confirmed by RPO.", jira: "EDP-4413" },
        { at: "Jun 9", actor: "Platform security", decision: "Conditional", note: "FTI masking policy required on preparer SSN column.", jira: "EDP-4419" },
      ],
    },
    {
      id: "ONB-121", kind: "onboard", title: "Exam workpaper archive (AIMS extract)", tenant: "SB/SE — Examination",
      requester: "Trent Okafor", submittedAt: "Jun 6, 2026", state: "review", stage: "EDP business & ROI review",
      nextAction: "Business office review of benefit estimate", owner: "EDP business office", ageDays: 6,
      jira: "EDP-4437", jiraStatus: "In Review", monthlyCost: 9140, roi: 1.4, sensitivity: "SBU",
      pattern: "EPZ bucket landing zone", delivery: "Self-build with EDP patterns",
      decisions: [
        { at: "Jun 6", actor: "Trent Okafor (tenant)", decision: "Submitted", note: "Sizing: 14 TB, daily load, moderate transformation, 60 users.", jira: "EDP-4437" },
        { at: "Jun 8", actor: "EDP architecture", decision: "Approved", note: "EPZ landing zone is an approved pattern — no consultation needed.", jira: "EDP-4440" },
      ],
    },
    {
      id: "ONB-109", kind: "onboard", title: "IRWorks case notes (NLP corpus)", tenant: "RAAS — Research, Applied Analytics & Statistics",
      requester: "Dana Whitfield", submittedAt: "May 18, 2026", state: "provisioning", stage: "Databricks provisioning",
      nextAction: "Automated — UC schemas and compute deploying", owner: "Infrastructure as code", ageDays: 25,
      jira: "EDP-4290", jiraStatus: "Provisioning", monthlyCost: 6350, roi: 2.6, sensitivity: "SBU (FTI)",
      pattern: "EFTU", delivery: "Guided platform help",
      decisions: [
        { at: "May 18", actor: "Dana Whitfield (tenant)", decision: "Submitted", note: "Case-note corpus for treatment-stream research.", jira: "EDP-4290" },
        { at: "May 22", actor: "EDP business office", decision: "Approved", note: "ROI 2.6x. Costs charged to RAAS FY26 analytics line.", jira: "EDP-4295" },
        { at: "Jun 2", actor: "Intake CCB", decision: "Approved", note: "Security and capacity cleared; FTI safeguards review passed.", jira: "EDP-4301" },
        { at: "Jun 3", actor: "BEARS automation", decision: "Entitlements created", note: "Owner, engineer and consumer bundles generated.", jira: "BEARS-561440" },
      ],
    },
    {
      id: "ONB-124", kind: "onboard", title: "Third-party payment processor feed", tenant: "LB&I — Large Business & International",
      requester: "Mei Lundqvist", submittedAt: "Jun 9, 2026", state: "blocked", stage: "Architecture consultation",
      nextAction: "Consultation booked — pattern outside approved list", owner: "Platform architects", ageDays: 3,
      jira: "EDP-4451", jiraStatus: "Blocked", monthlyCost: 11200, roi: 0.9, sensitivity: "SBU",
      pattern: "Custom API pull (consultation required)", delivery: "Platform-team pipeline development",
      decisions: [
        { at: "Jun 9", actor: "Mei Lundqvist (tenant)", decision: "Submitted", note: "Vendor REST API, hourly pull.", jira: "EDP-4451" },
        { at: "Jun 10", actor: "EDP architecture", decision: "Returned", note: "Not an approved pattern. Consultation required before CCB intake.", jira: "EDP-4455" },
      ],
    },
    {
      id: "REQ-2041", kind: "access", title: "Enforcement Case Signals — FTI read access", tenant: "RAAS — Research, Applied Analytics & Statistics",
      requester: "Dana Whitfield", submittedAt: "May 28, 2026", state: "review", stage: "BEARS approval",
      nextAction: "BEARS approver action on FTI-DATA-READ", owner: "BEARS approver", ageDays: 15,
      jira: "EDPA-2041", jiraStatus: "Awaiting Approval", monthlyCost: 0, roi: null, sensitivity: "SBU (FTI)",
      pattern: "—", delivery: "—",
      decisions: [
        { at: "May 28", actor: "Tenant manager (C. Reyes)", decision: "Approved", note: "Need-to-know confirmed for Q3 collections study.", jira: "EDPA-2041" },
        { at: "May 29", actor: "FTI authorizing official", decision: "Approved", note: "FTI authorization on file.", jira: "EDPA-2043" },
      ],
    },
    {
      id: "REQ-2052", kind: "access", title: "Sandbox Writer — RAAS tenant", tenant: "RAAS — Research, Applied Analytics & Statistics",
      requester: "Dana Whitfield", submittedAt: "Jun 2, 2026", state: "blocked", stage: "Databricks provisioning",
      nextAction: "UC grant failed — sandbox catalog missing", owner: "Platform operations", ageDays: 10,
      jira: "EDPA-2052", jiraStatus: "Incident", monthlyCost: 0, roi: null, sensitivity: "SBU",
      pattern: "—", delivery: "—",
      decisions: [
        { at: "Jun 2", actor: "Tenant manager", decision: "Approved", note: "Prototype pipeline for preparer oversight refresh.", jira: "EDPA-2052" },
        { at: "Jun 4", actor: "Provisioning automation", decision: "Failed", note: "UC_CATALOG_NOT_FOUND — sandbox catalog not provisioned for tenant.", jira: "EDPA-2058" },
      ],
    },
    {
      id: "REQ-2038", kind: "access", title: "Analyst Starter Pack — Individual Filing", tenant: "W&I — Wage & Investment",
      requester: "Priya Raman", submittedAt: "May 12, 2026", state: "live", stage: "Access active",
      nextAction: "None — recertification due Nov 15, 2026", owner: "Automation", ageDays: 31,
      jira: "EDPA-2038", jiraStatus: "Done", monthlyCost: 0, roi: null, sensitivity: "SBU",
      pattern: "—", delivery: "—",
      decisions: [
        { at: "May 13", actor: "Domain steward (M. Liu)", decision: "Approved", note: "Purpose of use accepted.", jira: "EDPA-2038" },
        { at: "May 15", actor: "Provisioning automation", decision: "Provisioned", note: "Groups and UC grants applied; access active.", jira: "EDPA-2039" },
      ],
    },
  ];

  // ---- Admin: tenant usage vs. budget -------------------------------------
  const tenants = [
    { id: "raas", name: "RAAS — Research, Applied Analytics & Statistics", lead: "Dana Whitfield",
      fyBudget: 1450000, fytdSpend: 968000, mtdSpend: 121500, forecastFy: 1512000,
      dbusMonth: 24800, storageTb: 186, users: 142, datasets: 9, openItems: 3 },
    { id: "rpo", name: "RPO — Return Preparer Office", lead: "Alicia Grant",
      fyBudget: 420000, fytdSpend: 197000, mtdSpend: 26400, forecastFy: 356000,
      dbusMonth: 5900, storageTb: 41, users: 38, datasets: 3, openItems: 1 },
    { id: "sbse", name: "SB/SE — Examination", lead: "Trent Okafor",
      fyBudget: 890000, fytdSpend: 612000, mtdSpend: 88200, forecastFy: 921000,
      dbusMonth: 17300, storageTb: 132, users: 96, datasets: 6, openItems: 1 },
    { id: "lbi", name: "LB&I — Large Business & International", lead: "Mei Lundqvist",
      fyBudget: 760000, fytdSpend: 300500, mtdSpend: 41800, forecastFy: 588000,
      dbusMonth: 9100, storageTb: 74, users: 61, datasets: 4, openItems: 1 },
    { id: "wi", name: "W&I — Wage & Investment", lead: "Priya Raman",
      fyBudget: 1100000, fytdSpend: 502000, mtdSpend: 63900, forecastFy: 894000,
      dbusMonth: 13400, storageTb: 98, users: 210, datasets: 5, openItems: 0 },
  ];

  window.AppData = {
    user, systems, domains, bundles, datasets, requests, myAccess, onboardingPersonas, STAGES,
    pipeline, tenants,
    sys, dom, bun, ds,
  };
})();
