#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const args = parseArgs(process.argv.slice(2));
const baseUrl = required(args, "base-url").replace(/\/$/, "");
const lifecycleId = required(args, "lifecycle-id");
const outputPath = resolve(required(args, "output"));
const screenshotsDir = resolve(required(args, "screenshots-dir"));
const expectedFrontierId = args.get("frontier-id") ?? null;
const timeoutMs = positiveInteger(args.get("timeout-ms") ?? "90000", "timeout-ms");
const pageUrl = `${baseUrl}/lifecycle/${encodeURIComponent(lifecycleId)}`;
const apiPath = `/api/lifecycle/${encodeURIComponent(lifecycleId)}`;
const apiUrl = `${baseUrl}${apiPath}`;
const artifactStem = lifecycleId.replace(/[^a-zA-Z0-9_.-]/g, "-");

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(screenshotsDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
let page;

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
    serviceWorkers: "block"
  });
  page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  const surface = page.locator(
    '[data-testid="lifecycle-surface"][data-proof-contract="holocene-lifecycle-browser-v1"]'
  );
  await surface.waitFor({ state: "visible", timeout: timeoutMs });
  await page.waitForFunction(
    ({ lifecycleId: expectedId }) => {
      const root = document.querySelector('[data-testid="lifecycle-surface"]');
      return Boolean(
        root &&
          root.getAttribute("data-lifecycle-id") === expectedId &&
          root.getAttribute("data-projection-status") === "current" &&
          Number(root.getAttribute("data-state-version")) > 0 &&
          root.getAttribute("data-source-event-id") &&
          root.getAttribute("data-source-correlation-id")
      );
    },
    { lifecycleId },
    { timeout: timeoutMs }
  );

  const initialState = await renderedState(surface);
  assert.equal(initialState.lifecycle_id, lifecycleId);
  assert.equal(initialState.projection_status, "current");
  assert.ok(initialState.state_version > 0, "rendered state_version must be positive");
  assertNonEmpty(initialState.source.event_id, "initial source event_id");
  assertNonEmpty(initialState.source.correlation_id, "initial source correlation_id");

  const actorControl = page.locator('[data-testid="lifecycle-actor"]');
  const capabilityControl = page.locator('[data-testid="lifecycle-capability"]');
  await page.waitForFunction(
    () => {
      const actor = document.querySelector('[data-testid="lifecycle-actor"]');
      const capability = document.querySelector('[data-testid="lifecycle-capability"]');
      return Boolean(
        actor instanceof HTMLInputElement &&
          actor.value &&
          capability instanceof HTMLSelectElement &&
          capability.value &&
          capability.selectedOptions[0]?.dataset.capabilityVersion
      );
    },
    undefined,
    { timeout: timeoutMs }
  );
  const actorId = await actorControl.inputValue();
  const grant = await capabilityControl.locator("option:checked").evaluate((option) => ({
    actor_id: option.dataset.actorId ?? "",
    capability_id: option.dataset.capabilityId ?? "",
    capability_version: Number(option.dataset.capabilityVersion),
    state_version: Number(option.dataset.grantStateVersion)
  }));
  assertNonEmpty(actorId, "selected actor");
  assert.equal(grant.actor_id, actorId, "selected grant actor must match selected actor");
  assertNonEmpty(grant.capability_id, "selected capability grant");
  assert.ok(grant.capability_version > 0, "selected capability_version must be positive");
  assert.equal(
    grant.state_version,
    initialState.state_version,
    "selected grant state version must match rendered state"
  );

  const frontierItems = await page
    .locator('[data-testid="lifecycle-frontier-item"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        id: node.dataset.frontierId ?? "",
        kind: node.dataset.frontierKind ?? "",
        action: node.dataset.frontierAction ?? "",
        allowed: node.dataset.frontierAllowed === "true",
        reason_code: node.dataset.frontierReasonCode ?? "",
        expected_state_version: Number(node.dataset.expectedStateVersion),
        capability_required: node.dataset.capabilityRequired ?? ""
      }))
    );
  const candidates = frontierItems.filter(
    (item) =>
      item.allowed &&
      item.reason_code === "LEGAL_REQUIRES_CONFIRMATION" &&
      (!expectedFrontierId || item.id === expectedFrontierId)
  );
  assert.equal(
    candidates.length,
    1,
    `expected one rendered confirmation frontier, observed ${JSON.stringify(candidates)}`
  );
  const frontier = candidates[0];
  assertNonEmpty(frontier.id, "frontier id");
  assertNonEmpty(frontier.action, "frontier action");
  assert.equal(frontier.expected_state_version, initialState.state_version);
  assert.equal(frontier.capability_required, "lifecycle.intent.submit");

  const actionSelector =
    `[data-testid="lifecycle-action"][data-frontier-id="${selectorValue(frontier.id)}"]`;
  const actionButton = page.locator(actionSelector);
  await actionButton.waitFor({ state: "visible", timeout: timeoutMs });
  assert.equal(await actionButton.isEnabled(), true, "rendered frontier action must be enabled");

  const expectedDialogMessage =
    `Submit confirmed Lifecycle action ${frontier.action} for frontier ${frontier.id}?`;
  const dialogPromise = new Promise((resolveDialog, rejectDialog) => {
    page.once("dialog", async (dialog) => {
      const observed = {
        seen: true,
        type: dialog.type(),
        message: dialog.message(),
        expected_message: expectedDialogMessage,
        action: frontier.action,
        frontier_id: frontier.id,
        accepted: false
      };
      try {
        assert.equal(observed.type, "confirm", "Lifecycle action must open a confirmation dialog");
        assert.equal(observed.message, expectedDialogMessage, "dialog action/frontier identity mismatch");
        await dialog.accept();
        observed.accepted = true;
        resolveDialog(observed);
      } catch (error) {
        await dialog.dismiss().catch(() => undefined);
        rejectDialog(error);
      }
    });
  });
  const requestPromise = page.waitForRequest(
    (request) => request.method() === "POST" && request.url() === apiUrl,
    { timeout: timeoutMs }
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url() === apiUrl,
    { timeout: timeoutMs }
  );

  const clickStartedAt = new Date().toISOString();
  await actionButton.click({ timeout: timeoutMs });
  const [dialog, request, response] = await Promise.all([
    withTimeout(dialogPromise, timeoutMs, "Lifecycle confirmation dialog"),
    requestPromise,
    responsePromise
  ]);
  const click = {
    selector: actionSelector,
    clicked: true,
    enabled_before_click: true,
    frontier_id: frontier.id,
    action: frontier.action,
    started_at: clickStartedAt,
    completed_at: new Date().toISOString()
  };

  const requestRawBody = request.postData();
  assert.equal(request.url(), apiUrl, "captured browser request used an unexpected origin or path");
  assertNonEmpty(requestRawBody, "browser POST body");
  const requestBody = JSON.parse(requestRawBody);
  const requestReceipt = {
    browser_originated: true,
    url: request.url(),
    method: request.method(),
    resource_type: request.resourceType(),
    content_type: (await request.allHeaders())["content-type"] ?? "",
    raw_body: requestRawBody,
    body: requestBody
  };
  assert.equal(requestReceipt.resource_type, "fetch");
  assert.equal(requestReceipt.content_type, "application/json");
  assert.deepEqual(requestBody, {
    frontier_id: frontier.id,
    expected_state_version: frontier.expected_state_version,
    actor: { type: "operator", agent_id: actorId },
    capability_id: grant.capability_id,
    parameters: { confirmed: true }
  });

  const responseRawBody = await response.text();
  assert.equal(response.request(), request, "HTTP 202 did not belong to the captured browser POST");
  assert.equal(response.url(), apiUrl, "captured response used an unexpected origin or path");
  assert.equal(response.fromServiceWorker(), false, "browser response came from a service worker");
  assertNonEmpty(responseRawBody, "HTTP 202 response body");
  const responseBody = JSON.parse(responseRawBody);
  assert.equal(response.status(), 202, "Holocene action response must be HTTP 202");
  assert.equal(responseBody.broker_processed, true);
  assert.equal(responseBody.durable_jetstream_acknowledged, false);
  assert.equal(responseBody.authority_accepted, false);
  assert.equal(responseBody.lifecycle_id, lifecycleId);
  assert.equal(responseBody.expected_state_version, frontier.expected_state_version);
  for (const field of [
    "command_event_id",
    "command_id",
    "idempotency_key",
    "correlation_id",
    "causation_id"
  ]) {
    assertNonEmpty(responseBody[field], `response ${field}`);
  }
  assert.equal(responseBody.correlation_id, initialState.source.correlation_id);
  assert.equal(responseBody.causation_id, initialState.source.event_id);
  const responseReceipt = {
    url: response.url(),
    status: response.status(),
    ok: response.ok(),
    from_service_worker: response.fromServiceWorker(),
    raw_body: responseRawBody,
    body: responseBody
  };

  const successLocator = page.locator('[data-testid="lifecycle-command-success"]');
  await successLocator.waitFor({ state: "visible", timeout: timeoutMs });
  const uiSuccess = await successLocator.evaluate((node) => ({
    visible: true,
    text: node.textContent?.trim() ?? "",
    command_id: node.dataset.commandId ?? "",
    command_event_id: node.dataset.commandEventId ?? "",
    correlation_id: node.dataset.correlationId ?? "",
    causation_id: node.dataset.causationId ?? "",
    broker_processed: node.dataset.brokerProcessed === "true",
    authority_accepted: node.dataset.authorityAccepted === "true"
  }));
  assert.equal(uiSuccess.command_id, responseBody.command_id);
  assert.equal(uiSuccess.command_event_id, responseBody.command_event_id);
  assert.equal(uiSuccess.correlation_id, responseBody.correlation_id);
  assert.equal(uiSuccess.causation_id, responseBody.causation_id);
  assert.equal(uiSuccess.broker_processed, true);
  assert.equal(uiSuccess.authority_accepted, false);

  await page.waitForFunction(
    (commandId) => {
      const verdict = Array.from(
        document.querySelectorAll('[data-testid="lifecycle-command-verdict"]')
      ).find((node) => node.getAttribute("data-command-id") === commandId);
      return Boolean(
        verdict &&
          verdict.getAttribute("data-verdict") === "applied" &&
          verdict.getAttribute("data-mutated") === "true" &&
          Number(verdict.getAttribute("data-resulting-state-version")) > 0
      );
    },
    responseBody.command_id,
    { timeout: timeoutMs }
  );
  const verdictLocator = page
    .locator('[data-testid="lifecycle-command-verdict"]')
    .filter({ has: page.locator(`text=command ${responseBody.command_id}`) });
  const verdict = await verdictLocator.first().evaluate((node) => ({
    reply_event_id: node.dataset.replyEventId ?? "",
    command_event_id: node.dataset.commandEventId ?? "",
    command_id: node.dataset.commandId ?? "",
    verdict: node.dataset.verdict ?? "",
    mutated: node.dataset.mutated === "true",
    expected_state_version: Number(node.dataset.expectedStateVersion),
    observed_state_version: Number(node.dataset.observedStateVersion),
    resulting_state_version: Number(node.dataset.resultingStateVersion),
    applied_event_id: node.dataset.appliedEventId ?? "",
    capability_id: node.dataset.capabilityId ?? "",
    reason_code: node.dataset.reasonCode ?? "",
    correlation_id: node.dataset.correlationId ?? "",
    causation_id: node.dataset.causationId ?? ""
  }));
  assert.equal(verdict.command_id, responseBody.command_id);
  assert.equal(verdict.command_event_id, responseBody.command_event_id);
  assert.equal(verdict.expected_state_version, frontier.expected_state_version);
  assert.equal(verdict.observed_state_version, frontier.expected_state_version);
  assert.ok(verdict.resulting_state_version > frontier.expected_state_version);
  assertNonEmpty(verdict.reply_event_id, "authority verdict reply_event_id");
  assertNonEmpty(verdict.applied_event_id, "authority verdict applied_event_id");
  assertNonEmpty(verdict.reason_code, "authority verdict reason_code");
  assert.equal(verdict.capability_id, grant.capability_id);
  assert.equal(verdict.correlation_id, responseBody.correlation_id);
  assert.equal(verdict.causation_id, responseBody.command_event_id);

  await page.waitForFunction(
    ({ commandEventId, correlationId, resultingStateVersion }) => {
      const root = document.querySelector('[data-testid="lifecycle-surface"]');
      return Boolean(
        root &&
          root.getAttribute("data-projection-status") === "current" &&
          Number(root.getAttribute("data-state-version")) === resultingStateVersion &&
          root.getAttribute("data-source-correlation-id") === correlationId &&
          root.getAttribute("data-source-causation-id") === commandEventId
      );
    },
    {
      commandEventId: responseBody.command_event_id,
      correlationId: responseBody.correlation_id,
      resultingStateVersion: verdict.resulting_state_version
    },
    { timeout: timeoutMs }
  );
  const finalState = await renderedState(surface);
  assert.equal(finalState.state_version, verdict.resulting_state_version);
  assert.notEqual(finalState.status, initialState.status, "authority status did not transition");
  assert.equal(finalState.source.correlation_id, responseBody.correlation_id);
  assert.equal(finalState.source.causation_id, responseBody.command_event_id);
  finalState.command_verdict = verdict;

  const desktopPath = resolve(screenshotsDir, `${artifactStem}-desktop.png`);
  const mobilePath = resolve(screenshotsDir, `${artifactStem}-mobile.png`);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: desktopPath, fullPage: true });
  await page.setViewportSize({ width: 412, height: 915 });
  await page.screenshot({ path: mobilePath, fullPage: true });

  const receipt = {
    contract_version: "holocene-lifecycle-browser-proof/v1",
    generated_at: new Date().toISOString(),
    page_url: pageUrl,
    lifecycle_id: lifecycleId,
    dialog,
    click,
    request: requestReceipt,
    response: responseReceipt,
    initial_rendered_state: {
      ...initialState,
      actor_id: actorId,
      capability_grant: grant,
      frontier
    },
    ui_success: uiSuccess,
    final_rendered_state: finalState,
    screenshots: {
      desktop: await imageReceipt(desktopPath, 1440, 1000),
      mobile: await imageReceipt(mobilePath, 412, 915)
    }
  };
  await writeFile(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ receipt: outputPath, command_id: responseBody.command_id })}\n`);
} catch (error) {
  if (page) {
    const failurePath = resolve(screenshotsDir, `${artifactStem}-failure.png`);
    await page.screenshot({ path: failurePath, fullPage: true }).catch(() => undefined);
  }
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
} finally {
  await browser.close();
}

async function renderedState(surface) {
  return surface.evaluate((node) => ({
    lifecycle_id: node.dataset.lifecycleId ?? "",
    projection_status: node.dataset.projectionStatus ?? "",
    status: node.dataset.stateStatus ?? "",
    state_version: Number(node.dataset.stateVersion),
    source: {
      event_id: node.dataset.sourceEventId ?? "",
      correlation_id: node.dataset.sourceCorrelationId ?? "",
      causation_id: node.dataset.sourceCausationId ?? ""
    }
  }));
}

async function imageReceipt(path, viewportWidth, viewportHeight) {
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${path} is not PNG`);
  assert.ok(bytes.length > 1000, `${path} is unexpectedly small`);
  return {
    path,
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    viewport: { width: viewportWidth, height: viewportHeight }
  };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument list near ${flag ?? "end of input"}`);
    }
    values.set(flag.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`--${name} must be positive`);
  return parsed;
}

function selectorValue(value) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function assertNonEmpty(value, label) {
  assert.equal(typeof value, "string", `${label} must be a string`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function withTimeout(promise, milliseconds, description) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${description}`)), milliseconds);
    })
  ]).finally(() => clearTimeout(timer));
}
