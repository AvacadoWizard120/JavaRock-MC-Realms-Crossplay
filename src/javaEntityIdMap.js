'use strict'

class JavaEntityIdMap {
  constructor (options = {}) {
    this.nextJavaEntityId = options.firstJavaEntityId || 1000
    this.javaToBedrock = new Map()
    this.bedrockToJava = new Map()
  }

  rememberBedrockEntity (bedrockRuntimeId, preferredJavaEntityId) {
    if (bedrockRuntimeId == null) return undefined
    const bedrockKey = String(bedrockRuntimeId)
    const existing = this.bedrockToJava.get(bedrockKey)
    if (existing != null) return existing

    const javaEntityId = preferredJavaEntityId ?? this.nextJavaEntityId++
    const javaKey = String(javaEntityId)
    this.bedrockToJava.set(bedrockKey, javaEntityId)
    this.javaToBedrock.set(javaKey, bedrockRuntimeId)
    return javaEntityId
  }

  forgetBedrockEntity (bedrockRuntimeId) {
    if (bedrockRuntimeId == null) return
    const bedrockKey = String(bedrockRuntimeId)
    const javaEntityId = this.bedrockToJava.get(bedrockKey)
    this.bedrockToJava.delete(bedrockKey)
    if (javaEntityId != null) this.javaToBedrock.delete(String(javaEntityId))
  }

  bedrockRuntimeIdForJavaEntityId (javaEntityId) {
    if (javaEntityId == null) return undefined
    return this.javaToBedrock.get(String(javaEntityId))
  }

  javaEntityIdForBedrockRuntimeId (bedrockRuntimeId) {
    if (bedrockRuntimeId == null) return undefined
    return this.bedrockToJava.get(String(bedrockRuntimeId))
  }

  summary () {
    return {
      mappedEntityCount: this.javaToBedrock.size,
      nextJavaEntityId: this.nextJavaEntityId
    }
  }
}

module.exports = {
  JavaEntityIdMap
}
