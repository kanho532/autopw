import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from '@playwright/test'

const runtimeDirectory = path.dirname(fileURLToPath(import.meta.url))
const testDirectory = path.resolve(process.env.AUTOPW_TEST_DIR ?? path.join(runtimeDirectory, 'generated'))
const outputDirectory = path.resolve(process.env.AUTOPW_OUTPUT_DIR ?? path.join(testDirectory, '..', 'playwright', 'test-results'))
const reporterPath = path.resolve(process.env.AUTOPW_REPORTER_PATH ?? path.join(runtimeDirectory, 'reporter.cjs'))
const timingOutput = path.resolve(process.env.AUTOPW_TIMING_OUTPUT ?? path.join(outputDirectory, '..', 'autopw-playwright-timings.json'))

export default defineConfig({
  testDir: testDirectory,
  outputDir: outputDirectory,
  fullyParallel: false,
  workers: Number(process.env.AUTOPW_WORKERS ?? 1),
  reporter: [[reporterPath, { outputFile: timingOutput }]],
  use: {
    browserName: 'chromium',
    baseURL: process.env.AUTOPW_BASE_URL || undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off'
  }
})

