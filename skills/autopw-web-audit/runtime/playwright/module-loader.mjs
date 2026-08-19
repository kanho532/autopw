import path from 'node:path'
import { pathToFileURL } from 'node:url'

const packageRoot = process.env.AUTOPW_BUNDLED_PLAYWRIGHT_PACKAGE_ROOT

const aliases = packageRoot
  ? new Map([
      ['@playwright/test', path.join(packageRoot, 'index.mjs')],
      ['playwright/test', path.resolve(packageRoot, '../../playwright', 'test.mjs')],
      ['playwright', path.resolve(packageRoot, '../../playwright', 'index.mjs')]
    ])
  : new Map()

export async function resolve(specifier, context, nextResolve) {
  const target = aliases.get(specifier)
  if (target) return { url: pathToFileURL(target).href, shortCircuit: true }
  return nextResolve(specifier, context)
}
