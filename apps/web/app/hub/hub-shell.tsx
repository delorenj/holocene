"use client";

import type { ReactNode } from "react";
import { HubNavigation, type NavigationProps } from "./hub-navigation";

/** Shared header and hierarchy; specialist surfaces retain their own content and operational behavior. */
export function HubShell({ children, ...navigation }: NavigationProps & { children: ReactNode }) {
  return <header className="hub-header hub-shell">
    <a className="hub-skip" href="#hub-content">Skip to content</a>
    <HubNavigation {...navigation} />
    {children}
  </header>;
}
