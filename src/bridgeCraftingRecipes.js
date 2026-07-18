'use strict'

const fs = require('fs')
const path = require('path')

function firstNonEmpty (...values) {
  return values.find(value => value != null && value !== '')
}

function numberOrDefault (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function normalizeStringArray (value) {
  return Array.isArray(value) ? value.map(entry => String(entry)) : []
}

function isTruthyProtocolFlag (value) {
  return value === true ||
    value === 'true' ||
    value === 1 ||
    value === 65535 ||
    value === '65535'
}

function normalizeItemExtraForLocalViaBedrock (extra) {
  const source = extra && typeof extra === 'object' ? extra : {}
  const hasNbt = isTruthyProtocolFlag(source.has_nbt) || source.nbt != null
  const out = {
    has_nbt: hasNbt ? 'true' : 'false',
    can_place_on: normalizeStringArray(source.can_place_on || source.canPlaceOn),
    can_destroy: normalizeStringArray(source.can_destroy || source.canDestroy)
  }
  if (hasNbt) {
    out.nbt = source.nbt && typeof source.nbt === 'object'
      ? source.nbt
      : { version: 1, nbt: source.nbt }
  }
  return out
}

function normalizeStackIdForLocalViaBedrock (item) {
  const raw = firstNonEmpty(item.stack_id, item.stackId, item.stack_network_id, item.stackNetworkId)
  if (raw && typeof raw === 'object') {
    return firstNonEmpty(raw.id, raw.stack_id, raw.stackId, raw.value, raw.empty === 0 ? undefined : raw.empty)
  }
  return raw
}

function normalizeHasStackIdForLocalViaBedrock (item, stackId) {
  if (item.has_stack_id != null) return isTruthyProtocolFlag(item.has_stack_id) ? 1 : 0
  if (item.hasStackId != null) return isTruthyProtocolFlag(item.hasStackId) ? 1 : 0
  return stackId != null && stackId !== '' ? 1 : 0
}

function normalizeItemForLocalViaBedrock (item) {
  if (!item || typeof item !== 'object') return { network_id: 0 }
  const networkId = firstNonEmpty(item.network_id, item.networkId, item.id, item.runtime_id, item.runtimeId)
  const parsedNetworkId = numberOrDefault(networkId, 0)
  if (parsedNetworkId === 0) return { network_id: 0 }
  const stackId = normalizeStackIdForLocalViaBedrock(item)
  const hasStackId = normalizeHasStackIdForLocalViaBedrock(item, stackId)
  const out = {
    ...item,
    network_id: parsedNetworkId,
    count: numberOrDefault(firstNonEmpty(item.count, item.amount), 1),
    metadata: numberOrDefault(firstNonEmpty(item.metadata, item.meta, item.damage), 0),
    has_stack_id: hasStackId,
    block_runtime_id: numberOrDefault(firstNonEmpty(item.block_runtime_id, item.blockRuntimeId, item.block_runtime, item.blockRuntime), 0),
    extra: normalizeItemExtraForLocalViaBedrock(item.extra)
  }
  if (hasStackId) out.stack_id = numberOrDefault(stackId, 1)
  else delete out.stack_id
  delete out.networkId
  delete out.stackId
  delete out.hasStackId
  delete out.blockRuntimeId
  delete out.stackNetworkId
  delete out.stack_network_id
  return out
}

function recipeIngredientToBridgeSpec (ingredient) {
  if (!ingredient || typeof ingredient !== 'object') return null
  const type = String(ingredient.type || '').toLowerCase()
  const count = Math.max(1, numberOrDefault(ingredient.count, 1))
  if (type === 'invalid' || count <= 0) return null
  if (type === 'item_tag') {
    const tag = ingredient.tag ? String(ingredient.tag) : ''
    return tag ? { kind: 'tag', tag, count } : null
  }

  const networkId = firstNonEmpty(ingredient.network_id, ingredient.networkId, ingredient.id)
  const parsedNetworkId = Number(networkId)
  if (!Number.isFinite(parsedNetworkId) || parsedNetworkId === 0) return null
  return {
    kind: 'item',
    network_id: parsedNetworkId,
    metadata: numberOrDefault(firstNonEmpty(ingredient.metadata, ingredient.meta, ingredient.damage), 32767),
    count
  }
}

function recipeResultToBridgeSpec (result) {
  const item = normalizeItemForLocalViaBedrock(result)
  if (!item || !item.network_id) return null
  return {
    network_id: item.network_id,
    metadata: numberOrDefault(item.metadata, 0),
    count: numberOrDefault(item.count, 1),
    block_runtime_id: numberOrDefault(item.block_runtime_id, 0)
  }
}

function recipeInputCell (cell) {
  if (Array.isArray(cell)) {
    const anyOf = cell.map(recipeIngredientToBridgeSpec).filter(Boolean)
    return anyOf.length ? { kind: 'any_of', any_of: anyOf } : null
  }
  return recipeIngredientToBridgeSpec(cell)
}

function ingredientRequiredCount (ingredient) {
  if (!ingredient) return 0
  if (ingredient.kind === 'any_of') return Math.max(...ingredient.any_of.map(value => value.count || 1))
  return ingredient.count || 1
}

function recipeBlockName (entry) {
  const recipe = entry?.recipe && typeof entry.recipe === 'object' ? entry.recipe : {}
  return String(firstNonEmpty(recipe.block, entry?.block, '') || '').toLowerCase()
}

function recipeNetworkId (entry, recipe = {}) {
  return numberOrDefault(firstNonEmpty(recipe.network_id, recipe.networkId, entry?.network_id, entry?.networkId), 0)
}

function isCraftingTableRecipe (entry) {
  return recipeBlockName(entry) === 'crafting_table'
}

function isFutureStationRecipe (entry) {
  const block = recipeBlockName(entry)
  return block !== '' && block !== 'crafting_table'
}

function normalizeShapedInputCell (input, x, y, width = 2, height = 2) {
  if (!Array.isArray(input)) return null

  // bedrock-protocol groups the flat row-major wire cells into width arrays of
  // height cells. Flatten that parser shape before mapping it onto Java's grid.
  const nestedCellCount = input.every(Array.isArray)
    ? input.reduce((count, group) => count + group.length, 0)
    : -1
  const cells = nestedCellCount === width * height ? input.flat() : input
  return cells[y * width + x]
}

function simplifyCraftingDataForBridgeGrid (params = {}, gridSize = 2) {
  const maxGridSize = gridSize === 3 ? 3 : 2
  const maxRequired = maxGridSize * maxGridSize
  const recipes = Array.isArray(params.recipes) ? params.recipes : []
  const out = []
  const seen = new Set()

  for (const entry of recipes) {
    if (!isCraftingTableRecipe(entry)) continue

    const entryType = String(entry?.type || '').toLowerCase()
    const recipe = entry?.recipe && typeof entry.recipe === 'object' ? entry.recipe : {}
    const outputList = Array.isArray(recipe.output) ? recipe.output : (recipe.result ? [recipe.result] : [])
    const output = recipeResultToBridgeSpec(outputList[0])
    if (!output) continue

    if (entryType === 'shaped') {
      const width = numberOrDefault(recipe.width, 0)
      const height = numberOrDefault(recipe.height, 0)
      if (width < 1 || height < 1 || width > maxGridSize || height > maxGridSize) continue
      const input = Array.isArray(recipe.input) ? recipe.input : []
      const pattern = []
      let required = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const cell = recipeInputCell(normalizeShapedInputCell(input, x, y, width, height))
          pattern.push(cell)
          required += ingredientRequiredCount(cell)
        }
      }
      if (required < 1 || required > maxRequired) continue
      const simplified = {
        type: 'shaped',
        recipe_id: String(recipe.recipe_id || recipe.uuid || `shaped_${out.length}`),
        network_id: recipeNetworkId(entry, recipe),
        width,
        height,
        pattern,
        output
      }
      const key = JSON.stringify(simplified)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(simplified)
      }
      continue
    }

    if (entryType === 'shapeless' || entryType === 'shulker_box') {
      const input = Array.isArray(recipe.input) ? recipe.input.map(recipeInputCell).filter(Boolean) : []
      const required = input.reduce((sum, ingredient) => sum + ingredientRequiredCount(ingredient), 0)
      if (input.length < 1 || required < 1 || required > maxRequired) continue
      const simplified = {
        type: 'shapeless',
        recipe_id: String(recipe.recipe_id || recipe.uuid || `${entryType}_${out.length}`),
        network_id: recipeNetworkId(entry, recipe),
        ingredients: input,
        output
      }
      const key = JSON.stringify(simplified)
      if (!seen.has(key)) {
        seen.add(key)
        out.push(simplified)
      }
    }
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'bedrock crafting_data packet',
    note: `Simplified crafting_table shaped/shapeless recipes that fit a ${maxGridSize}x${maxGridSize} crafting grid. Furnace/smelting/stonecutter/etc. recipes are excluded and preserved separately in bridge-station-recipes-future.json.`,
    recipe_count: out.length,
    recipes: out
  }
}

