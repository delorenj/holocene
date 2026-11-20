"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useId, useState } from "react";
import { currentGroup, nativeModifiedClick, NAV_GROUPS, PRODUCT_LINKS, type NavItem } from "./navigation-model";

export type NavigationProps = { current?: string; onSelect?: (id: string) => boolean };
function Hierarchy({ current, onSelect, close }: NavigationProps & { close?: () => void }) {
  const id = useId();
  const ancestor = currentGroup(current);
  const [expanded, setExpanded] = useState<string[]>(ancestor ? [ancestor] : []);
  useEffect(() => { if (ancestor) setExpanded((old) => old.includes(ancestor) ? old : [...old, ancestor]); }, [ancestor]);
  const link = (item: NavItem) => <a key={item.id} href={item.href} className={`hub-nav-link${item.id === "products" ? " is-major" : ""}`} aria-current={current === item.id ? "page" : undefined}
    onClick={(e) => {
      if (nativeModifiedClick(e)) return;
      if (onSelect?.(item.id)) e.preventDefault();
      close?.();
    }}>{item.label}</a>;
  return <nav aria-label="Primary navigation">
    <div className={`hub-nav-products${current?.startsWith("products") ? " is-ancestor" : ""}`}>{PRODUCT_LINKS.map(link)}</div>
    {NAV_GROUPS.map((group) => {
      const open = expanded.includes(group.id);
      return <div key={group.id} className={`hub-nav-group${ancestor === group.id ? " is-ancestor" : ""}`}>
        <button type="button" className="hub-nav-group-toggle" aria-expanded={open} aria-controls={`${id}-${group.id}`} onClick={() => setExpanded((old) => open ? old.filter((g) => g !== group.id) : [...old, group.id])}>
          <span>{group.label}</span><span aria-hidden="true">{open ? "−" : "+"}</span>{ancestor === group.id ? <span className="hub-sr-only">, current group</span> : null}
        </button>
        <div id={`${id}-${group.id}`} hidden={!open}>{group.items.map(link)}</div>
      </div>;
    })}
  </nav>;
}
export function HubNavigation(props: NavigationProps) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const media = window.matchMedia("(min-width: 900px)");
    const change = () => { if (media.matches) setOpen(false); };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  return <>
    <aside className="hub-navigation"><p className="hub-nav-title">Holocene</p><Hierarchy {...props} /></aside>
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="hub-menu">Menu</Dialog.Trigger>
      <Dialog.Overlay className="hub-drawer-overlay" />
      <Dialog.Content className="hub-drawer" aria-describedby={undefined}>
        <div className="hub-drawer-heading"><Dialog.Title>Holocene navigation</Dialog.Title><Dialog.Close className="hub-menu">Close</Dialog.Close></div>
        <Hierarchy {...props} close={() => setOpen(false)} />
      </Dialog.Content>
    </Dialog.Root>
  </>;
}
