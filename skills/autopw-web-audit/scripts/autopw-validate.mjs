#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { validateSchema } from './lib/schema-validator.mjs'

const FINAL_STATUSES = new Set(['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN', 'FLAKY'])
const ARTIFACT_KEYS = new Set([
  'artifact',
  'artifacts',
  'state',
  'events',
  'dom_state',
  'screenshot',
  'trace',
  'runner_screenshot'
])

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function stripLocationSuffix(value) {
  return value.replace(/:(\d+)(?::\d+)?$/, '')
}

function resolveLocalPath(value, root) {
  const stripped = stripLocationSuffix(value)
  return path.isAbsolute(stripped) ? path.resolve(stripped) : path.resolve(root, stripped)
}

function timingErrors(timing, label) {
  const errors = []
  const started = Date.parse(timing?.started_at)
  const finished = Date.parse(timing?.finished_at)
  const duration = timing?.duration_ms
  if (!Number.isFinite(started)) errors.push(`${label}.started_at`)
  if (!Number.isFinite(finished)) errors.push(`${label}.finished_at`)
  if (!Number.isFinite(duration) || duration < 0) errors.push(`${label}.duration_ms`)
  if (
    Number.isFinite(started) &&
    Number.isFinite(finished) &&
    Number.isFinite(duration) &&
    Math.abs(finished - started - duration) > 1000
  ) {
    errors.push(`${label}.consistency`)
  }
  return errors
}

function walkFiles(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(candidate))
    else files.push(candidate)
  }
  return files
}

function markdownTargets(markdown) {
  const targets = []
  const pattern = /!?\[[^\]]*\]\(([^)]+)\)/g
  for (const match of markdown.matchAll(pattern)) {
    let target = match[1].trim()
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    if (/^(?:https?:|mailto:|data:|#)/i.test(target)) continue
    target = target.split('#', 1)[0]
    if (target.length > 0) targets.push(decodeURIComponent(target))
  }
  return targets
}

function reportCountSets(markdown) {
  const matches = []
  const labels = {
    '通过': 'PASS',
    '失败/发现问题': 'FAIL',
    '阻塞': 'BLOCKED',
    '未执行/超出范围': 'NOT_RUN',
    '不稳定': 'FLAKY'
  }
  const tableCounts = {}
  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.replaceAll('*', '').trim())
    const status = labels[cells[0]]
    if (status && /^\d+$/.test(cells[1] ?? '')) tableCounts[status] = Number(cells[1])
  }
  if (Object.keys(tableCounts).length === 5) matches.push(tableCounts)

  const pattern = /(\d+)\s*PASS[^\r\n]{0,40}?(\d+)\s*FAIL[^\r\n]{0,40}?(\d+)\s*BLOCKED[^\r\n]{0,40}?(\d+)\s*NOT_RUN[^\r\n]{0,40}?(\d+)\s*FLAKY/g
  for (const line of markdown.split(/\r?\n/).filter((item) => /冻结用例|状态/.test(item))) {
    for (const match of line.matchAll(pattern)) {
      matches.push({
        PASS: Number(match[1]),
        FAIL: Number(match[2]),
        BLOCKED: Number(match[3]),
        NOT_RUN: Number(match[4]),
        FLAKY: Number(match[5])
      })
    }
  }
  return matches
}

function evidencePaths(value, currentKey = null, output = []) {
  if (Array.isArray(value)) {
    for (const item of value) evidencePaths(item, currentKey, output)
    return output
  }
  if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) evidencePaths(item, key, output)
    return output
  }
  if (typeof value === 'string' && (ARTIFACT_KEYS.has(currentKey) || currentKey === 'files')) {
    output.push({ value, sourceReference: currentKey === 'files' })
  }
  return output
}

function addError(errors, code, message, details = {}) {
  errors.push({ code, message, ...details })
}

function allowedLane(planCase, lane) {
  if (lane === 'MCP_DIAGNOSTIC') return planCase.channel === 'BROWSER'
  if (planCase.channel === 'BROWSER') return lane === 'PLAYWRIGHT_TEST'
  if (planCase.channel === 'STATIC') return lane === 'STATIC'
  if (planCase.channel === 'LOG_STATE') return lane === 'LOG_STATE' || lane === 'API'
  return lane === 'API'
}

function latestAttempt(entries) {
  return [...entries].sort((left, right) => left.result.attempt - right.result.attempt).at(-1)
}

