import "../../../../hub/hub.css";
import "../../../projects.css";
import { ReviewView } from "../../../review-view";

export const metadata = { title: "Holocene · Review", description: "Annotate a preserved walkthrough revision" };
export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ projectId: string; revision: string }> }) {
  const { projectId, revision } = await params;
  return <ReviewView projectId={projectId} revision={revision} />;
}
