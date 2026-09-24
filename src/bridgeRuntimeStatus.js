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

function stopRequestFileForStatus (file, pid = process.pid) {
  if (!file) return undefined
  return `${path.resolve(file)}.stop.${Number(pid)}`
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
    this.closed = false
    this.stopRequestHandler = null
    this.stopRequestHandling = false
    this.stopRequestFile = stopRequestFileForStatus(this.file)

    if (this.file) {
      try {
        fs.unlinkSync(this.stopRequestFile)
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`[bridge-status] Could not remove stale stop request ${this.stopRequestFile}: ${error.message || error}`)
      }
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

  onStopRequested (handler) {
    if (typeof handler !== 'function') return false
    this.stopRequestHandler = handler
    if (!this.stopRequestFile || this.closed) return false
    if (!this.stopRequestTimer) {
      this.stopRequestTimer = setInterval(() => this.checkStopRequest(), 100)
    }
    this.checkStopRequest()
    return true
  }

  checkStopRequest () {
    if (this.closed || this.stopRequestHandling || !this.stopRequestHandler || !this.stopRequestFile) return false
    if (!fs.existsSync(this.stopRequestFile)) return false

    this.stopRequestHandling = true
    try {
      fs.unlinkSync(this.stopRequestFile)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.stopRequestHandling = false
        console.warn(`[bridge-status] Could not consume stop request ${this.stopRequestFile}: ${error.message || error}`)
        return false
      }
    }

    this.event('launcher_stop_requested', { state: 'stopping' })
    try {
      const result = this.stopRequestHandler()
      Promise.resolve(result).catch(error => {
        console.error(`[bridge-status] Graceful stop failed: ${error.stack || error.message || error}`)
      })
    } catch (error) {
      console.error(`[bridge-status] Graceful stop failed: ${error.stack || error.message || error}`)
    }
    return true
  }

  close (state = 'closed') {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    if (this.stopRequestTimer) clearInterval(this.stopRequestTimer)
    this.timer = null
    this.stopRequestTimer = null
    if (this.stopRequestFile) {
      try {
        fs.unlinkSync(this.stopRequestFile)
      } catch (error) {
        if (error?.code !== 'ENOENT') console.warn(`[bridge-status] Could not remove ${this.stopRequestFile}: ${error.message || error}`)
      }
    }
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
  mergeInto,
  stopRequestFileForStatus
}
