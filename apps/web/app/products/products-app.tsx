"use client";
import { useEffect, useState } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { HubShell } from "../hub/hub-shell";
import { productStage } from "../hub/navigation-model";
import type { Product, ProductsPayload } from "./types";

function ProductRow({ product: p }: { product: Product }) {
  return <li className="product-row" data-product-id={p.id}>
    <div><h3>{p.name}</h3><p className="product-provenance">PJ · {p.id} · committed .launch.yaml <code>{p.declaration.commit.slice(0, 8)}</code></p>
      {p.destination?.publishedAt ? <p className="product-provenance">Receipt published <time dateTime={p.destination.publishedAt}>{new Date(p.destination.publishedAt).toISOString().replace("T", " ").replace(".000Z", " UTC")}</time></p> : null}
      {p.issue ? <p className="product-issue" role="status">{p.issue}</p> : null}
    </div>
    {p.destination ? <a className="product-action" href={p.destination.href} {...(p.stage === "launch" ? { target: "_blank", rel: "noreferrer noopener" } : {})}>{p.destination.label}{p.stage === "launch" ? <span className="hub-sr-only"> for {p.name} (new tab)</span> : <span className="hub-sr-only"> for {p.name}</span>}</a> : <span className="product-unavailable">Dashboard unavailable</span>}
  </li>;
}
export function ProductsApp() {
  const [theme, toggle] = useTheme();
  const [stage, setStage] = useState<"launch" | "live">();
  const { data, error, reload } = usePoll<ProductsPayload>("/api/modules/products", 15_000);
  useEffect(() => {
    const sync = () => setStage(productStage(window.location.search));
    sync(); window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  const lastGood = data?.registry.state === "down" || !!error;
  return <div className="hub-root products-root" data-theme={theme}>
    <HubShell current={stage ? `products-${stage}` : "products"}><Brand /><div className="hub-header-end"><ThemeToggle theme={theme} onToggle={toggle} /></div></HubShell>
    <main id="hub-content" tabIndex={-1} className="products-content">
      <div className="products-heading"><div><h1>Products</h1><p>Preparing to launch and live. Open the existing dashboard or management view.</p></div><button className="hub-btn" onClick={reload} type="button">Refresh sources</button></div>
      <nav className="products-filter" aria-label="Product stages">{[[undefined, "All products"], ["launch", "Preparing to launch"], ["live", "Live"]].map(([s, label]) => <a key={label} href={s ? `/products?stage=${s}` : "/products"} aria-current={stage === s ? "page" : undefined}>{label}</a>)}</nav>
      {!data ? <p role="status">{error ? "Products API unavailable. No directory snapshot is available." : "Reading registered lifecycle declarations…"}</p> : <>
        <div className="products-source" role="status">
          {lastGood ? <p className="product-issue">{error ? "Products API unavailable. Showing the last response." : data.registry.detail} {data.registry.snapshotAt ? `Last good PJ snapshot: ${data.registry.snapshotAt} (${data.registry.ageSeconds ?? 0}s old at this read).` : "No successful PJ snapshot is available."}</p> : <p>PJ registry read <time dateTime={data.registry.snapshotAt}>{data.registry.snapshotAt}</time>. Declarations and receipts are read-only; links do not attest service health.</p>}
        </div>
        {(["launch", "live"] as const).filter((s) => !stage || stage === s).map((s) => {
          const products = data.products.filter((p) => p.stage === s);
          return <section key={s} aria-labelledby={`products-${s}`} className="products-section"><h2 id={`products-${s}`}>{s === "launch" ? "Preparing to launch" : "Live"}</h2>
            {products.length ? <ul className="products-list">{products.map((p) => <ProductRow key={p.id} product={p} />)}</ul> : <p>{lastGood || data.issues.length ? "No entries in the available snapshot; discovery is incomplete." : `No registered products declared ${s}.`}</p>}
          </section>;
        })}
        {data.issues.length ? <details className="products-issues"><summary>Lifecycle source issues ({data.issues.length})</summary><ul>{data.issues.map((i) => <li key={i.id}><strong>{i.name}</strong> · {i.state}: {i.detail}</li>)}</ul></details> : null}
      </>}
    </main>
  </div>;
}