function simplifyCraftingDataForBridge2x2 (params = {}) {
  return simplifyCraftingDataForBridgeGrid(params, 2)
}

function simplifyCraftingDataForBridge3x3 (params = {}) {
  return simplifyCraftingDataForBridgeGrid(params, 3)
}

function isRecipeBookCraftingRecipe (entry) {
  const type = String(entry?.type || '').toLowerCase()
  if (type !== 'shaped' && type !== 'shapeless' && type !== 'shulker_box') return false
  const block = recipeBlockName(entry)
  return block === 'crafting_table' || block === 'deprecated'
}

function simplifyCraftingDataForRecipeBook (params = {}) {
  const recipes = Array.isArray(params.recipes) ? params.recipes : []
  const out = []
  const seen = new Set()

  for (const entry of recipes) {
    if (!isRecipeBookCraftingRecipe(entry)) continue

    const entryType = String(entry?.type || '').toLowerCase()
    const recipe = entry?.recipe && typeof entry.recipe === 'object' ? entry.recipe : {}
    const outputList = Array.isArray(recipe.output) ? recipe.output : (recipe.result ? [recipe.result] : [])
    const output = recipeResultToBridgeSpec(outputList[0])
    if (!output) continue

    const recipeId = String(recipe.recipe_id || recipe.uuid || `${entryType}_${out.length}`)
    let simplified = null
    if (entryType === 'shaped') {
      const width = numberOrDefault(recipe.width, 0)
      const height = numberOrDefault(recipe.height, 0)
      if (width < 1 || height < 1 || width > 3 || height > 3) continue
      const input = Array.isArray(recipe.input) ? recipe.input : []
      const pattern = []
      let occupied = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const cell = recipeInputCell(normalizeShapedInputCell(input, x, y, width, height))
          pattern.push(cell)
          if (cell) occupied++
        }
      }
      if (!occupied) continue
      simplified = {
        type: 'shaped',
        recipe_id: recipeId,
        network_id: recipeNetworkId(entry, recipe),
        width,
        height,
        pattern,
        output
      }
    } else {
      const ingredients = Array.isArray(recipe.input)
        ? recipe.input.map(recipeInputCell).filter(Boolean)
        : []
      if (!ingredients.length) continue
      simplified = {
        type: 'shapeless',
        recipe_id: recipeId,
        network_id: recipeNetworkId(entry, recipe),
        ingredients,
        output
      }
    }

    const duplicateKey = JSON.stringify({
      type: simplified.type,
      recipe_id: simplified.recipe_id,
      width: simplified.width,
      height: simplified.height,
      pattern: simplified.pattern,
      ingredients: simplified.ingredients,
      output: simplified.output
    })
    if (seen.has(duplicateKey)) continue
    seen.add(duplicateKey)
    simplified.display_id = out.length
    out.push(simplified)
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'bedrock crafting_data and unlocked_recipes packets',
    unlock_state_ready: false,
    last_unlock_type: 'empty',
    unlocked_recipe_ids: [],
    recipe_count: out.length,
    recipes: out
  }
}

