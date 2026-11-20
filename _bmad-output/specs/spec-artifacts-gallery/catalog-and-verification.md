# Catalog contract and verification

Companion to `SPEC.md`; implementation and acceptance details for HOLOC-53. This is a plan, not a completion or board-status record.

## Existing seams

- `.agents/skills/artifacts/SKILL.md` is the publisher source. Read it and `references/video-r2.md` before implementation.
- `scripts/publish.py:252–262` lists MinIO objects recursively; `301–344` builds optional date/project HTML hubs; `347–411` defines projects and share paths. Hubs are navigation, not a complete catalog, and `--no-index` publications exist. The helper currently conflates list failure with an empty result: the adapter must retain the failure distinction, not inherit that behavior.
- MinIO shapes include `projects/<project>/<YYYY-MM-DD>/<name>/<files>`, legacy `projects/<project>/<session>/<files>` and `share/<token>/<name>/<files>`. Do not assume every folder is a date or every object a publication.
- `scripts/video.py:324–340` paginates R2 object listing; `759–778` powers `--list`; `734–753` supplies `gallery.json` with labels, notes and original/preview URLs. Extensionless pages are canonical share links, not directory indexes. Page metadata can enrich available titles/descriptions; do not search only the terse CLI list rows.
- Existing integration seams: `apps/api/src/server.ts`, `apps/web/next.config.mjs` API rewrite, and shared `HubTabs` in `apps/web/app/hub/ui.tsx`. Follow current checkout, not hardcoded line numbers. Leave unrelated voice/car work alone.

## Normalized read model

Keep source adapters separate from shared query and rendering. Carry stable source-qualified identity, source, available project/name/title/description, searchable filenames, media category, original entry link, media/poster links when available, timestamp plus provenance, and optional gallery membership/variant label. Missing optional metadata is allowed; do not invent R2 project association. Encode object keys safely in URLs and do not collapse same-name publications across stores or dates.

A publication may contain multiple files. Preserve independently usable image/audio/PDF/document files and their original file links, while grouping website bundles and attaching their scaffolding rather than flooding results with CSS/JS/fonts. Suppress generated hub indexes. For legacy folders with ambiguous grouping, prefer preserving useful originals with honest filename fallbacks over silently dropping them. Video poster/caption/page objects attach to the video. Gallery variants keep labels and links; gallery containers and their member videos must not inflate results as identical playback items. Document the concrete grouping rules with sanitized fixtures.

Enrichment is bounded and read-only: parse metadata as data, not executable HTML. No OCR, transcription or full-content search. Partial enrichment failure must not hide a valid object or prevent the other source from working.

## Query and dates

- Combine case-insensitive metadata search, selected media category and date/day-window predicates over the complete normalized catalog before pagination. Do not intersect a truncated search result with a separately loaded page.
- Stable newest-first order uses canonical timestamp descending, then stable identity. Return enough query/source metadata to distinguish full, partial and stale results. Unknown dates are explicit, sort after dated items, and are excluded from a date-constrained result with an explanation rather than assigned to today.
- Use browser IANA timezone, display its name, and fall back to visibly labeled UTC if unavailable. A single selected date means local midnight inclusive to next local midnight exclusive. Custom ranges include both selected calendar days via midnight after the final date, not a fixed 24-hour addition. Validate invalid/reversed dates and timezone inputs; test DST transitions and exact boundaries.
- Prefer an available published timestamp, otherwise use object last-modified time and label it “Modified.” Republish may move an item in the order; do not claim it retains original creation time or silently substitute a dated folder name.
- Enumerate all storage listing pages; never silently truncate. Bound request work with reasonable timeouts/concurrency and, if needed, request-driven cache/coalescing with explicit freshness and retry. No scheduled refresh process.

## Access and preview boundaries

The catalog reveals links whose random tokens intentionally prevent enumeration. Keep the listing and enrichment on the server, protected by the existing authenticated Holocene boundary; prove anonymous direct API requests cannot enumerate, including any exposed API listener. Do not broaden CORS or create a public fallback. Read credentials through existing secret references server-side; never include credentials, hub indexes or raw internal list output in API responses, logs, fixtures or screenshots. A public published media link is usable by design but its token-bearing global catalog is not public.

Allow only expected artifact/video origins and safe URL schemes for originals/previews; reject malicious manifest destinations and traversal. Escape metadata; never embed fetched HTML in the application origin or execute it for enrichment. HTML/unknown documents can use open-original fallback; PDF preview may fall back likewise. Video must support playback/seeking through the existing R2 media link; audio uses native controls. Do not autoplay an entire gallery. Clear failed-preview affordances retain an original link.

## Implementation checkpoints — one local story

HOLOC-53 owns the complete vertical slice. Do not create child stories for technical layers that cannot independently fulfill a user need.

1. Read-only source adapters and sanitized normalization fixtures, including legacy folders and R2 gallery variants.
2. Shared full-catalog query contract, timezone boundaries, stable pagination and source health/freshness.
3. Discoverable responsive Artifacts page, all six media filters, combined search/date controls, image/video gallery modes and previews/fallbacks.
4. Independent spec and quality review, production propagation under the existing procedure, and live verification evidence before PM verdict.

Only Krebs moves this triaged Todo ticket into implementation. The implementation turn follows the installed subagent-driven-development kanban/Codex workflow, one implementation worker for this ticket and independent review gates. Any later split requires a genuinely independent user-value seam and explicit blocking relations for colliding files; do not dispatch around WIP.

## Acceptance evidence

| Check | Required evidence |
| --- | --- |
| Store coverage | Read real MinIO projects/share and legacy objects plus R2 videos/galleries; record representative source coverage without publishing a private catalog. A fixture alone does not prove integration. |
| Metadata and identity | Title/filename/description matches where available; missing fields, Unicode, same-name/different-source entries, legacy paths, object pagination and republish behavior covered by sanitized tests. |
| Full-catalog filtering | Match beyond first page, combined search/date/type, deterministic repeated pagination, all six categories, single-day/range, invalid ranges and unknown dates. |
| Date boundaries | Start inclusive/end exclusive, browser timezone vs UTC, DST transition, exact midnight, and modification-time provenance verified. |
| Gallery grouping | Real video variants retain labels/links; posters/captions/hub pages/site assets do not appear as duplicate publications; useful embedded/legacy media remains findable. |
| Previews | Real image, video with seeking, audio, PDF and Other/document exercised or honest fallback; original published links verified. If a type is absent in storage, record that limitation and use a sanctioned fixture/test rather than claiming real coverage. |
| Failure handling | Loading, no matches, one source down, both down, stale cached snapshot and malformed metadata distinguishable; remaining source remains searchable. |
| Security | Anonymous UI/API enumeration denied, authenticated success, server-only credentials, safe origins/schemes, escaped text and malicious manifest/HTML handling covered. |
| Responsive live result | Authenticated `https://holocene.delo.sh` navigation and interactions on phone/desktop viewport with console/network review; OAuth redirect alone is insufficient. |
| Production | Run API and web typechecks; rebuild/restart changed live API and/or platform-owned web service exactly per `AGENTS.md` after verifying Compose ownership. Check API route, health and rendered public deployment. Record generated artifacts touched. |

Review evidence belongs in a linked implementation report/PR, not pasted into ticket comments. Independent reviewer is not the implementer; PM gives the verdict. An actual credential/access gap is owned by the relevant service/publisher owner and is recorded as a concrete dependency, never solved by anonymous catalog exposure or a storage migration.
