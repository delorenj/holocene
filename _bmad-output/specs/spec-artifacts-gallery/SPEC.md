---
id: SPEC-artifacts-gallery
companions:
  - catalog-and-verification.md
sources:
  - https://plane.delo.sh/33god/browse/HOLOC-53/
---

# Holocene Artifacts gallery

> Canonical contract: this kernel and its companion define what to build and verify. Decisions are derived from `.memlog.md` using BMAD Spec. Implementation ticket: [HOLOC-53](https://plane.delo.sh/33god/browse/HOLOC-53/).

## Why

Jarad wants to “browse and search my Artifacts,” dig through a date or date window, and switch between all files, a video gallery and a picture gallery. MinIO publications and newly hosted R2 videos should be discoverable together in the dashboard he already uses, without moving media or replacing the publisher.

## Capabilities

- **CAP-1**
  - **intent:** Jarad can discover published artifacts from both stores in one newest-first catalog.
  - **success:** A discoverable Artifacts page includes MinIO projects and share publications, legacy session-folder artifacts and R2 video publications, with stable identities and original published links.
- **CAP-2**
  - **intent:** Jarad can find artifacts by available metadata, date and media type together.
  - **success:** Search matches available titles, filenames and descriptions across the full catalog; single-day/custom date-window and All, Images, Videos, Audio, PDFs, Other filters combine before pagination, with visible timezone semantics and deterministic ordering.
- **CAP-3**
  - **intent:** Jarad can browse picture and video galleries without confusing variants or supporting files for separate publications.
  - **success:** Images have thumbnails; videos have posters and understandable variant labels/grouping. Posters, captions, generated hub pages and site scaffolding are not duplicate artifacts; published original links remain accessible.
- **CAP-4**
  - **intent:** Jarad can inspect media on phone or desktop and understand missing results or unavailable sources.
  - **success:** Responsive image/video/audio previews and PDF/document preview or open-original fallback work; loading, valid empty results, partial-source failure and full failure are distinguishable, with truthful freshness when cached data is shown.

## Constraints

- Read-only adapters reuse the artifacts publisher's existing storage layout, listing and metadata conventions. Holocene owns the read API and page; publisher changes belong to its owner only if an actual gap prevents acceptance.
- Server-side catalog enumeration must respect Holocene's authenticated access boundary, including direct API requests; no anonymous capability-link catalog, client credentials, hub-token leakage or unsafe HTML execution.
- Search is metadata-only. Best-available publication timestamps or object modification timestamps are explicitly labeled; folder dates do not establish authoritative creation time.
- Use the browser's IANA timezone, visibly labeled, for DST-aware local-day boundaries; see the companion for fallback and exact interval semantics.
- Relevant checks, independent spec and quality review, production propagation and live authenticated browser verification are required by `AGENTS.md`; a dev server or an OAuth redirect is not completion evidence.

## Non-goals

- Upload, edit, delete, republish, storage migration or a replacement publishing system.
- OCR, transcription, content indexing, new recurring schedules or another producer-specific event feed.
- Inventing metadata absent from the publisher, or requiring Jarad to repeat or sign off this request.

## Success signal

Jarad can open the live Artifacts page on phone and desktop, find real existing MinIO and R2 publications using combined text/date/type filters (including a match beyond the first page), play/view each supported media type or its honest fallback, and follow the original links. Boundary and failure tests and an authenticated live browser check provide the acceptance evidence.

## Assumptions

- “Date” means available publication time, falling back to clearly labeled modification time; recovering an unknowable original creation date is not required.
- One vertical implementation story is the smallest independently usable delivery. API adapters, query and gallery UI are checkpoints within HOLOC-53, not separate dispatchable foundation tickets.
