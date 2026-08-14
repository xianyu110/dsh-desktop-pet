'use strict'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function normalizeDshUrl(value = 'http://127.0.0.1:3080') {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('DSH 地址必须使用 HTTP 或 HTTPS')
  if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error('DSH 地址必须指向本机')
  url.pathname = url.pathname.replace(/\/$/, '')
  url.search = ''
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function endpoint(base, path) {
  return `${normalizeDshUrl(base)}${path}`
}

function validateSnapshot(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.apiVersion !== 1) return null
  const activity = value.activity
  const pet = value.pet
  if (activity === null || typeof activity !== 'object') return null
  if (pet === null || typeof pet !== 'object') return null
  if (typeof activity.name !== 'string') return null
  return value
}

function displayState(snapshot, now = Date.now()) {
  if (snapshot === null) return 'sleep'
  const activity = snapshot.activity ?? {}
  if (activity.turnCompletedUntil > now) return 'celebrate'
  if (['welcome', 'celebrate', 'error', 'disappointed'].includes(activity.name) && activity.until > now) {
    return activity.name
  }
  if (activity.sessionWait === true) return 'wait'
  if (activity.sessionThink === true) return 'think'
  if (activity.name === 'working') return 'working'
  return 'idle'
}

module.exports = { endpoint, normalizeDshUrl, validateSnapshot, displayState }
