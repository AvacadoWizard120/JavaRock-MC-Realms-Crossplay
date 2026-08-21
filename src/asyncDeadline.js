'use strict'

class OperationTimeoutError extends Error {
  constructor (label, timeoutMs) {
    super(`${label} timed out after ${(timeoutMs / 1000).toFixed(1)}s.`)
    this.name = 'OperationTimeoutError'
    this.code = 'OPERATION_TIMEOUT'
    this.timeoutMs = timeoutMs
  }
}

async function withTimeout (operation, timeoutMs, label = 'Operation') {
  const duration = Number(timeoutMs)
  if (!Number.isFinite(duration) || duration <= 0) {
    return typeof operation === 'function' ? operation() : operation
  }

  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => typeof operation === 'function' ? operation() : operation),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new OperationTimeoutError(label, duration)), duration)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

module.exports = {
  OperationTimeoutError,
  withTimeout
}
