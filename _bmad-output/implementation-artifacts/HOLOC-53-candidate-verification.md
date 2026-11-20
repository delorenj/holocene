# HOLOC-53 candidate verification (no deployment)

Branch `holoc-53-artifacts-gallery` is an isolated implementation candidate. This report contains aggregate counts only; no private catalog, hub token, published object keys, signed requests, or secrets are recorded here.

## Storage and route exercise

- Live read-only MinIO recursive listing: 1,855 projects objects. Normalization returned 1,679 independently useful projects entries and 8 share entries. Older session-folder paths were present in the listing; loose three-segment files have their own filename fallback.
- Live R2 paginated listing through the publisher's approved 1Password reference: 31 objects, 13 page/manifest enrichments, 2 gallery manifests, 0 enrichment failures. Normalization returned 9 playable video entries, 8 with gallery-variant labels, without standalone duplicates.
- Full candidate catalog: 1,696 distinct source-qualified IDs: 708 images, 106 videos, 270 audio, 3 PDFs, 609 other. A second image page returned 24 entries; full-catalog text/type search returned 9 video matches and a two-item first page.
- Fastify candidate route injection with actual storage: anonymous direct API returned 401, fresh signed request returned 200; projects, share and R2 all reported healthy. The candidate Next handler, run against an isolated API port, returned 1,696 total with two entries at `limit=2`; candidate `/artifacts` returned 200.
- Representative published image, video, audio, PDF and HTML originals returned HEAD 200 with appropriate media types. R2 playback returned HTTP 206 and `Content-Range` for `bytes=0-1023`; its share page returned 200. Browser checks on candidate page found picture thumbnails, native audio, PDF open-original fallback, video elements, nine gallery-search results, timezone `America/New_York`, 24 initial cards. Browser console had only an unrelated `/favicon.ico` 404.

## Checks

- API focused tests: 6/6. API regression suite: 270/270. Web regression suite: 74/74.
- API and web typechecks: pass after building existing workspace package declarations. API build and Next production build: pass; `/artifacts` and `/api/artifacts/catalog` present in Next route output.
- No platform/publisher changes, Plane writes, deployment or live authenticated `holocene.delo.sh` verification. PM owns review, authorization to land, production propagation and live verification.

## Grouping and trust rules

- MinIO date/project/share folders group a site's HTML and assets; useful image/audio/PDF/document originals remain separate. Generated hub indexes, CSS/JS/fonts, site scaffolding, captions and posters do not create duplicate gallery rows. Legacy loose media keeps its original filename rather than taking a session UUID as its title.
- R2 extensionless pages are original share links; manifests are parsed as data and member pages replace duplicate standalone rows. Manifest destinations must be HTTPS on the known video origin *and* correspond to listed objects. Metadata is displayed as escaped React text; fetched HTML is parsed for bounded title/description only, never embedded in the dashboard origin.
- Existing Google forward auth protects the dashboard route in production. Direct Fastify enumeration is separately signed by the Next handler with a short-lived HMAC using the existing server-only Telegram bot secret; requests without that signature fail closed. The internal API still has a permissive CORS hook for unrelated routes, but this route denies anonymous access before listing. Production owner must keep the bot secret available to both web and API processes and preserve the forward-auth route boundary (including no new unauthenticated carve-out for `/artifacts` or `/api/artifacts/catalog`).
