'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  simplifyCraftingDataForBridge2x2,
  simplifyCraftingDataForBridge3x3,
  simplifyCraftingDataForRecipeBook,
  simplifyFutureStationRecipesForBridge,
  writeBridgeCraftingRecipesForViaProxy,
  applyBridgeUnlockedRecipesForViaProxy
} = require('../src/bridgeCraftingRecipes')

function recipeIds (db) {
  return new Set((db.recipes || []).map(recipe => recipe.recipe_id))
}

const samplePath = path.join(__dirname, '..', 'packet-census', 'samples', '20260601081059-c37bf8-realm_to_bridge-crafting_data-0d43f3d70d2454d7.json')
if (fs.existsSync(samplePath)) {
  const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8')).packet
  const db = simplifyCraftingDataForBridge2x2(sample)
  const craftingTableDb = simplifyCraftingDataForBridge3x3(sample)
  const recipeBookDb = simplifyCraftingDataForRecipeBook(sample)
  const stationDb = simplifyFutureStationRecipesForBridge(sample)
  const ids = recipeIds(db)
  const stationIds = recipeIds(stationDb)

  if (db.recipe_count < 100) throw new Error(`expected broad live 2x2 crafting_table recipe export, got only ${db.recipe_count}`)
  if (craftingTableDb.recipe_count <= db.recipe_count) throw new Error('3x3 crafting-table export should include recipes that do not fit the player grid')
  if (!craftingTableDb.recipes.some(recipe => recipe.type === 'shaped' && (recipe.width === 3 || recipe.height === 3))) {
    throw new Error('3x3 crafting-table export did not preserve any 3-wide or 3-high recipes')
  }
  if (recipeBookDb.recipe_count <= db.recipe_count) throw new Error('full recipe-book export should include recipes that do not fit the player 2x2 grid')
  if (!recipeBookDb.recipes.some(recipe => recipe.type === 'shaped' && (recipe.width === 3 || recipe.height === 3))) {
    throw new Error('full recipe-book export did not preserve any 3-wide or 3-high crafting recipes')
  }
  if (recipeBookDb.unlock_state_ready !== false || recipeBookDb.unlocked_recipe_ids.length !== 0) {
    throw new Error('a fresh crafting_data catalog must wait for this session\'s unlocked_recipes packet')
  }
  const hasShaped = db.recipes.some(recipe => recipe.type === 'shaped' && recipe.width <= 2 && recipe.height <= 2)
  const hasShapeless = db.recipes.some(recipe => recipe.type === 'shapeless')
  const hasTag = db.recipes.some(recipe => JSON.stringify(recipe).includes('minecraft:planks'))
  if (!hasShaped) throw new Error('recipe DB did not include any shaped 2x2 recipes')
  if (!hasShapeless) throw new Error('recipe DB did not include any shapeless 2x2 recipes')
  if (!hasTag) throw new Error('recipe DB did not preserve item-tag ingredients such as minecraft:planks')

  if (ids.has('minecraft:furnace_log_oak')) throw new Error('furnace_log_oak leaked into the player 2x2 crafting DB')
  if (!stationIds.has('minecraft:furnace_log_oak')) throw new Error('furnace_log_oak was not preserved in the future station recipe DB')
  if (!ids.has('minecraft:stick')) throw new Error('minecraft:stick should remain in the 2x2 crafting_table recipe DB')
  if (!ids.has('minecraft:dark_oak_planks')) throw new Error('a log/stem -> planks crafting_table recipe should remain in the 2x2 DB')
  if (stationDb.recipe_count < 100) throw new Error(`expected future station recipe preservation, got only ${stationDb.recipe_count}`)
  if (db.recipes.some(recipe => recipe.station && recipe.station !== 'crafting_table')) {
    throw new Error('non-crafting-table station recipe leaked into 2x2 DB')
  }
}

