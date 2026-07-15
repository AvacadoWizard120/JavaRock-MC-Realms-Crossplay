'use strict'

const fs = require('fs')
const path = require('path')
const { safeStringify } = require('./safeStringify')

function isPlainObject (value) {
  return value != null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !Buffer.isBuffer(value)
}

function mergeInto (target, patch) {
  for (const [key, value] of Object.entries(patch || {})) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeInto(target[key], value)
    } else if (isPlainObject(value)) {
      target[key] = mergeInto({}, value)
    } else {
      target[key] = value
    }
  }
  return target
}

class BridgeRuntimeStatus {
  constructor (file) {
    this.file = file ? path.resolve(file) : undefined
    this.status = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      state: 'starting'
    }
    this.dynamicProviders = []

    if (this.file) {
      this.timer = setInterval(() => this.write(), 2000)
      this.write()
    }
  }

  set (patch) {
    mergeInto(this.status, patch)
    this.write()
  }

  event (name, patch = {}) {
    this.set({
      ...patch,
      lastEvent: {
        name,
        at: new Date().toISOString()
      }
    })
  }

  addDynamicProvider (provider) {
    if (typeof provider === 'function') this.dynamicProviders.push(provider)
  }

  snapshot () {
    const snapshot = {
      ...this.status,
      updatedAt: new Date().toISOString()
    }

    for (const provider of this.dynamicProviders) {
      try {
        mergeInto(snapshot, provider() || {})
      } catch (error) {
        mergeInto(snapshot, {
          statusWriter: {
            lastProviderError: error.message || String(error)
          }
        })
      }
    }

    return snapshot
  }

  write () {
    if (!this.file) return

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, `${safeStringify(this.snapshot(), 2)}\n`)
    } catch (error) {
      console.warn(`[bridge-status] Could not write ${this.file}: ${error.message || error}`)
    }
  }

  close (state = 'closed') {
    if (this.timer) clearInterval(this.timer)
    this.set({
      state,
      stoppedAt: new Date().toISOString()
    })
  }
}

function createBridgeRuntimeStatus (config) {
  return new BridgeRuntimeStatus(config.bridgeStatusFile)
}

module.exports = {
  BridgeRuntimeStatus,
  createBridgeRuntimeStatus,
  mergeInto
}
