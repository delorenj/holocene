import test from 'node:test'
import assert from 'node:assert/strict'
import { isSilent, meter01, normCapture, silenceAction, toDb } from './capture.ts'

const silent = { peak_dbfs: -72.2, rms_dbfs: -80 }
const speech = { peak_dbfs: -10, rms_dbfs: -19 }

test('parked and silent: the recording is held back for "send anyway"', () => {
  assert.equal(silenceAction(silent, false), 'hold')
})

test('driving and silent: never held back, uploaded as advisory (the driving layout has no escape hatch)', () => {
  assert.equal(silenceAction(silent, true), 'advisory')
})

test('audible or unknown levels always send, parked or driving', () => {
  for (const driving of [false, true]) {
    assert.equal(silenceAction(speech, driving), 'send')
    assert.equal(silenceAction(undefined, driving), 'send') // old host / suspended analyser: unknown is not silent
  }
})

test('the -60 dBFS line is exclusive', () => {
  assert.equal(isSilent({ peak_dbfs: -60, rms_dbfs: -70 }), false)
  assert.equal(isSilent({ peak_dbfs: -60.1, rms_dbfs: -70 }), true)
})

test('normCapture rejects junk and rounds', () => {
  assert.equal(normCapture(null, 'native'), undefined)
  assert.equal(normCapture({ peak_dbfs: 'x', rms_dbfs: 1 }, 'native'), undefined)
  assert.equal(normCapture({ peak_dbfs: -Infinity, rms_dbfs: -1 }, 'native'), undefined)
  assert.deepEqual(normCapture({ peak_dbfs: -10.04, rms_dbfs: -19.06, samples: 3 }, 'native'), { peak_dbfs: -10, rms_dbfs: -19.1, samples: 3, source: 'native', sent_anyway: undefined })
})

test('level math: floor, full scale and meter range', () => {
  assert.equal(toDb(0), -96)
  assert.equal(toDb(1), 0)
  assert.equal(meter01(-60), 0)
  assert.equal(meter01(0), 1)
})

test('a blip too short to judge is sent, not called digital silence', () => {
  assert.equal(silenceAction({ ...silent, samples: 2 }, false), 'send')
  assert.equal(silenceAction({ ...silent, samples: 5 }, false), 'hold')
  assert.equal(silenceAction({ ...silent, samples: 60 }, false), 'hold')
})
