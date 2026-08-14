'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { endpoint, normalizeDshUrl, validateSnapshot, displayState } = require('../src/shared.cjs')

const snapshot = activity => ({ apiVersion: 1, pet: { level: 1 }, activity })

test('accepts loopback DSH URLs and rejects remote hosts', () => {
  assert.equal(normalizeDshUrl('http://127.0.0.1:3080/'), 'http://127.0.0.1:3080')
  assert.equal(endpoint('http://localhost:3080', '/whale-girl/state'), 'http://localhost:3080/whale-girl/state')
  assert.throws(() => normalizeDshUrl('https://example.com'), /本机/)
  assert.throws(() => normalizeDshUrl('file:///tmp/dsh'), /HTTP/)
})

test('validates whale-girl snapshot API version and required surfaces', () => {
  assert.deepEqual(validateSnapshot(snapshot({ name: 'idle' })), snapshot({ name: 'idle' }))
  assert.equal(validateSnapshot({ apiVersion: 2, pet: {}, activity: { name: 'idle' } }), null)
  assert.equal(validateSnapshot({ apiVersion: 1, pet: {}, activity: {} }), null)
})

test('maps aggregate state with attention states taking priority', () => {
  assert.equal(displayState(null, 1000), 'sleep')
  assert.equal(displayState(snapshot({ name: 'idle', sessionThink: true }), 1000), 'think')
  assert.equal(displayState(snapshot({ name: 'idle', sessionThink: true, sessionWait: true }), 1000), 'wait')
  assert.equal(displayState(snapshot({ name: 'idle', turnCompletedUntil: 2000 }), 1000), 'celebrate')
  assert.equal(displayState(snapshot({ name: 'error', until: 2000 }), 1000), 'error')
  assert.equal(displayState(snapshot({ name: 'error', until: 500 }), 1000), 'idle')
})
