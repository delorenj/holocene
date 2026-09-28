// @holocene/delohq-contracts — the sole registry of browser-facing DeloHQ
// contracts (AD-11). Every /hq/api/* projection, adapter, view, and test
// imports its envelope, canonical refs, freshness vocabulary, Unknown/error
// states, and evidence metadata from here; no /hq code defines a local dialect.
//
// This module is PURE: no fs, no fetch, no clock, no env. Callers do the IO
// and pass `now` in, so the same validators run in apps/api, apps/web, and
// tests.

export { type ValidationResult, type Validator, isIsoUtc } from "./validation.js";
export * from "./refs.js";
export * from "./freshness.js";
export * from "./errors.js";
export * from "./evidence.js";
export * from "./registry.js";
export * from "./envelope.js";