function discoverLaneFiles(runRoot) {
  return walkFiles(runRoot)
    .filter((filePath) => path.basename(filePath) === 'lane-result.json')
    .sort()
}

function validateArtifacts(result, runRoot, errors, counters) {
  if (!isObject(result.evidence) || Object.keys(result.evidence).length === 0) {
    if (!['BLOCKED', 'NOT_RUN'].includes(result.status)) {
      addError(errors, 'EVIDENCE.MISSING', `${result.case_id} has no evidence`, {
        case_id: result.case_id
      })
    }
    return
  }
  for (const item of evidencePaths(result.evidence)) {
    const candidate = resolveLocalPath(item.value, runRoot)
    counters.artifacts_checked += 1
    if (!item.sourceReference && !within(runRoot, candidate)) {
      addError(errors, 'ARTIFACT.OUTSIDE_RUN_ROOT', `${result.case_id} artifact escapes run root`, {
        case_id: result.case_id,
        path: item.value
      })
    } else if (!fs.existsSync(candidate)) {
      addError(errors, 'ARTIFACT.MISSING', `${result.case_id} evidence path does not exist`, {
        case_id: result.case_id,
        path: item.value
      })
    }
  }
}

export function validateRun({ planPath, runRoot, reportPath }) {
  const absolutePlan = path.resolve(planPath)
  const absoluteRunRoot = path.resolve(runRoot)
  const absoluteReport = path.resolve(reportPath)
  const errors = []
  const warnings = []
  const counters = { artifacts_checked: 0, report_links_checked: 0 }

  for (const [label, candidate] of [
    ['plan', absolutePlan],
    ['run_root', absoluteRunRoot],
    ['report', absoluteReport]
  ]) {
    if (!fs.existsSync(candidate)) addError(errors, 'INPUT.MISSING', `${label} does not exist`, { path: candidate })
  }
  if (errors.length > 0) return finish(null, [], {}, errors, warnings, counters)

  let plan
  try {
    plan = readJson(absolutePlan)
  } catch (error) {
    addError(errors, 'PLAN.INVALID_JSON', error.message, { path: absolutePlan })
    return finish(null, [], {}, errors, warnings, counters)
  }

  const planSchema = validateSchema('execution-plan', plan)
  if (!planSchema.valid) {
    addError(errors, 'PLAN.INVALID_SCHEMA', 'Execution plan does not match its schema', {
      path: absolutePlan,
      schema_errors: planSchema.errors
    })
    return finish(plan?.run_id ?? null, [], {}, errors, warnings, counters)
  }

  const sessionPath = path.join(absoluteRunRoot, 'audit-session.json')
  let auditSession = null
  if (!fs.existsSync(sessionPath)) {
    addError(errors, 'TIMING.MISSING_SESSION', 'audit-session.json is required for wall-clock accounting', {
      path: sessionPath
    })
  } else {
    try {
      auditSession = readJson(sessionPath)
      const sessionSchema = validateSchema('audit-session', auditSession)
      if (!sessionSchema.valid) {
        addError(errors, 'TIMING.INVALID_SESSION', 'audit-session.json does not match its schema', {
          path: sessionPath,
          schema_errors: sessionSchema.errors
        })
      } else {
        if (auditSession.run_id !== plan.run_id) addError(errors, 'TIMING.SESSION_RUN_MISMATCH', 'Audit session run_id differs from the plan')
        for (const field of timingErrors(auditSession, 'audit-session')) {
          addError(errors, 'TIMING.INVALID_SESSION', `Invalid audit session timing: ${field}`)
        }
      }
    } catch (error) {
      addError(errors, 'TIMING.INVALID_SESSION_JSON', error.message, { path: sessionPath })
    }
  }

  const planById = new Map()
  for (const testCase of plan.cases) {
    if (planById.has(testCase.id)) {
      addError(errors, 'PLAN.DUPLICATE_CASE', `Duplicate plan id: ${testCase.id}`, { case_id: testCase.id })
    } else {
      planById.set(testCase.id, testCase)
    }
  }

  const laneFiles = discoverLaneFiles(absoluteRunRoot)
  if (laneFiles.length === 0) addError(errors, 'EXECUTION.NO_LANE_RESULTS', 'No lane-result.json files found')
  const laneDocuments = []
  const primaryByCase = new Map()
  const mcpByCase = new Map()

  for (const laneFile of laneFiles) {
    let lane
    try {
      lane = readJson(laneFile)
    } catch (error) {
      addError(errors, 'EXECUTION.INVALID_JSON', error.message, { path: laneFile })
      continue
    }
    const laneSchema = validateSchema('lane-result', lane)
    if (!laneSchema.valid) {
      addError(errors, 'EXECUTION.INVALID_SCHEMA', 'Lane result does not match its schema', {
        path: laneFile,
        schema_errors: laneSchema.errors
      })
      continue
    }
    laneDocuments.push(lane)
    if (lane.run_id !== plan.run_id) {
      addError(errors, 'RUN.ID_MISMATCH', `${laneFile} has a different run_id`, { path: laneFile })
    }
    for (const field of timingErrors(lane, `lane:${lane.lane ?? 'UNKNOWN'}`)) {
      addError(errors, 'EXECUTION.INVALID_TIMING', `Invalid timing field: ${field}`, { path: laneFile })
    }
    for (const result of lane.cases) {
      const planCase = planById.get(result?.case_id)
      if (!planCase) {
        addError(errors, 'EXECUTION.UNPLANNED_CASE', `Lane contains unplanned case: ${result?.case_id}`, {
          case_id: result?.case_id,
          path: laneFile
        })
        continue
      }
      if (!allowedLane(planCase, lane.lane)) {
        addError(errors, 'EXECUTION.WRONG_LANE', `${result.case_id} cannot run in ${lane.lane}`, {
          case_id: result.case_id,
          path: laneFile
        })
      }
      for (const field of timingErrors(result.timing, `case:${result.case_id}:attempt:${result.attempt}`)) {
        addError(errors, 'EXECUTION.INVALID_TIMING', `Invalid timing field: ${field}`, { case_id: result.case_id })
      }
      validateArtifacts(result, absoluteRunRoot, errors, counters)
      const collection = lane.lane === 'MCP_DIAGNOSTIC' ? mcpByCase : primaryByCase
      if (!collection.has(result.case_id)) collection.set(result.case_id, [])
      collection.get(result.case_id).push({ lane: lane.lane, result, laneFile })
    }
  }

  const frozenAt = Date.parse(plan.frozen_at)
  const laneStarts = laneDocuments.map((lane) => Date.parse(lane.started_at)).filter(Number.isFinite)
  if (!Number.isFinite(frozenAt)) {
    addError(errors, 'PLAN.INVALID_FROZEN_AT', 'Plan frozen_at is not a valid date-time')
  } else if (laneStarts.some((started) => started < frozenAt)) {
    addError(errors, 'EXECUTION.BEFORE_FREEZE', 'At least one lane started before the plan was frozen')
  }

  for (const [collection, duplicateCode] of [
    [primaryByCase, 'DUPLICATE_PRIMARY_LANE'],
    [mcpByCase, 'DUPLICATE_MCP_LANE']
  ]) {
    for (const [caseId, entries] of collection) {
      const attempts = entries.map((entry) => entry.result.attempt).sort((a, b) => a - b)
      const unique = new Set(attempts)
      const expected = attempts.length === 2 ? [1, 2] : [1]
      if (unique.size !== attempts.length || JSON.stringify(attempts) !== JSON.stringify(expected)) {
        addError(errors, 'EXECUTION.INVALID_ATTEMPT_SEQUENCE', `${caseId} attempts must be [1] or [1,2]`, {
          case_id: caseId,
          attempts
        })
      }
      const lanes = new Set(entries.map((entry) => entry.lane))
      if (lanes.size > 1) {
        addError(errors, `EXECUTION.${duplicateCode}`, `${caseId} appears in multiple ${duplicateCode === 'DUPLICATE_PRIMARY_LANE' ? 'primary' : 'MCP'} lanes`, {
          case_id: caseId
        })
      }
    }
  }

  const routerPath = path.join(absoluteRunRoot, 'router', 'decisions.json')
  const browserIds = [...planById.values()].filter((item) => item.channel === 'BROWSER').map((item) => item.id)
  const decisionsById = new Map()
  if (browserIds.length > 0) {
    if (!fs.existsSync(routerPath)) {
      addError(errors, 'ROUTER.MISSING_DECISIONS', 'Browser cases require router/decisions.json', { path: routerPath })
    } else {
      try {
        const router = readJson(routerPath)
        const routerSchema = validateSchema('router-decision', router)
        if (!routerSchema.valid) {
          addError(errors, 'ROUTER.INVALID_SCHEMA', 'Router decision does not match its schema', {
            path: routerPath,
            schema_errors: routerSchema.errors
          })
        } else {
          if (router.run_id !== plan.run_id) addError(errors, 'RUN.ID_MISMATCH', 'Router run_id differs from plan')
          for (const decision of router.decisions) {
            if (decisionsById.has(decision.case_id)) {
              addError(errors, 'ROUTER.DUPLICATE_DECISION', `Duplicate router decision: ${decision.case_id}`)
            } else {
              decisionsById.set(decision.case_id, decision)
            }
          }
        }
      } catch (error) {
        addError(errors, 'ROUTER.INVALID_JSON', error.message, { path: routerPath })
      }
    }
  }

  for (const caseId of mcpByCase.keys()) {
    const decision = decisionsById.get(caseId)
    if (decision?.next_action !== 'START_MCP') {
      addError(errors, 'MCP.UNAUTHORIZED_EXECUTION', `${caseId} has MCP evidence without START_MCP authorization`, {
        case_id: caseId
      })
    }
  }

  if (mcpByCase.size > 0) {
    const importedArtifacts = [...mcpByCase.values()]
      .flat()
      .flatMap((entry) => evidencePaths(entry.result.evidence ?? {}))
      .filter((item) => !item.sourceReference)
      .map((item) => item.value)
    if (importedArtifacts.length > 0) {
      const manifestPath = path.join(absoluteRunRoot, 'mcp', 'evidence-manifest.json')
      if (!fs.existsSync(manifestPath)) {
        addError(errors, 'MCP.MISSING_EVIDENCE_MANIFEST', 'MCP evidence must be imported through the run-root manifest')
      } else {
        try {
          const manifest = readJson(manifestPath)
          const byPath = new Map((manifest.artifacts ?? []).map((item) => [item.path, item]))
          for (const artifact of importedArtifacts) {
            const normalized = path.isAbsolute(artifact)
              ? path.relative(absoluteRunRoot, artifact).split(path.sep).join('/')
              : artifact.split(path.sep).join('/')
            const entry = byPath.get(normalized)
            if (!entry) {
              addError(errors, 'MCP.UNIMPORTED_EVIDENCE', `MCP artifact is absent from evidence-manifest.json: ${artifact}`)
              continue
            }
            const candidate = path.resolve(absoluteRunRoot, normalized)
            if (fs.existsSync(candidate) && sha256(candidate) !== entry.sha256) {
              addError(errors, 'MCP.EVIDENCE_CHECKSUM_MISMATCH', `MCP artifact checksum differs from its manifest: ${artifact}`)
            }
          }
        } catch (error) {
          addError(errors, 'MCP.INVALID_EVIDENCE_MANIFEST', error.message, { path: manifestPath })
        }
      }
    }
  }

  const finalStatuses = {}
  for (const [caseId, planCase] of planById) {
    const primary = primaryByCase.get(caseId) ?? []
    if (primary.length === 0) {
      finalStatuses[caseId] = 'NOT_RUN'
      addError(errors, 'EXECUTION.MISSING_RESULT', `No primary result for ${caseId}`, { case_id: caseId })
      continue
    }
    const latest = latestAttempt(primary).result
    finalStatuses[caseId] = latest.status
    if (planCase.channel !== 'BROWSER') continue

    const decision = decisionsById.get(caseId)
    if (!decision) {
      continue
    }
    if (!['DONE', 'START_MCP'].includes(decision.next_action)) {
      addError(errors, 'ROUTER.NON_TERMINAL_ACTION', `${caseId} ended at ${decision.next_action}`, {
        case_id: caseId
      })
    }
    if (decision.next_action === 'DONE') {
      finalStatuses[caseId] = decision.final_status
      const compatible =
        decision.final_status === latest.status ||
        (decision.final_status === 'FLAKY' && primary.length === 2) ||
        (decision.final_status === 'BLOCKED' && latest.failure_type === 'INFRASTRUCTURE')
      if (!compatible) {
        addError(errors, 'ROUTER.STATUS_MISMATCH', `${caseId} final status does not match execution facts`, {
          case_id: caseId,
          lane_status: latest.status,
          final_status: decision.final_status
        })
      }
    }
    if (decision.next_action === 'START_MCP') {
      const diagnostic = mcpByCase.get(caseId) ?? []
      if (diagnostic.length === 0) {
        addError(errors, 'MCP.MISSING_RESULT', `${caseId} START_MCP has no MCP_DIAGNOSTIC result`, { case_id: caseId })
      } else if (latestAttempt(diagnostic).result.status === 'BLOCKED') {
        finalStatuses[caseId] = 'BLOCKED'
      } else {
        finalStatuses[caseId] = 'FAIL'
      }
    }
  }

  for (const decisionId of decisionsById.keys()) {
    if (!browserIds.includes(decisionId)) {
      addError(errors, 'ROUTER.UNEXPECTED_DECISION', `Router contains non-browser or unplanned case: ${decisionId}`)
    }
  }
  for (const browserId of browserIds) {
    if (!decisionsById.has(browserId)) addError(errors, 'ROUTER.MISSING_DECISION', `No router decision for ${browserId}`)
  }

  const markdown = fs.readFileSync(absoluteReport, 'utf8')
  if (auditSession) {
    const match = markdown.match(/审查会话总耗时[^\r\n]*?(\d+)\s*ms/i)
    if (!match) {
      addError(errors, 'REPORT.MISSING_SESSION_DURATION', 'Report must include “审查会话总耗时: <ms> ms”')
    } else if (Math.abs(Number(match[1]) - auditSession.duration_ms) > 1000) {
      addError(errors, 'REPORT.SESSION_DURATION_MISMATCH', 'Report wall-clock duration differs from audit-session.json', {
        expected: auditSession.duration_ms,
        actual: Number(match[1])
      })
    }
  }
  for (const target of markdownTargets(markdown)) {
    const candidate = resolveLocalPath(target, path.dirname(absoluteReport))
    counters.report_links_checked += 1
    if (!fs.existsSync(candidate)) {
      addError(errors, 'REPORT.MISSING_LINK', 'Report local link does not exist', { path: target })
    }
  }
  for (const caseId of planById.keys()) {
    if (!markdown.includes(caseId)) {
      addError(errors, 'REPORT.MISSING_CASE', `${caseId} is not referenced in the report`, { case_id: caseId })
    }
  }

  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, FLAKY: 0 }
  for (const status of Object.values(finalStatuses)) {
    if (FINAL_STATUSES.has(status)) counts[status] += 1
  }
  const reportedCounts = reportCountSets(markdown)
  if (reportedCounts.length === 0) {
    addError(errors, 'REPORT.MISSING_COUNTS', 'Report must contain PASS/FAIL/BLOCKED/NOT_RUN/FLAKY counts')
  } else {
    for (const reported of reportedCounts) {
      if (JSON.stringify(reported) !== JSON.stringify(counts)) {
        addError(errors, 'REPORT.COUNT_MISMATCH', 'Report counts do not match validated case results', {
          expected: counts,
          actual: reported
        })
      }
    }
  }

  return finish(plan.run_id, laneFiles, counts, errors, warnings, counters, finalStatuses)
}

