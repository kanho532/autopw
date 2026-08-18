#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export {
  compareExecutionContexts,
  compareSignatures,
  evaluateEvidence,
  routeCase,
  routeInput
} from './router/index.mjs'

import { routeInput } from './router/index.mjs'

function parseArgs(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--input' || item === '--output') {
      args[item.slice(2)] = argv[index + 1]
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
  if (args.help || !args.input) {
    process.stdout.write('Usage: node autopw-router.mjs --input <router-input.json> [--output <decisions.json>]\n')
    process.exitCode = args.help ? 0 : 2
    return
  }
  const input = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf8'))
  const output = `${JSON.stringify(routeInput(input), null, 2)}\n`
  if (args.output) {
    const outputPath = path.resolve(args.output)
    fs.mkdirSync(path.dirname(outputPath), { recursive: true })
    fs.writeFileSync(outputPath, output, 'utf8')
  } else {
    process.stdout.write(output)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
