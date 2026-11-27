// Built-asset HOLOC-51 regression. Every private/native/network operation is a labelled fixture.
// Use the same PLAYWRIGHT_MODULE and CHROMIUM_PATH as activity.browser.mjs.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core')
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, '.' + new URL(req.url, 'http://fixture').pathname.replace(/^\/$/, '/index.html'))
    if (!path.startsWith(dist)) return res.writeHead(403).end()
    res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/html' }).end(await readFile(path))
  } catch { res.writeHead(404).end() }
})
await new Promise(done => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
const roster = { generated_at: new Date().toISOString(), agents: ['alpha', 'beta'].map(id => ({ id, name: id.toUpperCase(), color: '#4f8cff' })) }
let state = 'working', down = false, uploads = []
const page = await context.newPage(), errors = []
page.on('pageerror', error => errors.push(error.message))
await page.route('**/*', async route => {
  const url = new URL(route.request().url())
  if (url.pathname === '/roster/roster.json') return route.fulfill({ contentType: 'application/json', body: JSON.stringify(roster) })
  if (url.pathname === '/api/pad/activity') return route.fulfill({ status: down ? 503 : 200, contentType: 'application/json', headers: { date: new Date().toUTCString() }, body: JSON.stringify({
    generatedAt: new Date().toISOString(), sources: ['events', 'asm', 'agents registry', 'pjangler'].map(name => ({ name, ...(name === 'events' ? { ageSeconds: 0, maxSeconds: 120 } : {}) })),
    agents: ['alpha', 'beta'].map(id => ({ id, state: id === 'alpha' ? state : 'idle', signal: id === 'beta' ? 'working' : 'idle', lastWorkAt: new Date().toISOString() }))
  }) })
  if (url.pathname.startsWith('/upload')) { if (route.request().method() === 'PUT') uploads.push(route.request().url()); return route.fulfill({ status: 503, body: '{}' }) }
  if (url.origin !== base) return route.fulfill({ contentType: 'application/xml', body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' })
  return route.continue()
})
await page.addInitScript(roster => {
  localStorage.setItem('agentpad.roster', JSON.stringify(roster)); localStorage.setItem('agentpad.agent', 'alpha')
  window.__calls = []; window.__hnDigestNonce = 'fixture-page'
  // Control the existing refresh clock without adding a real timer or waiting a minute.
  const interval = window.setInterval
  window.setInterval = (fn, ms, ...rest) => { if (ms === 60000) window.__refreshDigest = fn; return interval(fn, ms, ...rest) }
  window.HoloceneNative = {
    selectDigest: (...args) => window.__calls.push(['select', ...args]),
    refreshDigest: (...args) => window.__calls.push(['refresh', ...args]),
    playSummary: (...args) => window.__calls.push(['summary', ...args]),
    clearDigest: (...args) => window.__calls.push(['clear', ...args]),
    interruptSummary: (...args) => window.__calls.push(['interrupt', ...args]),
    startFor: name => window.__calls.push(['record', name]),
    stop: () => window.__calls.push(['stop']),
    padEvent: event => window.__calls.push(['event', JSON.parse(event)]),
  }
}, roster)
const count = kind => page.evaluate(kind => window.__calls.filter(c => c[0] === kind).length, kind)
const deliver = async (agent = 'alpha', session = 'session-1', override = {}) => page.evaluate(({ agent, session, override }) => window.__hnDigest?.(agent, {
  agentId: agent, status: 'available', text: `${agent} finished work. Checks passed.`, sourceSessionId: session,
  digestId: (session === 'session-1' ? 'a' : 'b').repeat(64), sourceAt: new Date().toISOString(), ...override
}), { agent, session, override })
const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('online')))
try {
  await page.goto(base); await page.waitForSelector('.tile')
  assert.equal(await count('select'), 0, 'restore must not read/narrate or enter focus')
  assert.equal(await count('record'), 0)
  if (await page.locator('.unlock').count()) await page.locator('.unlock').click()
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'alpha')
  await page.locator('[data-agent=alpha]').click(); await page.waitForSelector('.focus')
  assert.equal(await page.locator('.tile').count(), 0)
  assert.equal(await page.locator('.focus-head').innerText(), 'A\nALPHA')
  assert.match(await page.locator('.rec').innerText(), /Record for ALPHA/)
  assert.equal(await count('record'), 0); assert.equal(uploads.length, 0)
  await deliver(); await page.waitForFunction(() => document.querySelector('.digest')?.textContent.includes('alpha finished'))
  assert.match(await page.locator('.digest').innerText(), /Source just now/)
  assert.equal(await count('summary'), 1)
  await deliver(); assert.equal(await count('summary'), 1, 'duplicate delivery stays silent')
  await page.evaluate(() => window.__refreshDigest()); await deliver('alpha', 'session-2')
  assert.equal(await count('summary'), 1, 'new session on background refresh stays silent')
  await page.locator('.replay').click(); assert.equal(await count('summary'), 2)
  assert.equal(await page.evaluate(() => window.__calls.filter(c => c[0] === 'summary').at(-1)[2]), 'session-2')
  await page.evaluate(() => window.__hnSummary('alpha', 'unavailable'))
  await page.getByText('Summary voice unavailable', { exact: true }).waitFor()
  await deliver('beta'); assert.match(await page.locator('.digest').innerText(), /alpha finished/)
  await deliver('alpha', 'session-2', { sourceAt: '2020-01-01T00:00:00Z' })
  assert.match(await page.locator('.digest').innerText(), /unavailable|stale/)
  assert.equal(await page.locator('.replay').isDisabled(), true)
  await deliver('alpha', 'session-2', { status: 'missing', text: undefined })
  assert.match(await page.locator('.digest').innerText(), /unavailable/)
  for (const [wire, label] of [['working', 'Thinking'], ['tool', 'Using tool'], ['waiting', 'Waiting for you'], ['idle', 'Idle'], ['failed', 'Failed'], ['unknown', 'Work state unknown']]) {
    state = wire; await refresh(); await page.waitForFunction(label => document.querySelector('.focus-state')?.textContent === label, label)
  }
  down = true; await refresh(); await page.waitForFunction(() => document.querySelector('.focus-state')?.textContent === 'Work state unknown')
  down = false; await refresh()
  await page.waitForFunction(() => document.querySelector('.focus-state')?.textContent === 'Work state unknown')
  await page.locator('.back').click(); await page.waitForSelector('.tiles')
  await page.waitForFunction(() => document.querySelector('.tile')?.getAttribute('data-agent') === 'beta')
  assert.equal(await page.locator('.tile').first().getAttribute('data-agent'), 'beta', 'back uses current activity order')
  await page.locator('[data-agent=beta]').click(); await deliver('alpha'); assert.match(await page.locator('.digest').innerText(), /unavailable/)
  await deliver('beta'); await page.waitForFunction(() => document.querySelector('.digest')?.textContent.includes('beta finished'))
  assert.match(await page.locator('.digest').innerText(), /beta finished/)
  await page.locator('.back').click(); await page.locator('[data-agent=alpha]').click(); await deliver()
  await page.waitForFunction(() => document.querySelector('.digest')?.textContent.includes('alpha finished'))
  assert.equal(await count('summary'), 3, 'A-B-back-A never repeats the same entry summary')
  await page.evaluate(() => window.__hnHost({ driving: true, noVideo: true, noText: true }))
  assert.equal(await page.locator('.digest').count(), 0)
  await page.evaluate(() => window.__hnHost({ driving: false, noVideo: false, noText: false }))
  for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 600 }, { width: 800, height: 480 }]) {
    await page.setViewportSize(viewport)
    const dimensions = await page.evaluate(() => {
      const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }
      return { head: rect('.focus-head'), record: rect('.rec'), replay: rect('.replay'), width: innerWidth, height: innerHeight }
    })
    console.log('focus geometry', JSON.stringify(dimensions))
    assert.ok(dimensions.head.x < 50 && dimensions.head.y < 160, 'selected avatar/name stays top-left')
    assert.ok(dimensions.record.height <= 100 && dimensions.record.x + dimensions.record.width <= dimensions.width, 'record stays compact')
    assert.ok(dimensions.replay.y + dimensions.replay.height <= dimensions.height, 'Replay remains visible')
  }
  const prior = await count('summary')
  await page.locator('.rec').click(); await page.waitForFunction(() => window.__calls.some(c => c[0] === 'record'))
  await page.evaluate(() => { window.__hnControl({ action: 'select_next' }); window.dispatchEvent(new Event('online')) })
  await deliver('alpha', 'session-2')
  assert.equal(await count('summary'), prior, 'late digest cannot speak during mic startup')
  assert.deepEqual(await page.evaluate(() => window.__calls.filter(c => c[0] === 'record')), [['record', 'ALPHA']])
  assert.equal(await page.locator('.back').isDisabled(), true)
  await page.evaluate(() => window.__hnStarted(true, '')); await page.waitForFunction(() => document.querySelector('.rec')?.textContent.includes('Stop'))
  await page.evaluate(() => window.__hnControl({ action: 'select_next' }))
  assert.equal(await page.locator('.focus-head strong').innerText(), 'ALPHA')
  await page.evaluate(() => window.__hnStopped('', 'audio/ogg'))
  await page.waitForFunction(() => !document.querySelector('.rec')?.textContent.includes('Stop'))
  assert.deepEqual(uploads, [], 'empty fixture never sends or makes a fake reply')
  assert.deepEqual(errors, [])
  console.log('PASS focus/back A-B-A; exact session + silent refresh/replay; missing/stale/mixed; all states/outage; 3 viewport sizes; NO_TEXT; mic-start target + late-summary cancellation')
} finally { await browser.close(); await new Promise(done => server.close(done)) }
