import { createFileRoute } from "@tanstack/react-router";
import { ClientOnly } from "@tanstack/react-router";
import BrokerApp from "@/components/BrokerApp";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "IRS Data Access Broker — Request Data Access" },
      {
        name: "description",
        content:
          "Browse IRS data domains, datasets and access bundles, then request and track data access in one governed workflow.",
      },
      { property: "og:title", content: "IRS Data Access Broker" },
      {
        property: "og:description",
        content:
          "Discover governed IRS datasets, assemble an access request, and track approvals end to end.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <ClientOnly fallback={null}>
      <BrokerApp />
    </ClientOnly>
  );
}
