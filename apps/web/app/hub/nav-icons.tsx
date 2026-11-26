/** Line icons for the shared hub navigation and panels. Decorative only: every caller keeps a text label. */
const PATHS = {
  products: "M3 7.5 12 3l9 4.5v9L12 21l-9-4.5zM3 7.5l9 4.5 9-4.5M12 12v9",
  launch: "M5 19c0-3 1-5 3-6m3 6c3 0 5-1 6-3M9.5 14.5l-3-3c2-6 7-9 13-9 0 6-3 11-9 13zM15 9.5a1.5 1.5 0 1 0 0-.01",
  live: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12l2.5 2.5 4.5-5",
  agents: "M9 3h6M12 3v3M5 8h14v10H5zM9.5 12.5v1M14.5 12.5v1M3 12v3M21 12v3",
  projects: "M3 6h6l2 2h10v11H3z",
  storefront: "M4 9 5.5 4h13L20 9M4 9h16v1.5a2.7 2.7 0 0 1-5.3 0 2.7 2.7 0 0 1-5.4 0 2.7 2.7 0 0 1-5.3 0zM5 12v8h14v-8M10 20v-5h4v5",
  genesis: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z",
  voice: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21",
  wax: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM12 6.5a5.5 5.5 0 0 0-5.5 5.5",
  transcripts: "M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 15.5h6M9 9h2",
  artifacts: "M12 3 3 7.5l9 4.5 9-4.5zM3 12l9 4.5 9-4.5M3 16.5 12 21l9-4.5",
  candybar: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  settings: "M4 6h8M16 6h4M4 12h2M10 12h10M4 18h10M18 18h2M14 4v4M8 10v4M16 16v4",
  mini: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  hooks: "M9 8a3 3 0 1 1 4.5 2.6L11 15M7.5 13.5a3 3 0 1 0 3 4.5h6M17 15a3 3 0 1 0-1.5 5.6",
  legacy: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  diagnostics: "M12 4 2.5 20h19zM12 10v4.5M12 17.2v.3",
  chevron: "M8 10l4 4 4-4",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  arrow: "M5 12h14M13 6l6 6-6 6",
  refresh: "M20 11a8 8 0 0 0-14.5-4.5L4 8M4 4v4h4M4 13a8 8 0 0 0 14.5 4.5L20 16M20 20v-4h-4"
} as const;
export type IconName = keyof typeof PATHS;

export function NavIcon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return <svg className={`hub-icon${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={PATHS[name]} /></svg>;
}