function finish(runId, laneFiles, counts, errors, warnings, counters, finalStatuses = {}) {
  errors.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  const normalizedCounts = { PASS: 0, FAIL: 0, BLOCKED: 0, NOT_RUN: 0, FLAKY: 0, ...counts }
  return {
    valid: errors.length === 0,
    run_id: runId,
    summary: {
      planned: Object.keys(finalStatuses).length,
      ...normalizedCounts,
      lanes: laneFiles.length,
      ...counters
    },
    final_statuses: finalStatuses,
    errors,
    warnings
  }
}

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (['--plan', '--run-root', '--report', '--output'].includes(item)) {
      args[item.slice(2).replace('-', '_')] = argv[index + 1]
      index += 1
    } else if (item === '--help' || item === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${item}`)
    }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.plan || !args.run_root || !args.report) {
    process.stdout.write(
      'Usage: node autopw-validate.mjs --plan <execution-plan.json> --run-root <runs/run-id> --report <report.md> [--output <validation.json>]\n'
    )
    process.exitCode = args.help ? 0 : 2
    return
  }
  const result = validateRun({ planPath: args.plan, runRoot: args.run_root, reportPath: args.report })
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (args.output) {
    const outputPath = path.resolve(args.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output, 'utf8')
  }
  process.stdout.write(output)
  process.exitCode = result.valid ? 0 : 1
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 2
  }
}