const tinyPacket = {
  recipes: [
    {
      type: 'shaped',
      recipe: {
        recipe_id: 'minecraft:test_2x2_shaped',
        network_id: 101,
        block: 'crafting_table',
        width: 2,
        height: 2,
        input: [
          [
            { type: 'int_id_meta', network_id: 1, metadata: 32767, count: 1 },
            { type: 'invalid', count: 0 }
          ],
          [
            { type: 'item_tag', tag: 'minecraft:planks', count: 1 },
            { type: 'int_id_meta', network_id: 2, metadata: 0, count: 1 }
          ]
        ],
        output: [{ network_id: 3, count: 1, metadata: 0, block_runtime_id: 44 }]
      }
    },
    {
      type: 'shaped',
      recipe: {
        recipe_id: 'minecraft:test_vertical_sticks_shape',
        network_id: 102,
        block: 'crafting_table',
        width: 1,
        height: 2,
        input: [
          [
            { type: 'item_tag', tag: 'minecraft:planks', count: 1 },
            { type: 'item_tag', tag: 'minecraft:planks', count: 1 }
          ]
        ],
        output: [{ network_id: 352, count: 4, metadata: 0, block_runtime_id: 0 }]
      }
    },
    {
      type: 'shapeless',
      recipe: {
        recipe_id: 'minecraft:test_shapeless',
        network_id: 103,
        block: 'crafting_table',
        input: [
          { type: 'int_id_meta', network_id: 4, metadata: 32767, count: 1 },
          { type: 'int_id_meta', network_id: 5, metadata: 32767, count: 1 }
        ],
        output: [{ network_id: 6, count: 2, metadata: 0, block_runtime_id: 0 }]
      }
    },
    {
      type: 'shapeless',
      recipe: {
        recipe_id: 'minecraft:furnace_log_oak',
        block: 'furnace',
        input: [
          { type: 'int_id_meta', network_id: 17, metadata: 0, count: 1 }
        ],
        output: [{ network_id: 334, count: 1, metadata: 0, block_runtime_id: 0 }]
      }
    },
    {
      type: 'shapeless',
      recipe: {
        recipe_id: 'minecraft:test_stonecutter',
        block: 'stonecutter',
        input: [
          { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 }
        ],
        output: [{ network_id: 7, count: 1 }]
      }
    },
    {
      type: 'shaped',
      recipe: {
        recipe_id: 'minecraft:too_large',
        network_id: 104,
        block: 'crafting_table',
        width: 3,
        height: 3,
        input: [
          [
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 },
            { type: 'invalid', count: 0 },
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 }
          ],
          [
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 },
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 },
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 }
          ],
          [
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 },
            { type: 'invalid', count: 0 },
            { type: 'int_id_meta', network_id: 1, metadata: 0, count: 1 }
          ]
        ],
        output: [{ network_id: 8, count: 1 }]
      }
    },
    {
      type: 'shapeless',
      recipe: {
        recipe_id: 'minecraft:deprecated_old_recipe',
        block: 'deprecated',
        input: [
          { type: 'int_id_meta', network_id: 9, metadata: 0, count: 1 }
        ],
        output: [{ network_id: 10, count: 1 }]
      }
    }
  ]
}

const db = simplifyCraftingDataForBridge2x2(tinyPacket)
const craftingTableDb = simplifyCraftingDataForBridge3x3(tinyPacket)
const recipeBookDb = simplifyCraftingDataForRecipeBook(tinyPacket)
const stationDb = simplifyFutureStationRecipesForBridge(tinyPacket)
const tinyIds = recipeIds(db)
const tinyStationIds = recipeIds(stationDb)
if (db.recipe_count !== 3) throw new Error(`expected exactly 3 tiny crafting_table 2x2 recipes, got ${db.recipe_count}`)
if (craftingTableDb.recipe_count !== 4) throw new Error(`expected exactly 4 tiny crafting-table recipes, got ${craftingTableDb.recipe_count}`)
if (recipeBookDb.recipe_count !== 4) throw new Error(`expected 4 executable tiny crafting recipe-book displays, got ${recipeBookDb.recipe_count}`)
if (!recipeIds(craftingTableDb).has('minecraft:too_large')) throw new Error('valid 3x3 recipe was omitted from crafting-table DB')
if (tinyIds.has('minecraft:too_large')) throw new Error('3x3 recipe leaked into player 2x2 crafting DB')
if (recipeIds(recipeBookDb).has('minecraft:deprecated_old_recipe')) throw new Error('network_id 0 recipe must not be exposed as an executable recipe-book display')
if (!tinyIds.has('minecraft:test_vertical_sticks_shape')) throw new Error('column-major vertical shaped recipe was not exported')
if (tinyIds.has('minecraft:furnace_log_oak')) throw new Error('tiny furnace recipe leaked into crafting DB')
if (!tinyStationIds.has('minecraft:furnace_log_oak')) throw new Error('tiny furnace recipe was not preserved for future station DB')
if (!tinyStationIds.has('minecraft:test_stonecutter')) throw new Error('tiny stonecutter recipe was not preserved for future station DB')
if (!tinyStationIds.has('minecraft:deprecated_old_recipe')) throw new Error('tiny deprecated station recipe was not preserved for future audit')
if (db.recipes[0].pattern.length !== 4) throw new Error('shaped 2x2 pattern was not exported as 4 cells')
if (db.recipes[1].pattern.length !== 2) throw new Error('vertical 1x2 pattern should contain 2 cells')
if (db.recipes[0].network_id !== 101) throw new Error('shaped recipe network_id was not preserved')
if (db.recipes[1].network_id !== 102) throw new Error('vertical recipe network_id was not preserved')
if (db.recipes[2].network_id !== 103) throw new Error('shapeless recipe network_id was not preserved')
if (db.recipes[2].ingredients.length !== 2) throw new Error('shapeless ingredients were not preserved')

