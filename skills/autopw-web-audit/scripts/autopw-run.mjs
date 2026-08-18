#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { orchestrateRun } from './orchestration/run.mjs'

export { orchestrateRun } from './orchestration/run.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (['--plan', '--run-root', '--executor-module', '--output'].includes(item)) {
      args[item.slice(2).replaceAll('-', '_')] = argv[index + 1]
      index += 1
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
    process.stdout.write('Usage: node autopw-run.mjs --plan <execution-plan.json> --run-root <runs/run-id> --executor-module <executors.mjs> [--output <run-summary.json>]\n')
    process.exitCode = args.help ? 0 : 2
    return
  }
  const plan = JSON.parse(fs.readFileSync(path.resolve(args.plan), 'utf8'))
  const module = await import(pathToFileURL(path.resolve(args.executor_module)).href)
  const executors = typeof module.createExecutors === 'function'
    ? await module.createExecutors({ plan, runRoot: path.resolve(args.run_root) })
    : module.executors ?? module.default
  const result = await orchestrateRun({ plan, runRoot: args.run_root, executors })
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
