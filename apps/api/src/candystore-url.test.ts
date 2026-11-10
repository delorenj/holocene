import assert from "node:assert/strict";
import test from "node:test";
import { CANDYSTORE_DEFAULT_URL, candystoreBaseUrl } from "./candystore-url.js";

test("defaults to the 8683 loopback contract", () => {
  assert.equal(CANDYSTORE_DEFAULT_URL, "http://127.0.0.1:8683");
  assert.equal(candystoreBaseUrl({}), "http://127.0.0.1:8683");
});

test("CANDYSTORE_API_URL wins over CANDYSTORE_URL", () => {
  assert.equal(
    candystoreBaseUrl({ CANDYSTORE_API_URL: "http://api:1/", CANDYSTORE_URL: "http://shared:2" }),
    "http://api:1",
  );
});

test("falls back to CANDYSTORE_URL, trimming trailing slashes", () => {
  assert.equal(candystoreBaseUrl({ CANDYSTORE_URL: "http://127.0.0.1:3603//" }), "http://127.0.0.1:3603");
});

test("blank values fall through to the next source", () => {
  assert.equal(candystoreBaseUrl({ CANDYSTORE_API_URL: "  ", CANDYSTORE_URL: "" }), CANDYSTORE_DEFAULT_URL);
  assert.equal(candystoreBaseUrl({ CANDYSTORE_API_URL: "", CANDYSTORE_URL: "http://x:9" }), "http://x:9");
});
