'use strict'

function safeStringify (value, space = 2) {
  const seen = new WeakSet()

  return JSON.stringify(value, (key, val) => {
    if (typeof val === 'bigint') return val.toString()

    if (Buffer.isBuffer(val)) {
      return {
        type: 'Buffer',
        length: val.length,
        previewHex: val.toString('hex').slice(0, 128)
      }
    }

    if (ArrayBuffer.isView(val) && !(val instanceof DataView)) {
      const buffer = Buffer.from(val.buffer, val.byteOffset, val.byteLength)
      return {
        type: val.constructor.name,
        length: val.byteLength,
        previewHex: buffer.toString('hex').slice(0, 128)
      }
    }

    if (val && typeof val === 'object') {
      if (seen.has(val)) return '[Circular]'
      seen.add(val)
    }

    return val
  }, space)
}

module.exports = { safeStringify }
