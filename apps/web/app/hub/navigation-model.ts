export type NavItem = { id: string; label: string; href: string };
export const PRODUCT_LINKS: NavItem[] = [
  { id: "products", label: "Products", href: "/products" },
  { id: "products-launch", label: "Preparing to launch", href: "/products?stage=launch" },
  { id: "products-live", label: "Live", href: "/products?stage=live" }
];
export const NAV_GROUPS = [
  { id: "workspace", label: "Workspace", items: [
    { id: "agents", label: "Agents", href: "/?view=agents" },
    { id: "projects", label: "Projects", href: "/?view=projects" },
    { id: "live", label: "Live management", href: "/live" },
    { id: "genesis", label: "Genesis", href: "/genesis" }
  ] },
  { id: "media", label: "Media", items: [
    { id: "voice", label: "Voice", href: "/voice" },
    { id: "wax", label: "Wax", href: "/wax" },
    { id: "transcripts", label: "Transcripts", href: "/transcripts" },
    { id: "artifacts", label: "Artifacts", href: "/artifacts" }
  ] },
  { id: "system", label: "System", items: [
    { id: "candybar", label: "Candybar", href: "/candybar" },
    { id: "settings", label: "Settings", href: "/settings" },
    { id: "mini", label: "Mini", href: "/mini" },
    { id: "hooks", label: "Hooks", href: "/hooks" },
    { id: "legacy", label: "Legacy dashboard", href: "/legacy" }
  ] }
];
export function currentGroup(current?: string) { return NAV_GROUPS.find((g) => g.items.some((i) => i.id === current))?.id; }
export function nativeModifiedClick(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; button: number }) {
  return e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0;
}
export function productStage(search: string): "launch" | "live" | undefined {
  const value = new URLSearchParams(search).get("stage");
  return value === "launch" || value === "live" ? value : undefined;
}