function simplifyFutureStationRecipesForBridge (params = {}) {
  const recipes = Array.isArray(params.recipes) ? params.recipes : []
  const out = []

  for (const entry of recipes) {
    if (!isFutureStationRecipe(entry)) continue
    const recipe = entry?.recipe && typeof entry.recipe === 'object' ? entry.recipe : {}
    const recipeId = String(recipe.recipe_id || recipe.uuid || `${entry.type || 'station'}_${out.length}`)
    const block = recipeBlockName(entry)
    const outputList = Array.isArray(recipe.output) ? recipe.output : (recipe.result ? [recipe.result] : [])
    const output = recipeResultToBridgeSpec(outputList[0])
    const input = Array.isArray(recipe.input)
      ? recipe.input.map(recipeInputCell).filter(Boolean)
      : []
    out.push({
      type: String(entry?.type || '').toLowerCase(),
      station: block,
      recipe_id: recipeId,
      input,
      output,
      priority: recipe.priority,
      network_id: recipe.network_id
    })
  }

  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source: 'bedrock crafting_data packet',
    note: 'Non-crafting-table station recipes preserved for future bridge features such as furnace/smoker/blast-furnace/campfire smelting. This file is intentionally not loaded by the Java player 2x2 crafting grid.',
    recipe_count: out.length,
    recipes: out
  }
}

function writeJsonTargetsIfChanged (targets, value) {
  const json = `${JSON.stringify(value, null, 2)}\n`
  for (const target of targets) {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    let old = null
    try { old = fs.readFileSync(target, 'utf8') } catch {}
    if (old !== json) fs.writeFileSync(target, json)
  }
}

function recipeBookTargets (projectRoot, runDir) {
  return [
    path.join(runDir, 'bridge-recipe-book.json'),
    path.join(projectRoot, 'bridge-recipe-book.json')
  ]
}

function normalizeUnlockType (value) {
  const names = ['empty', 'initially_unlocked', 'newly_unlocked', 'remove_unlocked', 'remove_all_unlocked']
  if (Number.isInteger(Number(value))) return names[Number(value)] || 'empty'
  const normalized = String(value || '').toLowerCase()
  return names.includes(normalized) ? normalized : 'empty'
}

