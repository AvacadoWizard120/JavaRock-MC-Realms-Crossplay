'use strict'

function isUuidLike (value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim())
}

function explainKnownFatalError (error) {
  const message = String(error?.message || error || '')
  const hostname = String(error?.hostname || '')

  if (error?.code === 'ENOTFOUND' && isUuidLike(hostname)) {
    return [
      '[fatal] The Realm endpoint is a NetherNet session GUID, not a DNS hostname.',
      `[fatal] GUID returned by Realms: ${hostname}`,
      '[fatal] bedrock-protocol currently connects with RakNet. Modern Realms that return NetherNet GUIDs need a NetherNet/WebRTC transport instead.',
      '[fatal] This is not an Xbox login failure, not a Realm permission failure, and not a normal port-forwarding problem.'
    ].join('\n')
  }

  if (/NETHERNET_REALM_ENDPOINT/i.test(message)) {
    return message
  }

  if (/Port cannot be empty|ERR_SOCKET_BAD_PORT|Received type number \(NaN\)/i.test(message)) {
    return [
      '[fatal] The Realm returned an endpoint without a usable numeric RakNet port.',
      '[fatal] Run with DEBUG_REALM_ADDRESS=true to inspect the raw endpoint.'
    ].join('\n')
  }

  return null
}

function installFatalErrorHandlers () {
  function handle (error) {
    const explanation = explainKnownFatalError(error)
    if (explanation) {
      console.error(explanation)
      if (process.env.DEBUG_FATAL_STACK === 'true') console.error(error?.stack || error)
    } else {
      console.error(error?.stack || error?.message || error)
    }
    process.exit(1)
  }

  process.on('uncaughtException', handle)
  process.on('unhandledRejection', handle)
}

module.exports = {
  explainKnownFatalError,
  installFatalErrorHandlers,
  isUuidLike
}
