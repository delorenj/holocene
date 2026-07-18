import "../lifecycle.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Lifecycle · Holocene",
  description: "Authoritative Lifecycle projection and command surface"
};

export default function LifecycleLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
