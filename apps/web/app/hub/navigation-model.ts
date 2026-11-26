import type { IconName } from "./nav-icons";
export type NavItem = { id: string; label: string; href: string; icon: IconName };
export const PRODUCT_LINKS: NavItem[] = [
  { id: "products", label: "Products", href: "/products", icon: "products" }
];
export const PROJECT_LINKS: NavItem[] = [
  { id: "products-live", label: "Live products", href: "/products?stage=live", icon: "live" },
  { id: "products-launch", label: "Launch mode products", href: "/products?stage=launch", icon: "launch" },
  { id: "projects", label: "All projects", href: "/?view=projects", icon: "projects" }
];
export const NAV_GROUPS: Array<{ id: string; label: string; items: NavItem[] }> = [
  { id: "workspace", label: "Workspace", items: [
    { id: "agents", label: "Agents", href: "/?view=agents", icon: "agents" },
    { id: "live", label: "Live management", href: "/live", icon: "storefront" },
    { id: "genesis", label: "Genesis", href: "/genesis", icon: "genesis" }
  ] },
  { id: "media", label: "Media", items: [
    { id: "voice", label: "Voice", href: "/voice", icon: "voice" },
    { id: "wax", label: "Wax", href: "/wax", icon: "wax" },
    { id: "transcripts", label: "Transcripts", href: "/transcripts", icon: "transcripts" },
    { id: "artifacts", label: "Artifacts", href: "/artifacts", icon: "artifacts" }
  ] },
  { id: "system", label: "System", items: [
    { id: "candybar", label: "Candybar", href: "/candybar", icon: "candybar" },
    { id: "settings", label: "Settings", href: "/settings", icon: "settings" },
    { id: "mini", label: "Mini", href: "/mini", icon: "mini" },
    { id: "hooks", label: "Hooks", href: "/hooks", icon: "hooks" },
    { id: "legacy", label: "Legacy dashboard", href: "/legacy", icon: "legacy" }
  ] }
];
export function currentGroup(current?: string) { return NAV_GROUPS.find((g) => g.items.some((i) => i.id === current))?.id; }
export function projectsAncestor(current?: string) { return PROJECT_LINKS.some((item) => item.id === current); }
export function nativeModifiedClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}
export function productStage(search: string): "launch" | "live" | undefined {
  const value = new URLSearchParams(search).get("stage");
  return value === "launch" || value === "live" ? value : undefined;
}
