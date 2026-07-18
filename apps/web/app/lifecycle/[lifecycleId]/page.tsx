import { LifecycleSurface } from "../lifecycle-surface";

type PageProps = {
  params: Promise<{ lifecycleId: string }>;
};

export default async function LifecyclePage({ params }: PageProps) {
  const { lifecycleId } = await params;
  return <LifecycleSurface lifecycleId={lifecycleId} />;
}
