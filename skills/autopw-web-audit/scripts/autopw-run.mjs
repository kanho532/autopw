#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

import { orchestrateRun } from './orchestration/run.mjs'
import { createPlaywrightExecutor } from './executors/playwright.mjs'

export { orchestrateRun } from './orchestration/run.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (['--plan', '--run-root', '--executor-module', '--output', '--playwright-mode', '--project-root'].includes(item)) {
      args[item.slice(2).replaceAll('-', '_')] = argv[index + 1]
      index += 1
    } else if (item === '--mcp-staging-root') {
      if (!args.mcp_staging_roots) args.mcp_staging_roots = []
      args.mcp_staging_roots.push(argv[index + 1])
      index += 1
    } else if (item === '--resume') {
      args.resume = true
    } else if (item === '--help' || item === '-h') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${item}`)
    }
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.plan || !args.run_root || !args.executor_module) {
    process.stdout.write('Usage: node autopw-run.mjs --plan <execution-plan.json> --run-root <runs/run-id> --executor-module <executors.mjs> [--playwright-mode AUTOPW_RUNTIME|PROJECT_NATIVE] [--project-root <target-repo>] [--resume] [--mcp-staging-root <dir>] [--output <run-summary.json>]\n')
    process.exitCode = args.help ? 0 : 2
    return
  }
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), 'utf8'))
  const executorPath = path.resolve(args.executor_module)
  const module = await import(pathToFileURL(executorPath).href)
  const playwrightMode = args.playwright_mode ?? plan.environment?.playwright?.mode ?? 'AUTOPW_RUNTIME'
  const runRoot = path.resolve(args.run_root)
  const created = typeof module.createExecutors === 'function'
    ? await module.createExecutors({ plan, runRoot, playwrightMode })
    : module.executors ?? module.default
  const customExecutors = created?.executors ?? created ?? {}
  const executors = {
    PLAYWRIGHT_TEST: createPlaywrightExecutor({
      plan,
      runRoot,
      projectRoot: args.project_root ?? plan.target?.repository,
      mode: playwrightMode
    }),
    ...customExecutors
  }
  const lifecycle = created?.lifecycle ?? module.lifecycle ?? {}
  const executorFingerprint = crypto.createHash('sha256').update(fs.readFileSync(executorPath)).digest('hex')
  const result = await orchestrateRun({
    plan,
    runRoot,
    executors,
    lifecycle,
    resume: Boolean(args.resume),
    executorFingerprint,
    mcpStagingRoots: (args.mcp_staging_roots ?? []).map((root) => path.resolve(root))
  })
  const output = `${JSON.stringify(result, null, 2)}\n`
  if (args.output) {
    const outputPath = path.resolve(args.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output, 'utf8')
  }
  process.stdout.write(output)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
