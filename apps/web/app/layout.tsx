import "./globals.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "Holocene",
  description: "33GOD dashboard and renderer"
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