const twoByTwo = db.recipes.find(recipe => recipe.recipe_id === 'minecraft:test_2x2_shaped')
if (!twoByTwo || twoByTwo.pattern[0]?.network_id !== 1 || twoByTwo.pattern[1] !== null || twoByTwo.pattern[2]?.tag !== 'minecraft:planks' || twoByTwo.pattern[3]?.network_id !== 2) {
  throw new Error('nested shaped recipe cells were not flattened into row-major grid order')
}
const ladderShape = craftingTableDb.recipes.find(recipe => recipe.recipe_id === 'minecraft:too_large')
const ladderEmptySlots = ladderShape?.pattern
  .map((cell, index) => cell ? -1 : index)
  .filter(index => index >= 0)
if (!ladderShape || ladderEmptySlots.join(',') !== '1,7') {
  throw new Error(`3x3 shaped recipe was transposed; expected empty slots 1,7, got ${ladderEmptySlots?.join(',')}`)
}

// Bedrock 1.26.40 removed the tagged `recipes` array and moved recipe kinds
// into separate arrays. Ingredients also changed from numeric IDs to named or
// tag descriptors. This fixture is mandatory because release archives do not
// include the optional packet-census sample exercised above.
const validName = (name, count = 1) => ({
  type: 'valid',
  descriptor_type: 'name',
  name,
  metadata: 32767,
  count
})
const validTag = (tag, count = 1) => ({
  type: 'valid',
  descriptor_type: 'item_tag',
  tag,
  metadata: 32767,
  count
})
const emptyDescriptorIngredient = { type: 'valid', descriptor_type: 'empty', metadata: 32767, count: 0 }
const modernRecipeOptions = {
  networkIdByItemName: new Map([
    ['minecraft:oak_log', 17],
    ['minecraft:stick', 352]
  ])
}
const modernSplitPacket = {
  shaped_recipes: [
    {
      recipe_id: 'minecraft:modern_oak_planks',
      width: 1,
      height: 1,
      input: [validName('minecraft:oak_log')],
      output: [{ network_id: -742, count: 4, metadata: 0, block_runtime_id: 1921718966 }],
      block: 'crafting_table',
      priority: 0,
      network_id: 2501
    },
    {
      recipe_id: 'minecraft:modern_barrel',
      width: 3,
      height: 3,
      input: [
        validTag('minecraft:planks'), validTag('minecraft:planks'), validTag('minecraft:planks'),
        validTag('minecraft:planks'), emptyDescriptorIngredient, validTag('minecraft:planks'),
        validTag('minecraft:planks'), validTag('minecraft:planks'), validTag('minecraft:planks')
      ],
      output: [{ network_id: -203, count: 1, metadata: 0, block_runtime_id: 198111737 }],
      block: 'crafting_table',
      priority: 0,
      network_id: 2502
    },
    {
      recipe_id: 'minecraft:modern_non_executable',
      width: 1,
      height: 1,
      input: [validName('minecraft:oak_log')],
      output: [{ network_id: -742, count: 4, metadata: 0, block_runtime_id: 1921718966 }],
      block: 'crafting_table',
      priority: 0,
      network_id: 0
    }
  ],
  shapeless_recipes: [
    {
      recipe_id: 'minecraft:modern_shapeless',
      input: [validName('minecraft:stick'), validTag('minecraft:planks')],
      output: [{ network_id: 58, count: 1, metadata: 0, block_runtime_id: 0 }],
      block: 'crafting_table',
      priority: 0,
      network_id: 2503
    }
  ],
  multi_recipes: [],
  shulker_box_recipes: [],
  shapeless_chemistry_recipes: [],
  shaped_chemistry_recipes: [],
  smithing_transform_recipes: [],
  smithing_trim_recipes: [],
  potion_type_recipes: [],
  potion_container_recipes: [],
  material_reducers: [],
  clear_recipes: true
}

