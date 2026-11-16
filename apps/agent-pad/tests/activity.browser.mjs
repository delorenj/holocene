// Optional browser regression for the built pad. No production calls or running services are used.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright-core/index.mjs CHROMIUM_PATH=/path/to/non-snap/chromium node apps/agent-pad/tests/activity.browser.mjs
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright-core')
const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const server = createServer(async (req, res) => {
  try {
    const path = resolve(dist, `.${new URL(req.url, 'http://localhost').pathname === '/' ? '/index.html' : req.url}`)
    if (!path.startsWith(dist)) { res.writeHead(403).end(); return }
    const body = await readFile(path)
    res.writeHead(200, { 'content-type': extname(path) === '.js' ? 'text/javascript' : 'text/html' }).end(body)
  } catch { res.writeHead(404).end() }
})
await new Promise((done) => server.listen(0, '127.0.0.1', done))
const base = `http://127.0.0.1:${server.address().port}`
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/snap/bin/chromium', headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const agents = Array.from({ length: 40 }, (_, i) => ({ id: `a${String(i).padStart(2, '0')}`, name: `Agent ${i}`, color: '#4f8cff' }))
const roster = { generated_at: new Date().toISOString(), agents }
let working = []
let available = false
const errors = []
const page = await context.newPage()
page.on('pageerror', (error) => errors.push(error.message))
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname === '/api/pad/activity') {
    if (!available) { await route.fulfill({ status: 503, body: '{}' }); return }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { date: new Date().toUTCString(), 'cache-control': 'no-store' },
      body: JSON.stringify({ generatedAt: new Date().toISOString(),
        sources: [{ name: 'events', ageSeconds: 0, maxSeconds: 120 }, { name: 'asm' }, { name: 'agents registry' }, { name: 'pjangler' }],
        agents: working.map((id, i) => ({ id, signal: 'working', lastWorkAt: new Date(Date.now() - i).toISOString() })) }) })
  } else if (url.pathname === '/roster/roster.json') {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(roster) })
  } else if (url.pathname.startsWith('/upload')) {
    await route.fulfill({ status: 503, body: '{}' })
  } else if (url.origin !== base) {
    // The real app has S3 reply polling. An empty test listing prevents any remote request or playback.
    await route.fulfill({ contentType: 'application/xml', body: '<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>' })
  } else await route.continue()
})
await page.addInitScript((roster) => {
  localStorage.setItem('agentpad.roster', JSON.stringify(roster))
  localStorage.setItem('agentpad.agent', 'a39')
  window.__scrollCalls = 0
  const original = Element.prototype.scrollIntoView
  Element.prototype.scrollIntoView = function (...args) { window.__scrollCalls++; return original.apply(this, args) }
}, roster)
const refresh = async () => {
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}
const status = async (text) => page.waitForFunction((text) => document.querySelector('.fleet-status')?.textContent === text, text)
const scroll = async (bottom) => page.evaluate((bottom) => {
  const root = document.querySelector('.tiles')
  root.scrollTop = bottom ? root.scrollHeight : 0
  root.dispatchEvent(new Event('scroll'))
}, bottom)
const cues = async () => page.locator('.thinking-label').evaluateAll((labels) => labels.map((label) => {
  const bounds = label.getBoundingClientRect(), viewport = label.closest('.tiles').getBoundingClientRect()
  return { animation: getComputedStyle(label).animationName, label: label.textContent,
    visible: bounds.top >= viewport.top && bounds.bottom <= viewport.bottom && bounds.top >= 0 && bounds.bottom <= innerHeight }
}))
try {
  await page.goto(base)
  await page.waitForFunction(() => document.querySelectorAll('.tile').length === 40)
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'a39')
  assert.equal(await page.evaluate(() => document.querySelector('.tiles').scrollTop), 0)
  assert.ok(await page.locator('.tiles').evaluate((el) => el.clientHeight <= 424), '400 px max-height plus tile padding')

  available = true; working = ['a12', 'a13', 'a14']; await refresh()
  await status('3 thinking')
  assert.deepEqual(await page.locator('.tile').evaluateAll((tiles) => tiles.slice(0, 3).map((el) => el.dataset.agent)), working)
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'a39')
  assert.equal(await page.evaluate(() => window.__scrollCalls), 0, 'saved selection and activity must never scroll')
  assert.deepEqual(await cues(), Array.from({ length: 3 }, () => ({ animation: 'thinking-pulse', label: 'Thinking', visible: true })))
  console.log('PASS saved far-down selection + 3 leading visible parked pulses, no automatic scroll')

  await scroll(true); await status('3 thinking · 3 off-screen')
  await scroll(false); await status('3 thinking')
  await page.evaluate(() => window.__hnControl({ action: 'select_prev' }))
  await page.waitForFunction(() => window.__scrollCalls === 1)
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'a38')
  await scroll(false)
  working = ['a08', 'a09', 'a10']; await refresh(); await status('3 thinking')
  await page.waitForFunction(() => document.querySelector('.tile').dataset.agent === 'a08')
  assert.equal(await page.evaluate(() => window.__scrollCalls), 1, 'activity reorder after explicit choice must not repeat scroll')
  assert.equal(await page.evaluate(() => document.querySelector('.tiles').scrollTop), 0)
  console.log('PASS manual scroll gives truthful hidden count; only explicit selection scrolls')

  await page.setViewportSize({ width: 1280, height: 720 })
  await page.evaluate(() => window.__hnHost({ driving: true, maxItems: 5 }))
  await status('3 thinking')
  assert.equal(await page.locator('.tile').count(), 5)
  assert.deepEqual(await cues(), Array.from({ length: 3 }, () => ({ animation: 'thinking-pulse', label: 'Thinking', visible: true })))
  // Exercise the real cascade without playing audio or beginning a recording.
  const otherAnimations = await page.evaluate(() => {
    const tile = document.querySelector('.tile'); tile.classList.add('speaking')
    const dot = document.createElement('span'); dot.className = 'dot'; document.querySelector('.rec').append(dot)
    return [getComputedStyle(tile).animationName, getComputedStyle(tile.querySelector('.swatch')).animationName, getComputedStyle(dot).animationName]
  })
  assert.deepEqual(otherAnimations, ['none', 'none', 'none'])
  await page.emulateMedia({ reducedMotion: 'reduce' })
  assert.ok((await cues()).every((cue) => cue.animation === 'none' && cue.label === 'Thinking' && cue.visible))
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  console.log('PASS all 3 driving thinking cues pulse; reply/record remain still; reduced-motion labels remain static')

  working = ['a08', 'a10']; await refresh(); await status('2 thinking')
  assert.equal(await page.locator('.tile.thinking').count(), 2)
  assert.ok((await cues()).every((cue) => cue.animation === 'thinking-pulse'))
  working = []; await refresh(); await status('0 thinking')
  assert.equal(await page.locator('.thinking-label').count(), 0, 'all settled removes all thinking cues')
  working = agents.slice(0, 7).map((a) => a.id); await refresh()
  await page.evaluate(() => window.__hnHost({ driving: true, maxItems: 3 }))
  await status('7 thinking · 5 off-screen')
  assert.equal(await page.locator('.tile').count(), 3)
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'a38')
  assert.equal((await cues()).filter((cue) => cue.visible).length, 2)
  console.log('PASS independent settle and strict host cap with selected slot + truthful 5 hidden workers')

  await page.evaluate(() => window.__hnHost({ driving: false, noVideo: true }))
  assert.ok((await cues()).every((cue) => cue.animation === 'none'), 'non-driving noVideo still bans all motion')
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await status('Thinking status unknown')
  assert.equal(await page.locator('.thinking-label').count(), 0)
  assert.equal(await page.locator('.tile[aria-checked=true]').getAttribute('data-agent'), 'a38')
  assert.deepEqual(errors, [])
  console.log('PASS non-driving noVideo ban preserved; offline clears every pulse and preserves target')
} finally {
  await browser.close()
  await new Promise((done) => server.close(done))
}
