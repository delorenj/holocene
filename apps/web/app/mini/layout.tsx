import "../hq/hq.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Holocene Mini",
  description: "Holocene Mini in a browser: the live org chart of the Hermes agent fleet, behind Google sign-in"
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#0b1020"
};

export default function MiniLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
