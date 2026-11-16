import test from 'node:test'
import assert from 'node:assert/strict'
import { displayStatus, limitLabel } from './display.ts'

const longName = 'Agent with a deliberately long selected name'

test('host maxLabel bounds the entire recording and send status, not just the agent name', () => {
  const maxLabel = 18
  const recording = displayStatus(true, longName, 'previous status', maxLabel)
  const sent = displayStatus(false, longName, `sent → ${longName}`, maxLabel)
  const retry = displayStatus(false, longName, `sent → ${longName} (after a retry)`, maxLabel)
  assert.equal(recording, `Recording for ${longName}…`.slice(0, maxLabel))
  assert.equal(sent, `sent → ${longName}`.slice(0, maxLabel))
  assert.equal(retry, `sent → ${longName} (after a retry)`.slice(0, maxLabel))
  assert.ok([recording, sent, retry].every((line) => line.length <= maxLabel))
  assert.equal(limitLabel('5 thinking · 3 off-screen', maxLabel), '5 thinking · 3 off')
  assert.equal(limitLabel('pending upload', 0), 'pending upload', 'no host cap preserves parked copy')
  assert.equal(displayStatus(false, longName, `sent → ${longName}`, 0), `sent → ${longName}`)
})