const modern2x2 = simplifyCraftingDataForBridge2x2(modernSplitPacket, modernRecipeOptions)
const modern3x3 = simplifyCraftingDataForBridge3x3(modernSplitPacket, modernRecipeOptions)
const modernBook = simplifyCraftingDataForRecipeBook(modernSplitPacket, modernRecipeOptions)
if (modern2x2.recipe_count !== 2) throw new Error(`expected 2 modern executable 2x2 recipes, got ${modern2x2.recipe_count}`)
if (modern3x3.recipe_count !== 3) throw new Error(`expected 3 modern executable 3x3 recipes, got ${modern3x3.recipe_count}`)
if (modernBook.recipe_count !== 3) throw new Error(`expected 3 modern recipe-book displays, got ${modernBook.recipe_count}`)
const modernPlanks = modern2x2.recipes.find(recipe => recipe.recipe_id === 'minecraft:modern_oak_planks')
if (!modernPlanks || modernPlanks.network_id !== 2501 || modernPlanks.pattern[0]?.network_id !== 17) {
  throw new Error('modern named ingredient was not resolved through the live item palette')
}
if (modernPlanks.output.network_id !== -742) throw new Error('negative Bedrock item runtime IDs must remain valid recipe outputs')
if (!modern3x3.recipes.some(recipe => recipe.recipe_id === 'minecraft:modern_barrel' && recipe.network_id === 2502)) {
  throw new Error('modern split-array 3x3 recipe was not exported with an executable network ID')
}
if (modernBook.recipes.some(recipe => recipe.network_id <= 0)) {
  throw new Error('recipe book exposed a recipe without an executable Bedrock network ID')
}
const modernWithoutPalette = simplifyCraftingDataForBridge2x2(modernSplitPacket)
if (modernWithoutPalette.recipe_count !== 0) {
  throw new Error('unresolved named ingredients must reject a recipe instead of silently dropping required cells')
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-crafting-recipes-'))
try {
  const result = writeBridgeCraftingRecipesForViaProxy(tmp, path.join(tmp, 'viaproxy-run'), tinyPacket)
  if (!result.written || result.recipeCount !== 3) throw new Error('recipe writer did not report the expected crafting output')
  if (result.craftingTableRecipeCount !== 4) throw new Error(`expected 4 crafting-table recipes, got ${result.craftingTableRecipeCount}`)
  if (result.stationRecipeCount !== 3) throw new Error(`expected 3 preserved station recipes, got ${result.stationRecipeCount}`)
  if (result.recipeBookCount !== 4) throw new Error(`expected 4 executable recipe-book displays, got ${result.recipeBookCount}`)
  for (const target of result.targets) {
    if (!fs.existsSync(target)) throw new Error(`missing recipe DB target: ${target}`)
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count !== 3) throw new Error(`bad written recipe count in ${target}`)
    if (recipeIds(written).has('minecraft:furnace_log_oak')) throw new Error(`furnace recipe leaked into ${target}`)
  }
  for (const target of result.stationTargets) {
    if (!fs.existsSync(target)) throw new Error(`missing future station recipe DB target: ${target}`)
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (!recipeIds(written).has('minecraft:furnace_log_oak')) throw new Error(`furnace recipe missing from ${target}`)
  }

  for (const target of result.craftingTableTargets) {
    if (!fs.existsSync(target)) throw new Error(`missing crafting-table recipe DB target: ${target}`)
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count !== 4 || !recipeIds(written).has('minecraft:too_large')) {
      throw new Error(`bad 3x3 crafting-table recipe DB in ${target}`)
    }
  }

  for (const target of result.recipeBookTargets) {
    if (!fs.existsSync(target)) throw new Error(`missing recipe-book target: ${target}`)
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count !== 4 || written.unlock_state_ready !== false) {
      throw new Error(`fresh recipe-book catalog has bad state in ${target}`)
    }
  }

  let unlockResult = applyBridgeUnlockedRecipesForViaProxy(tmp, path.join(tmp, 'viaproxy-run'), {
    unlock_type: 'initially_unlocked',
    recipes: ['minecraft:test_2x2_shaped', 'minecraft:test_shapeless']
  })
  if (!unlockResult.written || unlockResult.unlockedRecipeCount !== 2) throw new Error('initial recipe unlock state was not written')

  unlockResult = applyBridgeUnlockedRecipesForViaProxy(tmp, path.join(tmp, 'viaproxy-run'), {
    unlock_type: 'newly_unlocked',
    recipes: ['minecraft:deprecated_old_recipe']
  })
  if (unlockResult.unlockedRecipeCount !== 3) throw new Error('newly unlocked recipe was not added')

  unlockResult = applyBridgeUnlockedRecipesForViaProxy(tmp, path.join(tmp, 'viaproxy-run'), {
    unlock_type: 'remove_unlocked',
    recipes: ['minecraft:test_shapeless']
  })
  if (unlockResult.unlockedRecipeCount !== 2) throw new Error('removed recipe remained unlocked')

  const unlockedBook = JSON.parse(fs.readFileSync(result.recipeBookTargets[0], 'utf8'))
  if (!unlockedBook.unlock_state_ready || unlockedBook.last_unlock_type !== 'remove_unlocked') {
    throw new Error('recipe-book unlock metadata was not updated')
  }
  if (unlockedBook.unlocked_recipe_ids.join(',') !== 'minecraft:deprecated_old_recipe,minecraft:test_2x2_shaped') {
    throw new Error(`unexpected unlocked recipe ids: ${unlockedBook.unlocked_recipe_ids.join(',')}`)
  }

  writeBridgeCraftingRecipesForViaProxy(tmp, path.join(tmp, 'viaproxy-run'), tinyPacket)
  const resetBook = JSON.parse(fs.readFileSync(result.recipeBookTargets[0], 'utf8'))
  if (resetBook.unlock_state_ready || resetBook.unlocked_recipe_ids.length) {
    throw new Error('new crafting_data did not clear stale recipe unlock state')
  }

  const modernResult = writeBridgeCraftingRecipesForViaProxy(
    tmp,
    path.join(tmp, 'viaproxy-run'),
    modernSplitPacket,
    modernRecipeOptions
  )
  if (!modernResult.written || modernResult.sourceSchema !== 'split_recipe_arrays' || modernResult.sourceRecipeCount !== 4) {
    throw new Error(`modern split recipe writer reported unexpected result: ${JSON.stringify(modernResult)}`)
  }
  if (modernResult.recipeCount !== 2 || modernResult.craftingTableRecipeCount !== 3 || modernResult.recipeBookCount !== 3) {
    throw new Error('modern split recipe writer did not persist executable 2x2, 3x3, and recipe-book catalogs')
  }
  for (const target of [...modernResult.targets, ...modernResult.craftingTableTargets, ...modernResult.recipeBookTargets]) {
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count <= 0 || written.recipes.some(recipe => recipe.network_id <= 0)) {
      throw new Error(`modern recipe target is empty or non-executable: ${target}`)
    }
  }

  const unresolvedSplitResult = writeBridgeCraftingRecipesForViaProxy(
    tmp,
    path.join(tmp, 'viaproxy-run'),
    {
      ...modernSplitPacket,
      shaped_recipes: [modernSplitPacket.shaped_recipes[0]],
      shapeless_recipes: []
    }
  )
  if (unresolvedSplitResult.written ||
      !unresolvedSplitResult.clearedStaleRecipeCatalogs ||
      unresolvedSplitResult.sourceSchema !== 'split_recipe_arrays' ||
      unresolvedSplitResult.sourceRecipeCount !== 1) {
    throw new Error('split-array catalog with unresolved named ingredients did not report stale-catalog clearing')
  }
  for (const target of [...unresolvedSplitResult.targets, ...unresolvedSplitResult.craftingTableTargets, ...unresolvedSplitResult.recipeBookTargets]) {
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count !== 0 || written.recipes.length !== 0) {
      throw new Error(`stale recipe catalog survived a split-array parse failure: ${target}`)
    }
  }

  const clearedResult = writeBridgeCraftingRecipesForViaProxy(
    tmp,
    path.join(tmp, 'viaproxy-run'),
    { unexpected_recipe_payload: modernSplitPacket.shaped_recipes },
    modernRecipeOptions
  )
  if (clearedResult.written || !clearedResult.clearedStaleRecipeCatalogs || clearedResult.sourceSchema !== 'unrecognized') {
    throw new Error('unrecognized crafting_data schema did not report stale-catalog clearing')
  }
  for (const target of [...clearedResult.targets, ...clearedResult.craftingTableTargets, ...clearedResult.recipeBookTargets]) {
    const written = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (written.recipe_count !== 0 || written.recipes.length !== 0) {
      throw new Error(`stale recipe catalog survived an unrecognized crafting_data schema: ${target}`)
    }
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('[smoke] bridge crafting recipe export smoke passed')
