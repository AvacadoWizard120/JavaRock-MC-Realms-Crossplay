'use strict'

const fs = require('fs')
const path = require('path')
const { Worker, isMainThread, parentPort, workerData, threadId } = require('worker_threads')
const { safeStringify } = require('./safeStringify')

function loadDatabaseSync () {
  try {
    return require('node:sqlite').DatabaseSync
  } catch {
    return null
  }
}

function ensureDir (dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function atomicWriteJson (file, value, taskId = 0) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${threadId}.${taskId}.tmp`
  fs.writeFileSync(tmp, safeStringify(value, 2) + '\n')
  fs.renameSync(tmp, file)
}

function jsonText (value) {
  if (value == null) return null
  return safeStringify(value, 0)
}

function stringOrNull (value) {
  if (value == null || value === '') return null
  return String(value)
}

function contextText (context) {
  if (context == null || context === '') return null
  if (typeof context === 'string') return context
  return safeStringify(context, 0)
}

function sampleHashFromPath (samplePath) {
  if (!samplePath) return null
  const base = path.basename(samplePath, '.json')
  const parts = base.split('-')
  return parts.length ? parts[parts.length - 1] : null
}

function inferTranslationState (event = {}) {
  const phase = String(event.phase || '').toLowerCase()
  const status = String(event.translation_status || '').toLowerCase()
  if (event.error || phase === 'failed' || status.includes('failed') || status.includes('broken') || status.includes('serial')) return 'broken'
  if (phase === 'dropped' || status.startsWith('dropped')) return 'dropped'
  if (phase === 'diagnostic' || status.startsWith('diagnostic')) return 'diagnostic'
  if (status.includes('rewritten') || status.includes('synthetic') || status === 'normalized') return 'translated'
  if (status.includes('sent_to') || status === 'sent' || status.includes('passthrough')) return 'passthrough'
  if (phase === 'delayed' || status.includes('delayed')) return 'deferred'
  if (phase === 'received' && status === 'seen_unhandled') return 'observed'
  if (status === 'seen_unhandled') return 'needs_work'
  if (status === 'seen' || phase === 'received') return 'observed'
  return 'observed'
}

function inferTranslationStrategy (event = {}) {
  const status = String(event.translation_status || '').toLowerCase()
  const phase = String(event.phase || '').toLowerCase()
  if (status.includes('crafting_inventory_transaction_to_item_stack_request')) return 'crafting_grid_legacy_inventory_transaction_to_item_stack_request'
  if (status.includes('legacy_inventory_transaction_to_item_stack_request')) return 'legacy_inventory_transaction_to_item_stack_request'
  if (status.includes('synthetic_inventory_screen_shim')) return 'synthetic_inventory_screen_shim'
  if (status.includes('synthetic_inventory_replay')) return 'authoritative_inventory_replay'
  if (status.includes('synthetic_authoritative_inventory_replay')) return 'authoritative_inventory_replay'
  if (status === 'normalized') return 'bedrock_packet_shape_normalizer'
  if (status.includes('fallback_after_schema_reject')) return 'serializer_fallback_packet_shape'
  if (status.includes('schema_reject') || status.includes('serial')) return 'serializer_compatibility_gap'
  if (status.includes('dropped_unknown_entity')) return 'entity_snapshot_gate'
  if (status.includes('delayed') || phase === 'delayed') return 'timing_gate'
  if (status.startsWith('diagnostic')) return 'diagnostic'
  if (status.includes('sent_to_local_viabedrock')) return 'forward_to_local_viabedrock'
  if (status.includes('sent_to_realm')) return 'forward_to_realm'
  if (status.includes('passthrough')) return 'passthrough'
  return null
}

function inferTranslationNotes (event = {}) {
  const pieces = []
  if (event.context != null && event.context !== '') pieces.push(`context=${contextText(event.context)}`)
  if (event.phase) pieces.push(`phase=${event.phase}`)
  if (event.translation_status) pieces.push(`status=${event.translation_status}`)
  return pieces.length ? pieces.join('; ') : null
}

class PacketCensusSqliteLedger {
  constructor (options = {}) {
    this.enabled = options.enabled !== false
    this.dir = path.resolve(options.dir || 'packet-census')
    this.file = path.resolve(options.file || path.join(this.dir, 'packet-ledger.sqlite'))
    this.captureProfile = String(options.captureProfile || 'unspecified')
    this.sourceLabel = stringOrNull(options.sourceLabel)
    this.targetLabel = stringOrNull(options.targetLabel)
    this.unavailableReason = null
    this.db = null
    this.statements = null

    if (!this.enabled) return

    const DatabaseSync = loadDatabaseSync()
    if (!DatabaseSync) {
      this.enabled = false
      this.unavailableReason = 'node:sqlite is unavailable in this Node runtime'
      return
    }

    ensureDir(path.dirname(this.file))
    this.db = new DatabaseSync(this.file)
    this.initializeSchema()
    this.prepareStatements()
    this.setMetadata('schema_version', '1')
    this.setMetadata('updated_at', new Date().toISOString())
  }

  initializeSchema () {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        capture_profile TEXT NOT NULL DEFAULT 'unspecified',
        source_label TEXT,
        target_label TEXT,
        event_count INTEGER NOT NULL DEFAULT 0,
        events_written INTEGER NOT NULL DEFAULT 0,
        event_mode TEXT,
        high_volume_event_every INTEGER,
        events_file TEXT,
        summary_file TEXT,
        close_reason TEXT
      );

      CREATE TABLE IF NOT EXISTS packet_kinds (
        packet_key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        lane TEXT NOT NULL,
        direction TEXT NOT NULL,
        source_version TEXT,
        target_version TEXT,
        packet_id TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        first_seen_at TEXT,
        last_seen_at TEXT,
        first_seen_run_id TEXT,
        last_seen_run_id TEXT,
        count_seen INTEGER NOT NULL DEFAULT 0,
        last_phase TEXT,
        last_translation_status TEXT,
        last_translation_state TEXT,
        last_translation_strategy TEXT,
        last_context TEXT,
        last_summary_json TEXT,
        last_error TEXT,
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS packet_kind_phase_counts (
        packet_key TEXT NOT NULL,
        phase TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (packet_key, phase)
      );

      CREATE TABLE IF NOT EXISTS packet_kind_status_counts (
        packet_key TEXT NOT NULL,
        translation_status TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (packet_key, translation_status)
      );

      CREATE TABLE IF NOT EXISTS packet_run_observations (
        run_id TEXT NOT NULL,
        packet_key TEXT NOT NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        first_sequence INTEGER,
        last_sequence INTEGER,
        count_seen INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        sample_count INTEGER NOT NULL DEFAULT 0,
        last_translation_status TEXT,
        last_translation_state TEXT,
        last_context TEXT,
        PRIMARY KEY (run_id, packet_key)
      );

      CREATE TABLE IF NOT EXISTS packet_profile_observations (
        capture_profile TEXT NOT NULL,
        packet_key TEXT NOT NULL,
        first_seen_at TEXT,
        last_seen_at TEXT,
        first_seen_run_id TEXT,
        last_seen_run_id TEXT,
        count_seen INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        last_translation_status TEXT,
        last_translation_state TEXT,
        PRIMARY KEY (capture_profile, packet_key)
      );

      CREATE TABLE IF NOT EXISTS packet_samples (
        sample_path TEXT PRIMARY KEY,
        packet_key TEXT NOT NULL,
        run_id TEXT,
        event_sequence INTEGER,
        at TEXT,
        packet_hash TEXT,
        packet_name TEXT,
        direction TEXT,
        phase TEXT,
        translation_status TEXT
      );

      CREATE TABLE IF NOT EXISTS packet_translations (
        packet_key TEXT PRIMARY KEY,
        current_state TEXT NOT NULL,
        strategy TEXT,
        last_status TEXT,
        notes TEXT,
        code_ref TEXT,
        source TEXT NOT NULL DEFAULT 'auto',
        updated_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_packet_kinds_name ON packet_kinds(name);
      CREATE INDEX IF NOT EXISTS idx_packet_kinds_last_seen ON packet_kinds(last_seen_at);
      CREATE INDEX IF NOT EXISTS idx_packet_translations_state ON packet_translations(current_state);
      CREATE INDEX IF NOT EXISTS idx_packet_run_observations_run ON packet_run_observations(run_id);

      CREATE VIEW IF NOT EXISTS packet_translation_overview AS
        SELECT
          k.packet_key,
          k.name,
          k.lane,
          k.direction,
          k.source_version,
          k.target_version,
          k.count_seen,
          k.last_seen_at,
          k.last_seen_run_id,
          COALESCE(t.current_state, k.last_translation_state, 'observed') AS current_state,
          COALESCE(t.strategy, k.last_translation_strategy) AS strategy,
          COALESCE(t.last_status, k.last_translation_status) AS last_status,
          t.notes,
          t.code_ref,
          t.source AS translation_source,
          (
            SELECT GROUP_CONCAT(capture_profile, ', ')
            FROM packet_profile_observations p
            WHERE p.packet_key = k.packet_key
          ) AS capture_profiles
        FROM packet_kinds k
        LEFT JOIN packet_translations t ON t.packet_key = k.packet_key;

      CREATE VIEW IF NOT EXISTS packet_work_queue AS
        SELECT *
        FROM packet_translation_overview
        WHERE current_state IN ('needs_work', 'broken', 'dropped', 'diagnostic')
        ORDER BY
          CASE current_state
            WHEN 'broken' THEN 0
            WHEN 'dropped' THEN 1
            WHEN 'diagnostic' THEN 2
            ELSE 3
          END,
          last_seen_at DESC;
    `)
  }

  prepareStatements () {
    this.statements = {
      setMetadata: this.db.prepare(`
        INSERT INTO metadata(key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `),
      upsertRun: this.db.prepare(`
        INSERT INTO runs(
          run_id, started_at, ended_at, capture_profile, source_label, target_label,
          event_count, events_written, event_mode, high_volume_event_every,
          events_file, summary_file, close_reason
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET
          started_at = COALESCE(runs.started_at, excluded.started_at),
          ended_at = COALESCE(excluded.ended_at, runs.ended_at),
          capture_profile = COALESCE(NULLIF(excluded.capture_profile, ''), runs.capture_profile),
          source_label = COALESCE(excluded.source_label, runs.source_label),
          target_label = COALESCE(excluded.target_label, runs.target_label),
          event_count = excluded.event_count,
          events_written = excluded.events_written,
          event_mode = COALESCE(excluded.event_mode, runs.event_mode),
          high_volume_event_every = COALESCE(excluded.high_volume_event_every, runs.high_volume_event_every),
          events_file = COALESCE(excluded.events_file, runs.events_file),
          summary_file = COALESCE(excluded.summary_file, runs.summary_file),
          close_reason = COALESCE(excluded.close_reason, runs.close_reason)
      `),
      upsertPacketKind: this.db.prepare(`
        INSERT INTO packet_kinds(
          packet_key, name, lane, direction, source_version, target_version, packet_id,
          tags_json, first_seen_at, last_seen_at, first_seen_run_id, last_seen_run_id,
          count_seen, last_phase, last_translation_status, last_translation_state,
          last_translation_strategy, last_context, last_summary_json, last_error,
          sample_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(packet_key) DO UPDATE SET
          packet_id = COALESCE(packet_kinds.packet_id, excluded.packet_id),
          tags_json = excluded.tags_json,
          last_seen_at = excluded.last_seen_at,
          last_seen_run_id = excluded.last_seen_run_id,
          count_seen = packet_kinds.count_seen + 1,
          last_phase = excluded.last_phase,
          last_translation_status = excluded.last_translation_status,
          last_translation_state = excluded.last_translation_state,
          last_translation_strategy = COALESCE(excluded.last_translation_strategy, packet_kinds.last_translation_strategy),
          last_context = excluded.last_context,
          last_summary_json = excluded.last_summary_json,
          last_error = COALESCE(excluded.last_error, packet_kinds.last_error),
          updated_at = excluded.updated_at
      `),
      setPacketKindFromImport: this.db.prepare(`
        INSERT INTO packet_kinds(
          packet_key, name, lane, direction, source_version, target_version, packet_id,
          tags_json, first_seen_at, last_seen_at, first_seen_run_id, last_seen_run_id,
          count_seen, last_phase, last_translation_status, last_translation_state,
          last_translation_strategy, last_context, last_summary_json, last_error,
          sample_count, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(packet_key) DO UPDATE SET
          packet_id = COALESCE(packet_kinds.packet_id, excluded.packet_id),
          tags_json = excluded.tags_json,
          first_seen_at = COALESCE(packet_kinds.first_seen_at, excluded.first_seen_at),
          last_seen_at = CASE
            WHEN excluded.last_seen_at > COALESCE(packet_kinds.last_seen_at, '') THEN excluded.last_seen_at
            ELSE packet_kinds.last_seen_at
          END,
          first_seen_run_id = COALESCE(packet_kinds.first_seen_run_id, excluded.first_seen_run_id),
          last_seen_run_id = COALESCE(excluded.last_seen_run_id, packet_kinds.last_seen_run_id),
          count_seen = MAX(packet_kinds.count_seen, excluded.count_seen),
          last_phase = COALESCE(excluded.last_phase, packet_kinds.last_phase),
          last_translation_status = COALESCE(excluded.last_translation_status, packet_kinds.last_translation_status),
          last_translation_state = COALESCE(excluded.last_translation_state, packet_kinds.last_translation_state),
          last_translation_strategy = COALESCE(excluded.last_translation_strategy, packet_kinds.last_translation_strategy),
          last_context = COALESCE(excluded.last_context, packet_kinds.last_context),
          last_summary_json = COALESCE(excluded.last_summary_json, packet_kinds.last_summary_json),
          last_error = COALESCE(excluded.last_error, packet_kinds.last_error),
          sample_count = MAX(packet_kinds.sample_count, excluded.sample_count),
          updated_at = excluded.updated_at
      `),
      incrementPhase: this.db.prepare(`
        INSERT INTO packet_kind_phase_counts(packet_key, phase, count)
        VALUES (?, ?, ?)
        ON CONFLICT(packet_key, phase) DO UPDATE SET count = count + excluded.count
      `),
      setPhaseFromImport: this.db.prepare(`
        INSERT INTO packet_kind_phase_counts(packet_key, phase, count)
        VALUES (?, ?, ?)
        ON CONFLICT(packet_key, phase) DO UPDATE SET count = MAX(count, excluded.count)
      `),
      incrementStatus: this.db.prepare(`
        INSERT INTO packet_kind_status_counts(packet_key, translation_status, count)
        VALUES (?, ?, ?)
        ON CONFLICT(packet_key, translation_status) DO UPDATE SET count = count + excluded.count
      `),
      setStatusFromImport: this.db.prepare(`
        INSERT INTO packet_kind_status_counts(packet_key, translation_status, count)
        VALUES (?, ?, ?)
        ON CONFLICT(packet_key, translation_status) DO UPDATE SET count = MAX(count, excluded.count)
      `),
      upsertRunObservation: this.db.prepare(`
        INSERT INTO packet_run_observations(
          run_id, packet_key, first_seen_at, last_seen_at, first_sequence, last_sequence,
          count_seen, error_count, sample_count, last_translation_status, last_translation_state, last_context
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?)
        ON CONFLICT(run_id, packet_key) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          last_sequence = excluded.last_sequence,
          count_seen = count_seen + 1,
          error_count = error_count + excluded.error_count,
          last_translation_status = excluded.last_translation_status,
          last_translation_state = excluded.last_translation_state,
          last_context = excluded.last_context
      `),
      upsertProfileObservation: this.db.prepare(`
        INSERT INTO packet_profile_observations(
          capture_profile, packet_key, first_seen_at, last_seen_at,
          first_seen_run_id, last_seen_run_id, count_seen, error_count,
          last_translation_status, last_translation_state
        )
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(capture_profile, packet_key) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          last_seen_run_id = excluded.last_seen_run_id,
          count_seen = count_seen + 1,
          error_count = error_count + excluded.error_count,
          last_translation_status = excluded.last_translation_status,
          last_translation_state = excluded.last_translation_state
      `),
      setProfileObservationFromImport: this.db.prepare(`
        INSERT INTO packet_profile_observations(
          capture_profile, packet_key, first_seen_at, last_seen_at,
          first_seen_run_id, last_seen_run_id, count_seen, error_count,
          last_translation_status, last_translation_state
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(capture_profile, packet_key) DO UPDATE SET
          first_seen_at = COALESCE(packet_profile_observations.first_seen_at, excluded.first_seen_at),
          last_seen_at = CASE
            WHEN excluded.last_seen_at > COALESCE(packet_profile_observations.last_seen_at, '') THEN excluded.last_seen_at
            ELSE packet_profile_observations.last_seen_at
          END,
          first_seen_run_id = COALESCE(packet_profile_observations.first_seen_run_id, excluded.first_seen_run_id),
          last_seen_run_id = COALESCE(excluded.last_seen_run_id, packet_profile_observations.last_seen_run_id),
          count_seen = MAX(packet_profile_observations.count_seen, excluded.count_seen),
          error_count = MAX(packet_profile_observations.error_count, excluded.error_count),
          last_translation_status = COALESCE(excluded.last_translation_status, packet_profile_observations.last_translation_status),
          last_translation_state = COALESCE(excluded.last_translation_state, packet_profile_observations.last_translation_state)
      `),
      insertSample: this.db.prepare(`
        INSERT OR IGNORE INTO packet_samples(
          sample_path, packet_key, run_id, event_sequence, at, packet_hash,
          packet_name, direction, phase, translation_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      refreshPacketSampleCount: this.db.prepare(`
        UPDATE packet_kinds
        SET sample_count = (SELECT COUNT(*) FROM packet_samples WHERE packet_key = ?)
        WHERE packet_key = ?
      `),
      refreshRunObservationSampleCount: this.db.prepare(`
        UPDATE packet_run_observations
        SET sample_count = (
          SELECT COUNT(*)
          FROM packet_samples
          WHERE packet_key = ? AND run_id = ?
        )
        WHERE packet_key = ? AND run_id = ?
      `),
      upsertTranslation: this.db.prepare(`
        INSERT INTO packet_translations(packet_key, current_state, strategy, last_status, notes, code_ref, source, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'auto', ?)
        ON CONFLICT(packet_key) DO UPDATE SET
          current_state = excluded.current_state,
          strategy = COALESCE(excluded.strategy, packet_translations.strategy),
          last_status = excluded.last_status,
          notes = CASE
            WHEN packet_translations.source = 'manual' AND packet_translations.notes IS NOT NULL THEN packet_translations.notes
            ELSE COALESCE(excluded.notes, packet_translations.notes)
          END,
          code_ref = packet_translations.code_ref,
          source = packet_translations.source,
          updated_at = excluded.updated_at
      `)
    }
  }

  setMetadata (key, value) {
    if (!this.enabled) return
    this.statements.setMetadata.run(String(key), String(value))
  }

  recordRunStart (run = {}) {
    if (!this.enabled) return
    this.statements.upsertRun.run(
      String(run.run_id),
      String(run.started_at || new Date().toISOString()),
      stringOrNull(run.ended_at),
      String(run.capture_profile || this.captureProfile || 'unspecified'),
      stringOrNull(run.source_label || this.sourceLabel),
      stringOrNull(run.target_label || this.targetLabel),
      Number.isInteger(run.event_count) ? run.event_count : 0,
      Number.isInteger(run.events_written) ? run.events_written : 0,
      stringOrNull(run.event_mode),
      Number.isInteger(run.high_volume_event_every) ? run.high_volume_event_every : null,
      stringOrNull(run.events_file),
      stringOrNull(run.summary_file),
      stringOrNull(run.close_reason)
    )
  }

  recordRunProgress (run = {}) {
    this.recordRunStart(run)
  }

  recordRunClose (run = {}) {
    this.recordRunStart(run)
    this.setMetadata('updated_at', new Date().toISOString())
  }

  importJsonDb (jsonDb = {}) {
    if (!this.enabled || !jsonDb || typeof jsonDb !== 'object') return
    const now = new Date().toISOString()

    for (const run of Object.values(jsonDb.runs || {})) {
      if (!run || !run.run_id) continue
      this.recordRunStart({
        ...run,
        capture_profile: run.capture_profile || 'legacy-json',
        source_label: run.source_label,
        target_label: run.target_label
      })
    }

    for (const kind of Object.values(jsonDb.packet_kinds || {})) {
      if (!kind || !kind.key) continue
      const statuses = kind.translation_statuses && typeof kind.translation_statuses === 'object' ? kind.translation_statuses : {}
      const phases = kind.phases && typeof kind.phases === 'object' ? kind.phases : {}
      const lastStatus = mostCommonKey(statuses) || null
      const importEvent = {
        phase: mostCommonKey(phases) || null,
        translation_status: lastStatus,
        context: 'legacy_json_import',
        error: kind.last_error
      }
      const state = inferTranslationState(importEvent)
      const strategy = inferTranslationStrategy(importEvent)
      const sampleCount = Array.isArray(kind.samples) ? kind.samples.length : 0
      this.statements.setPacketKindFromImport.run(
        String(kind.key),
        String(kind.name || 'unknown_packet'),
        String(kind.lane || 'unknown_lane'),
        String(kind.direction || 'unknown_direction'),
        stringOrNull(kind.source_version),
        stringOrNull(kind.target_version),
        stringOrNull(kind.packet_id),
        jsonText(kind.tags || []),
        stringOrNull(kind.first_seen_at),
        stringOrNull(kind.last_seen_at),
        stringOrNull(kind.first_seen_run_id),
        stringOrNull(kind.last_seen_run_id),
        Number.isInteger(kind.count_seen) ? kind.count_seen : 0,
        stringOrNull(importEvent.phase),
        stringOrNull(lastStatus),
        state,
        stringOrNull(strategy),
        'legacy_json_import',
        jsonText(kind.last_summary),
        stringOrNull(kind.last_error),
        sampleCount,
        now
      )

      for (const [phase, count] of Object.entries(phases)) {
        this.statements.setPhaseFromImport.run(String(kind.key), String(phase), Number.isInteger(count) ? count : Number(count) || 0)
      }

      for (const [status, count] of Object.entries(statuses)) {
        this.statements.setStatusFromImport.run(String(kind.key), String(status), Number.isInteger(count) ? count : Number(count) || 0)
      }

      for (const sample of kind.samples || []) {
        this.statements.insertSample.run(
          String(sample),
          String(kind.key),
          stringOrNull(kind.last_seen_run_id),
          null,
          stringOrNull(kind.last_seen_at),
          sampleHashFromPath(sample),
          String(kind.name || 'unknown_packet'),
          stringOrNull(kind.direction),
          null,
          stringOrNull(lastStatus)
        )
      }

      this.statements.upsertTranslation.run(
        String(kind.key),
        state,
        stringOrNull(strategy),
        stringOrNull(lastStatus),
        'Imported from census.json; live event context will refine this on the next run.',
        null,
        now
      )

      this.statements.setProfileObservationFromImport.run(
        'legacy-json',
        String(kind.key),
        stringOrNull(kind.first_seen_at),
        stringOrNull(kind.last_seen_at),
        stringOrNull(kind.first_seen_run_id),
        stringOrNull(kind.last_seen_run_id),
        Number.isInteger(kind.count_seen) ? kind.count_seen : 0,
        kind.last_error ? 1 : 0,
        stringOrNull(lastStatus),
        state
      )
    }

    this.setMetadata('updated_at', now)
  }

  recordEvent ({ key, event, sample }) {
    if (!this.enabled || !key || !event) return
    const now = String(event.at || new Date().toISOString())
    const state = inferTranslationState(event)
    const strategy = inferTranslationStrategy(event)
    const context = contextText(event.context)
    const tags = Array.isArray(event.tags) ? event.tags : []

    this.statements.upsertPacketKind.run(
      String(key),
      String(event.name || 'unknown_packet'),
      String(event.lane || 'unknown_lane'),
      String(event.direction || 'unknown_direction'),
      stringOrNull(event.source_version),
      stringOrNull(event.target_version),
      stringOrNull(event.packet_id),
      jsonText(tags),
      now,
      now,
      String(event.run_id),
      String(event.run_id),
      String(event.phase || 'received'),
      String(event.translation_status || 'seen'),
      state,
      stringOrNull(strategy),
      context,
      jsonText(event.summary),
      stringOrNull(event.error),
      now
    )

    this.statements.incrementPhase.run(String(key), String(event.phase || 'received'), 1)
    this.statements.incrementStatus.run(String(key), String(event.translation_status || 'seen'), 1)
    this.statements.upsertRunObservation.run(
      String(event.run_id),
      String(key),
      now,
      now,
      Number.isInteger(event.sequence) ? event.sequence : null,
      Number.isInteger(event.sequence) ? event.sequence : null,
      event.error ? 1 : 0,
      String(event.translation_status || 'seen'),
      state,
      context
    )
    this.statements.upsertProfileObservation.run(
      String(event.capture_profile || this.captureProfile || 'unspecified'),
      String(key),
      now,
      now,
      String(event.run_id),
      String(event.run_id),
      event.error ? 1 : 0,
      String(event.translation_status || 'seen'),
      state
    )

    if (sample) {
      this.statements.insertSample.run(
        String(sample),
        String(key),
        String(event.run_id),
        Number.isInteger(event.sequence) ? event.sequence : null,
        now,
        sampleHashFromPath(sample),
        String(event.name || 'unknown_packet'),
        String(event.direction || 'unknown_direction'),
        String(event.phase || 'received'),
        String(event.translation_status || 'seen')
      )
      this.statements.refreshPacketSampleCount.run(String(key), String(key))
      this.statements.refreshRunObservationSampleCount.run(String(key), String(event.run_id), String(key), String(event.run_id))
    }

    this.statements.upsertTranslation.run(
      String(key),
      state,
      stringOrNull(strategy),
      String(event.translation_status || 'seen'),
      inferTranslationNotes(event),
      null,
      now
    )
    this.setMetadata('updated_at', now)
  }

  recordEvents (entries = []) {
    if (!this.enabled || !this.db || !entries.length) return
    this.db.exec('BEGIN')
    try {
      for (const entry of entries) this.recordEvent(entry)
      this.db.exec('COMMIT')
    } catch (error) {
      try { this.db.exec('ROLLBACK') } catch {}
      throw error
    }
  }

  close () {
    if (!this.enabled || !this.db) return
    this.db.close()
    this.db = null
    this.enabled = false
  }
}

function estimatePersistenceTaskBytes (task) {
  if (typeof task.content === 'string') return Buffer.byteLength(task.content)
  if (Buffer.isBuffer(task.content)) return task.content.length
  if (Array.isArray(task.args?.[0])) return Math.max(1024, task.args[0].length * 2048)
  if (task.value != null) return 256 * 1024
  return 1024
}

class PacketCensusPersistenceQueue {
  constructor (options = {}) {
    this.sqliteEnabled = options.sqliteEnabled !== false && Boolean(loadDatabaseSync())
    this.enabled = this.sqliteEnabled
    this.unavailableReason = options.sqliteEnabled === false || this.sqliteEnabled
      ? null
      : 'node:sqlite is unavailable in this Node runtime'
    this.maxInFlight = Number.isInteger(options.maxInFlight) && options.maxInFlight > 0
      ? options.maxInFlight
      : 4
    this.maxQueuedBytes = Number.isInteger(options.maxQueuedBytes) && options.maxQueuedBytes > 0
      ? options.maxQueuedBytes
      : 8 * 1024 * 1024
    this.maxAppendBatchBytes = Number.isInteger(options.maxAppendBatchBytes) && options.maxAppendBatchBytes > 0
      ? options.maxAppendBatchBytes
      : 256 * 1024
    this.pending = []
    this.inFlight = new Map()
    this.completionCallbacks = new Map()
    this.queuedBytes = 0
    this.nextTaskId = 1
    this.closed = false
    this.closeResult = undefined
    this.shutdownQueued = false
    this.available = false
    this.drainFailed = false
    this.failedTaskCount = 0
    this.rejectedTaskCount = 0
    this.drainTimeoutMs = Number.isInteger(options.drainTimeoutMs) && options.drainTimeoutMs > 0
      ? options.drainTimeoutMs
      : 5000
    this.warningShown = false
    // Shared slots: last completed task id, worker error count, fatal-worker
    // flag, and the task id that caused a fatal worker shutdown. The failed id
    // lets a synchronous shutdown drain distinguish earlier writes that really
    // completed from the failed task and the unprocessed tail behind it.
    this.shared = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4))
    this.worker = null

    try {
      this.worker = new Worker(__filename, {
        workerData: {
          packetCensusPersistenceWorker: true,
          shared: this.shared.buffer,
          sqlite: {
            enabled: this.sqliteEnabled,
            dir: options.dir,
            file: options.file,
            captureProfile: options.captureProfile,
            sourceLabel: options.sourceLabel,
            targetLabel: options.targetLabel
          }
        }
      })
      this.available = true
    } catch (error) {
      Atomics.store(this.shared, 2, 1)
      this.warn(`Could not start the persistence worker: ${error.stack || error.message || error}`)
      return
    }

    this.worker.on('message', message => {
      const completed = Number(message?.completed)
      if (Number.isInteger(completed) && completed > 0) {
        const entry = this.inFlight.get(completed)
        if (entry) {
          this.inFlight.delete(completed)
          this.queuedBytes = Math.max(0, this.queuedBytes - entry.bytes)
        }
        this.settleCompletionCallbacks(completed, {
          ok: !message?.error,
          error: message?.error || null
        })
      }
      if (message?.error) {
        this.failedTaskCount++
        this.warn(message.error)
      }
      if (message?.warning) this.warn(message.warning)
      this.pump()
    })
    this.worker.on('error', error => {
      this.markUnavailable(`Persistence worker failed: ${error.stack || error.message || error}`)
    })
    this.worker.on('exit', code => {
      const expected = this.closed || this.shutdownQueued
      this.worker = null
      this.available = false
      if (code === 0 && expected) return
      this.markUnavailable(`Persistence worker exited unexpectedly with code ${code}`)
    })
    this.worker.unref()
  }

  warn (message) {
    if (this.warningShown) return
    this.warningShown = true
    console.warn(`[packet-census] Background persistence failed; gameplay will continue but some queued diagnostics may be missing: ${message}`)
  }

  settleCompletionCallbacks (id, result) {
    const callbacks = this.completionCallbacks.get(id)
    if (!callbacks) return
    this.completionCallbacks.delete(id)
    const ordered = result.ok ? callbacks : callbacks.slice().reverse()
    for (const callback of ordered) {
      try {
        callback(result)
      } catch (error) {
        this.warn(`Persistence completion callback failed: ${error.stack || error.message || error}`)
      }
    }
  }

  markUnavailable (message) {
    if (Atomics.load(this.shared, 2) === 0) Atomics.store(this.shared, 2, 1)
    Atomics.notify(this.shared, 0)
    this.available = false
    const error = String(message || 'persistence worker unavailable')
    this.reapCompleted()
    const callbackIds = Array.from(this.completionCallbacks.keys()).sort((left, right) => right - left)
    for (const id of callbackIds) this.settleCompletionCallbacks(id, { ok: false, error })
    this.pending = []
    this.inFlight.clear()
    this.queuedBytes = 0
    this.warn(error)
  }

  reapCompleted () {
    const completed = Atomics.load(this.shared, 0)
    const failedTaskId = Atomics.load(this.shared, 3)
    for (const [id, entry] of this.inFlight) {
      if (id > completed) continue
      this.inFlight.delete(id)
      this.queuedBytes = Math.max(0, this.queuedBytes - entry.bytes)
    }
    const callbackIds = Array.from(this.completionCallbacks.keys())
      .filter(id => id <= completed)
      .sort((left, right) => left - right)
    for (const id of callbackIds) {
      const failed = failedTaskId > 0 && id >= failedTaskId
      // Leave the failed task for markUnavailable(), which settles every
      // unpersisted callback in reverse task order. Append retry callbacks use
      // that ordering to rebuild their FIFO batches safely.
      if (failed) continue
      this.settleCompletionCallbacks(id, { ok: true, error: null })
    }
  }

  pump () {
    if (!this.worker || !this.available || Atomics.load(this.shared, 2) !== 0) return
    while (this.pending.length && this.inFlight.size < this.maxInFlight) {
      const entry = this.pending.shift()
      this.inFlight.set(entry.task.id, entry)
      try {
        this.worker.postMessage(entry.task)
      } catch (error) {
        this.markUnavailable(`Could not queue ${entry.task.type} task: ${error.stack || error.message || error}`)
        return
      }
    }
  }

  canAccept (bytes = 1024) {
    if (this.closed || this.drainFailed || !this.worker || !this.available || Atomics.load(this.shared, 2) !== 0) return false
    return this.queuedBytes === 0 || this.queuedBytes + Math.max(0, bytes) <= this.maxQueuedBytes
  }

  enqueue (task, options = {}) {
    if (this.closed || this.drainFailed || !this.worker || !this.available || Atomics.load(this.shared, 2) !== 0) return false
    const bytes = options.bytes || estimatePersistenceTaskBytes(task)
    const last = this.pending[this.pending.length - 1]
    const matchingEntry = options.coalesceKey && last?.coalesceKey === options.coalesceKey
      ? last
      : null

    if (matchingEntry) {
      if (task.type === 'append' && matchingEntry.task.type === 'append' &&
          matchingEntry.bytes + bytes <= this.maxAppendBatchBytes &&
          this.queuedBytes + bytes <= this.maxQueuedBytes) {
        matchingEntry.task.content += task.content
        matchingEntry.bytes += bytes
        this.queuedBytes += bytes
        if (typeof options.onComplete === 'function') {
          const callbacks = this.completionCallbacks.get(matchingEntry.task.id) || []
          callbacks.push(options.onComplete)
          this.completionCallbacks.set(matchingEntry.task.id, callbacks)
        }
        return true
      }
      if (task.type === 'write_json' && matchingEntry.task.type === 'write_json') {
        this.queuedBytes = Math.max(0, this.queuedBytes - matchingEntry.bytes)
        matchingEntry.task.value = task.value
        matchingEntry.bytes = bytes
        this.queuedBytes += bytes
        if (typeof options.onComplete === 'function') {
          const callbacks = this.completionCallbacks.get(matchingEntry.task.id) || []
          callbacks.push(options.onComplete)
          this.completionCallbacks.set(matchingEntry.task.id, callbacks)
        }
        return true
      }
      if (task.type === 'sqlite' && task.method === 'recordRunProgress' && matchingEntry.task.method === task.method) {
        this.queuedBytes = Math.max(0, this.queuedBytes - matchingEntry.bytes)
        matchingEntry.task.args = task.args
        matchingEntry.bytes = bytes
        this.queuedBytes += bytes
        return true
      }
    }

    // Diagnostics are never allowed to block the gameplay event loop. Callers
    // retain/retry their buffers when this bounded queue is temporarily full.
    if (!this.canAccept(bytes)) {
      this.rejectedTaskCount++
      return false
    }
    task.id = this.nextTaskId++
    const entry = { task, bytes, coalesceKey: options.coalesceKey }
    this.pending.push(entry)
    this.queuedBytes += bytes
    if (typeof options.onComplete === 'function') {
      this.completionCallbacks.set(task.id, [options.onComplete])
    }
    this.pump()
    return true
  }

  appendFile (file, content, onComplete) {
    if (!content) return true
    return this.enqueue(
      { type: 'append', file: path.resolve(file), content: String(content) },
      { coalesceKey: `append:${path.resolve(file)}`, onComplete }
    )
  }

  writeJsonAtomic (file, value, options = {}) {
    let snapshot
    try {
      snapshot = structuredClone(value)
    } catch (error) {
      this.warn(`Could not snapshot JSON diagnostics for ${file}: ${error.stack || error.message || error}`)
      return false
    }
    return this.enqueue(
      { type: 'write_json', file: path.resolve(file), value: snapshot },
      { coalesceKey: `write_json:${path.resolve(file)}`, onComplete: options.onComplete }
    )
  }

  unlink (file) {
    return this.enqueue({ type: 'unlink', file: path.resolve(file) })
  }

  sqlite (method, ...args) {
    if (!this.sqliteEnabled) return
    let snapshotArgs
    try {
      snapshotArgs = structuredClone(args)
    } catch (error) {
      this.warn(`Could not snapshot SQLite diagnostics for ${method}: ${error.stack || error.message || error}`)
      return false
    }
    const coalesceKey = method === 'recordRunProgress' ? 'sqlite:recordRunProgress' : undefined
    return this.enqueue({ type: 'sqlite', method, args: snapshotArgs }, { coalesceKey })
  }

  recordRunStart (...args) { return this.sqlite('recordRunStart', ...args) }
  recordRunProgress (...args) { return this.sqlite('recordRunProgress', ...args) }
  recordRunClose (...args) { return this.sqlite('recordRunClose', ...args) }
  importJsonDb (...args) { return this.sqlite('importJsonDb', ...args) }
  recordEvents (...args) { return this.sqlite('recordEvents', ...args) }
  recordEvent (...args) { return this.sqlite('recordEvent', ...args) }

  drain (timeoutMs = this.drainTimeoutMs) {
    if (this.drainFailed) return false
    this.pump()
    const deadline = Date.now() + Math.max(1, timeoutMs)
    while (this.pending.length || this.inFlight.size) {
      if (!this.worker || !this.available || Atomics.load(this.shared, 2) !== 0) return false
      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        this.drainFailed = true
        this.warn(`Timed out after ${timeoutMs}ms while draining background diagnostics`)
        return false
      }
      const completed = Atomics.load(this.shared, 0)
      Atomics.wait(this.shared, 0, completed, Math.min(100, remainingMs))
      this.reapCompleted()
      this.pump()
    }
    this.reapCompleted()
    return Atomics.load(this.shared, 2) === 0
  }

  fatalTaskId () {
    return Atomics.load(this.shared, 3)
  }

  close () {
    if (this.closed) return this.closeResult !== false
    let clean = !this.drainFailed && this.drain()
    if (clean && this.sqliteEnabled) clean = this.enqueue({ type: 'sqlite', method: 'close', args: [] })
    if (clean) {
      this.shutdownQueued = this.enqueue({ type: 'shutdown' })
      clean = this.shutdownQueued && this.drain()
    }
    this.closed = true
    if (!clean) {
      this.markUnavailable('Background diagnostics did not shut down cleanly')
      const termination = this.worker?.terminate()
      termination?.catch?.(() => {})
    } else {
      this.worker?.unref()
    }
    this.closeResult = clean && Atomics.load(this.shared, 1) === 0
    return this.closeResult
  }
}

function runPersistenceWorker () {
  const shared = new Int32Array(workerData.shared)
  let ledger
  let fatalTaskId = 0
  try {
    ledger = new PacketCensusSqliteLedger(workerData.sqlite || { enabled: false })
  } catch (error) {
    ledger = null
    Atomics.add(shared, 1, 1)
    parentPort.postMessage({ error: `Could not open SQLite ledger: ${error.stack || error.message || error}` })
  }

  parentPort.on('message', task => {
    // MessagePort.close() stops new messages from arriving, but messages that
    // were already posted can still invoke this handler. Never execute that
    // tail after a failed task: the main thread treats it as unpersisted and
    // may restore it for a later retry.
    if (fatalTaskId > 0) return
    let shutdown = false
    let taskError = null
    let taskWarning = null
    try {
      switch (task.type) {
        case 'append':
          ensureDir(path.dirname(task.file))
          fs.appendFileSync(task.file, task.content)
          break
        case 'write_json':
          atomicWriteJson(task.file, task.value, task.id)
          break
        case 'unlink':
          try {
            fs.unlinkSync(task.file)
          } catch (error) {
            if (error?.code !== 'ENOENT') taskWarning = `Could not prune old diagnostic sample ${task.file}: ${error.message || error}`
          }
          break
        case 'sqlite':
          if (ledger?.enabled && typeof ledger[task.method] === 'function') {
            try {
              ledger[task.method](...(task.args || []))
            } catch (error) {
              Atomics.add(shared, 1, 1)
              taskWarning = `SQLite ${task.method} failed; JSON diagnostics will continue: ${error.stack || error.message || error}`
              try { ledger.close() } catch {}
              ledger = null
            }
          }
          break
        case 'shutdown':
          if (ledger?.enabled) ledger.close()
          shutdown = true
          break
        default:
          throw new Error(`Unknown persistence task: ${task.type}`)
      }
    } catch (error) {
      Atomics.add(shared, 1, 1)
      Atomics.store(shared, 2, 1)
      Atomics.compareExchange(shared, 3, 0, task.id)
      fatalTaskId = task.id
      taskError = `${task.type} task failed: ${error.stack || error.message || error}`
      shutdown = true
    } finally {
      Atomics.store(shared, 0, task.id)
      Atomics.notify(shared, 0)
      // Atomics.notify wakes synchronous drain/backpressure waits, but it does
      // not schedule JavaScript on the main thread. Always send a completion
      // message so an idle queue can reap this task and post its pending tail.
      parentPort.postMessage({ completed: task.id, error: taskError, warning: taskWarning })
      if (shutdown) parentPort.close()
    }
  })
}

function mostCommonKey (counts) {
  let bestKey = null
  let bestCount = -1
  for (const [key, rawCount] of Object.entries(counts || {})) {
    const count = Number(rawCount) || 0
    if (count > bestCount) {
      bestKey = key
      bestCount = count
    }
  }
  return bestKey
}

function createPacketCensusSqliteLedger (options = {}) {
  return new PacketCensusSqliteLedger(options)
}

function createPacketCensusPersistenceQueue (options = {}) {
  return new PacketCensusPersistenceQueue(options)
}

if (!isMainThread && workerData?.packetCensusPersistenceWorker) runPersistenceWorker()

module.exports = {
  PacketCensusSqliteLedger,
  PacketCensusPersistenceQueue,
  createPacketCensusSqliteLedger,
  createPacketCensusPersistenceQueue,
  inferTranslationState,
  inferTranslationStrategy
}