function applyBridgeUnlockedRecipesForViaProxy (projectRoot, runDir, params = {}) {
  const targets = recipeBookTargets(projectRoot, runDir)
  const unlockType = normalizeUnlockType(params.unlock_type ?? params.unlockType)
  const incoming = Array.isArray(params.recipes) ? params.recipes.map(String) : []
  let written = false
  let unlockedRecipeCount = 0

  for (const target of targets) {
    if (!fs.existsSync(target)) continue
    let db
    try {
      db = JSON.parse(fs.readFileSync(target, 'utf8'))
    } catch {
      continue
    }

    const unlocked = new Set(Array.isArray(db.unlocked_recipe_ids) ? db.unlocked_recipe_ids.map(String) : [])
    if (unlockType === 'initially_unlocked') {
      unlocked.clear()
      for (const recipeId of incoming) unlocked.add(recipeId)
    } else if (unlockType === 'newly_unlocked') {
      for (const recipeId of incoming) unlocked.add(recipeId)
    } else if (unlockType === 'remove_unlocked') {
      for (const recipeId of incoming) unlocked.delete(recipeId)
    } else if (unlockType === 'remove_all_unlocked') {
      unlocked.clear()
    } else {
      continue
    }

    db.unlock_state_ready = true
    db.last_unlock_type = unlockType
    db.unlock_updated_at = new Date().toISOString()
    db.unlocked_recipe_ids = [...unlocked].sort()
    writeJsonTargetsIfChanged([target], db)
    written = true
    unlockedRecipeCount = Math.max(unlockedRecipeCount, unlocked.size)
  }

  return { written, unlockType, unlockedRecipeCount, targets: written ? targets : [] }
}

function writeBridgeCraftingRecipesForViaProxy (projectRoot, runDir, params = {}) {
  const db = simplifyCraftingDataForBridge2x2(params)
  const craftingTableDb = simplifyCraftingDataForBridge3x3(params)
  const stationDb = simplifyFutureStationRecipesForBridge(params)
  const recipeBookDb = simplifyCraftingDataForRecipeBook(params)
  const targets = [
    path.join(runDir, 'bridge-crafting-recipes-2x2.json'),
    path.join(projectRoot, 'bridge-crafting-recipes-2x2.json')
  ]
  const craftingTableTargets = [
    path.join(runDir, 'bridge-crafting-recipes-3x3.json'),
    path.join(projectRoot, 'bridge-crafting-recipes-3x3.json')
  ]
  const stationTargets = [
    path.join(runDir, 'bridge-station-recipes-future.json'),
    path.join(projectRoot, 'bridge-station-recipes-future.json')
  ]
  const bookTargets = recipeBookTargets(projectRoot, runDir)

  if (stationDb.recipes.length) writeJsonTargetsIfChanged(stationTargets, stationDb)
  // Always replace the session catalog, including with an empty one. Leaving an
  // older account's ready catalog behind would expose stale recipe-book state.
  writeJsonTargetsIfChanged(bookTargets, recipeBookDb)
  if (craftingTableDb.recipes.length) writeJsonTargetsIfChanged(craftingTableTargets, craftingTableDb)
  if (!db.recipes.length) {
    return {
      written: false,
      recipeCount: 0,
      targets: [],
      craftingTableRecipeCount: craftingTableDb.recipes.length,
      craftingTableTargets: craftingTableDb.recipes.length ? craftingTableTargets : [],
      stationRecipeCount: stationDb.recipes.length,
      stationTargets: stationDb.recipes.length ? stationTargets : [],
      recipeBookCount: recipeBookDb.recipes.length,
      recipeBookTargets: bookTargets
    }
  }

  writeJsonTargetsIfChanged(targets, db)
  return {
    written: true,
    recipeCount: db.recipes.length,
    targets,
    craftingTableRecipeCount: craftingTableDb.recipes.length,
    craftingTableTargets: craftingTableDb.recipes.length ? craftingTableTargets : [],
    stationRecipeCount: stationDb.recipes.length,
    stationTargets: stationDb.recipes.length ? stationTargets : [],
    recipeBookCount: recipeBookDb.recipes.length,
    recipeBookTargets: bookTargets
  }
}

module.exports = {
  simplifyCraftingDataForBridge2x2,
  simplifyCraftingDataForBridge3x3,
  simplifyCraftingDataForRecipeBook,
  simplifyFutureStationRecipesForBridge,
  writeBridgeCraftingRecipesForViaProxy,
  applyBridgeUnlockedRecipesForViaProxy,
  recipeIngredientToBridgeSpec,
  recipeResultToBridgeSpec,
  recipeBlockName,
  recipeNetworkId,
  isCraftingTableRecipe,
  isRecipeBookCraftingRecipe
}
