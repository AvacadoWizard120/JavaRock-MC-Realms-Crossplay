'use strict'

const path = require('path')

function loadNethernet () {
  try {
    return require('nethernet')
  } catch (rootError) {
    const vendorPath = path.resolve(__dirname, '..', '.vendor', 'nethernet', 'node_modules', 'nethernet')
    try {
      return require(vendorPath)
    } catch {
      const error = new Error([
        'Missing nethernet package.',
        'Run: npm run deps:nethernet',
        `Original require error: ${rootError.message}`
      ].join('\n'))
      error.cause = rootError
      throw error
    }
  }
}

async function main () {
  const { Client, Server } = loadNethernet()
  const payload = Buffer.from('bedrock-realm-bridge nethernet loopback')
  const server = new Server()
  const client = new Client(server.networkId, '127.0.0.1')

  server.setAdvertisement(Buffer.from('Bedrock Realm Bridge NetherNet loopback'))

  await server.listen()

  const timeout = setTimeout(() => {
    client.close('timeout')
    server.close('timeout')
    console.error('[nethernet-node] Timed out waiting for loopback data channel.')
    process.exit(1)
  }, 15000)

  server.once('openConnection', connection => {
    console.log(`[nethernet-node] Local server accepted connection ${connection.address}`)
    connection.send(payload)
  })

  client.once('connected', () => {
    console.log('[nethernet-node] Local client WebRTC connection established.')
  })

  client.once('encapsulated', buffer => {
    clearTimeout(timeout)
    const received = Buffer.from(buffer)
    if (!received.equals(payload)) {
      client.close('payload mismatch')
      server.close('payload mismatch')
      console.error(`[nethernet-node] Payload mismatch: ${received.toString()}`)
      process.exit(1)
    }
    console.log('[nethernet-node] Loopback payload received.')
    client.close('done')
    server.close('done')
    setTimeout(() => process.exit(0), 250)
  })

  client.connect()
}

main().catch(error => {
  console.error(error.stack || error.message || error)
  process.exit(1)
})
