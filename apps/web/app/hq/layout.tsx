import "./hq.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "DeloHQ",
  description: "Live org chart of the Hermes agent fleet"
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#0b1020"
};

export default function HqLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
