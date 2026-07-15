'use strict'

const fs = require('fs')
const path = require('path')
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

module.exports = {
  PacketCensusSqliteLedger,
  createPacketCensusSqliteLedger,
  inferTranslationState,
  inferTranslationStrategy
}
