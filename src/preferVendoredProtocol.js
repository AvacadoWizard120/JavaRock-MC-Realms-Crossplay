'use strict'

const fs = require('fs')
const Module = require('module')
const path = require('path')

let installed = false
let resolverPatched = false

function vendorRequestToPath (vendorNodeModules, request) {
  if (request === 'bedrock-protocol' || request.startsWith('bedrock-protocol/')) {
    return path.join(vendorNodeModules, request)
  }
  if (request === 'minecraft-data' || request.startsWith('minecraft-data/')) {
    return path.join(vendorNodeModules, request)
  }
}

function installVendoredProtocolPath () {
  if (installed) return true

  const vendorNodeModules = path.resolve(__dirname, '..', 'vendor-node', 'node_modules')
  const bedrockPackage = path.join(vendorNodeModules, 'bedrock-protocol', 'package.json')
  const minecraftDataPackage = path.join(vendorNodeModules, 'minecraft-data', 'package.json')
  if (!fs.existsSync(bedrockPackage) || !fs.existsSync(minecraftDataPackage)) return false

  const current = (process.env.NODE_PATH || '')
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(Boolean)

  if (!current.some(entry => path.resolve(entry) === vendorNodeModules)) {
    process.env.NODE_PATH = [vendorNodeModules, ...current].join(path.delimiter)
    Module._initPaths()
  }

  if (!resolverPatched) {
    const originalResolveFilename = Module._resolveFilename
    Module._resolveFilename = function resolveVendoredProtocolFirst (request, parent, isMain, options) {
      const vendorPath = vendorRequestToPath(vendorNodeModules, request)
      if (vendorPath) {
        return originalResolveFilename.call(this, vendorPath, parent, isMain, options)
      }
      return originalResolveFilename.call(this, request, parent, isMain, options)
    }
    resolverPatched = true
  }

  installed = true
  return true
}

module.exports = {
  installVendoredProtocolPath
}
