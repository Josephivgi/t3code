import { createFileRoute } from "@tanstack/react-router";
import { SmallToolPage } from "../components/settings/SmallToolsSettingsPanel";

function SmallToolRoute() {
  const { tool } = Route.useParams();
  return <SmallToolPage toolKey={tool} />;
}

export const Route = createFileRoute("/_chat/settings/small-tools/$tool")({
  component: SmallToolRoute,
});
