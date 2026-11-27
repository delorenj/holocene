import "../../hub/hub.css";
import "../projects.css";
import { ProjectHome } from "../project-home";

export const metadata = { title: "Holocene · Project", description: "Project home: walkthroughs and their reviews" };
export const dynamic = "force-dynamic";

// HOLOC-70: https://holocene.delo.sh/projects/{encodeURIComponent(canonical project_id)}. Identity is
// resolved by the API against the PJangler registry; the segment is passed through as received.
export default async function Page({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectHome projectId={projectId} />;
}
