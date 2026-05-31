import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Holocene",
  description: "33GOD control-plane dashboard"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
