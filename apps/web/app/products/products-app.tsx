"use client";
import { useEffect, useState } from "react";
import { Brand, ThemeToggle, usePoll, useTheme } from "../hub/hub-app";
import { HubShell } from "../hub/hub-shell";
import { NavIcon } from "../hub/nav-icons";
import { productStage } from "../hub/navigation-model";
import { groupIssues, receiptPath, stamp, STAGE_LABEL } from "./products-model";
import type { Product, ProductsPayload } from "./types";

function ProductRow({ product: p, index }: { product: Product; index: number }) {
  const external = p.stage === "launch";
  return <li className="product-row" data-product-id={p.id}>
    <span className="product-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
    <div className="product-identity">
      <h3>{p.name}</h3>
      <p className="product-provenance">ID <code>{p.id}</code> · .launch.yaml <code>{p.declaration.commit.slice(0, 8)}</code></p>
    </div>
    <div className="product-receipt">
      {external && p.destination ? <>
        <p className="product-receipt-path"><NavIcon name="transcripts" size={14} /><span>{receiptPath(p.destination.href)}</span></p>
        {p.destination.publishedAt ? <p className="product-provenance">Receipt stamped <time dateTime={p.destination.publishedAt}>{stamp(p.destination.publishedAt)}</time></p> : null}
      </> : null}
      {!external && p.destination ? <p className="product-provenance">Existing release view in Live management</p> : null}
      {p.issue ? <p className="product-issue" role="status">{p.issue}</p> : null}
    </div>
    <div className="product-cta">
      {p.destination ? <a className="product-action" href={p.destination.href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}>
        <span>{p.destination.label}</span><NavIcon name={external ? "external" : "arrow"} size={16} />
        <span className="hub-sr-only"> for {p.name}{external ? " (new tab)" : ""}</span>
      </a> : <span className="product-unavailable">Dashboard unavailable</span>}
    </div>
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
  const count = (s?: "launch" | "live") => data ? data.products.filter((p) => !s || p.stage === s).length : undefined;
  const issues = data ? groupIssues(data.issues) : undefined;
  return <div className="hub-root products-root" data-theme={theme}>
    <HubShell current={stage ? `products-${stage}` : "products"}><Brand /><div className="hub-header-end"><ThemeToggle theme={theme} onToggle={toggle} /></div></HubShell>
    <main id="hub-content" tabIndex={-1} className="products-content">
      <div className="products-heading">
        <div className="products-title">
          <p className="products-eyebrow">Catalog / Products</p>
          <h1>Products</h1>
          {data ? <ul className="hub-tally" aria-label="Directory summary">
            <li className="is-strong">{count("launch")} preparing to launch</li>
            <li>{count("live")} live</li>
            {issues?.actionable.length ? <li className="is-warn">{issues.actionable.length} unreadable</li> : null}
          </ul> : null}
        </div>
        <div className="products-tools">
          <nav className="products-filter" aria-label="Product stages">{([[undefined, "All products"], ["launch", STAGE_LABEL.launch], ["live", STAGE_LABEL.live]] as const).map(([s, label]) =>
            <a key={label} href={s ? `/products?stage=${s}` : "/products"} aria-current={stage === s ? "page" : undefined}>{label}{data ? <span className="products-filter-count" aria-hidden="true">{count(s)}</span> : null}</a>)}</nav>
          <button className="hub-btn is-ghost products-refresh" onClick={reload} type="button"><NavIcon name="refresh" size={16} /><span>Refresh sources</span></button>
        </div>
      </div>
      {!data ? <p role="status" className="products-loading">{error ? "Products API unavailable. No directory snapshot is available." : "Reading registered lifecycle declarations…"}</p> : <>
        <div className="products-source hub-chips" role="status">
          <span className="hub-chip is-outline">source: PJ + committed .launch.yaml</span>
          {data.registry.snapshotAt ? <span className="hub-chip">PJ read <time dateTime={data.registry.snapshotAt}>{stamp(data.registry.snapshotAt)}</time> · {data.registry.ageSeconds ?? 0}s old</span> : null}
          <span className={`hub-tag ${lastGood ? "is-broken" : "is-cleared"}`}>{lastGood ? "registry degraded" : "registry ok"}</span>
          {lastGood ? <p className="product-issue">{error ? "Products API unavailable. Showing the last response." : data.registry.detail} {data.registry.snapshotAt ? `Last good PJ snapshot: ${data.registry.snapshotAt} (${data.registry.ageSeconds ?? 0}s old at this read).` : "No successful PJ snapshot is available."}</p>
            : <p className="products-source-note">Declarations and receipts are read-only; links do not attest service health.</p>}
        </div>
        {(["launch", "live"] as const).filter((s) => !stage || stage === s).map((s) => {
          const products = data.products.filter((p) => p.stage === s);
          return <section key={s} aria-labelledby={`products-${s}`} className={`hub-panel products-section is-${s}`}>
            <div className={`hub-panel-head${s === "live" ? " is-quiet" : ""}`}>
              <NavIcon name={s === "launch" ? "launch" : "live"} />
              <h2 id={`products-${s}`}>{STAGE_LABEL[s]}</h2>
              <span className="hub-panel-count" aria-label={`${products.length} ${products.length === 1 ? "product" : "products"}`}>{products.length}</span>
              <span className="hub-panel-meta">{s === "launch" ? "receipt-backed launch dashboards · open in a new tab" : "existing storefront and fulfilment view"}</span>
            </div>
            {products.length ? <>
              <div className="products-columns" aria-hidden="true"><span>Product</span><span>{s === "launch" ? "Publication receipt" : "Destination"}</span><span>Action</span></div>
              <ul className="products-list">{products.map((p, i) => <ProductRow key={p.id} product={p} index={i} />)}</ul>
            </> : <p className="hub-panel-body products-empty">{lastGood || data.issues.length ? "No entries in the available snapshot; discovery is incomplete." : `No registered products declared ${s}.`}</p>}
          </section>;
        })}
        {issues && (issues.actionable.length || issues.missing.length || lastGood) ? <section aria-labelledby="products-issues" className="hub-panel products-issues">
          <div className="hub-panel-head is-quiet">
            <NavIcon name="diagnostics" />
            <h2 id="products-issues">Lifecycle source issues</h2>
            <span className="hub-panel-count" aria-label={`${data.issues.length} issues`}>{data.issues.length}</span>
            <span className="hub-panel-meta">read-only discovery · never inferred as healthy or empty</span>
          </div>
          <div className="hub-panel-body products-issue-list">
            {lastGood ? <article className="products-issue-card is-dashed">
              <span className="hub-tag is-broken">registry degraded</span>
              <div><h3>Lifecycle discovery is incomplete</h3><p>Rows above come only from the last good snapshot. Retry read re-runs read-only discovery.</p></div>
              <button className="hub-btn" type="button" onClick={reload}>Retry read</button>
            </article> : null}
            {issues.actionable.map((i) => <article key={i.id} className="products-issue-card">
              <span className={`hub-tag ${i.state === "invalid" ? "is-broken" : "is-stuck"}`}>{i.state}</span>
              <div><h3>{i.name}</h3><p><code>{i.id}</code> · {i.detail}</p></div>
            </article>)}
            {issues.missing.length ? <details className="products-missing">
              <summary><span className="hub-tag">missing</span> {issues.missing.length} registered {issues.missing.length === 1 ? "project has" : "projects have"} no committed .launch.yaml; lifecycle is unknown.</summary>
              <ul>{issues.missing.map((i) => <li key={i.id}>{i.name}</li>)}</ul>
            </details> : null}
          </div>
        </section> : null}
      </>}
    </main>
  </div>;
}
