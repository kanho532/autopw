import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const referencesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../references')
const schemaFiles = [
  'execution-plan.schema.json',
  'audit-session.schema.json',
  'lane-result.schema.json',
  'router-input.schema.json',
  'router-decision.schema.json'
]

const ajv = new Ajv2020({ allErrors: true, strict: false })
addFormats(ajv)

const schemaIds = new Map()
for (const fileName of schemaFiles) {
  const schema = JSON.parse(fs.readFileSync(path.join(referencesRoot, fileName), 'utf8'))
  ajv.addSchema(schema)
  schemaIds.set(fileName, schema.$id)
}

const aliases = new Map([
  ['execution-plan', schemaIds.get('execution-plan.schema.json')],
  ['audit-session', schemaIds.get('audit-session.schema.json')],
  ['lane-result', schemaIds.get('lane-result.schema.json')],
  ['router-input', schemaIds.get('router-input.schema.json')],
  ['router-case', `${schemaIds.get('router-input.schema.json')}#/$defs/router_case`],
  ['router-decision', schemaIds.get('router-decision.schema.json')]
])

function validatorFor(name) {
  const id = aliases.get(name) ?? schemaIds.get(name) ?? name
  const validator = ajv.getSchema(id)
  if (!validator) throw new Error(`Unknown AutoPW schema: ${name}`)
  return validator
}

export function formatSchemaErrors(errors = []) {
  return errors.map((error) => ({
    path: error.instancePath || '/',
    keyword: error.keyword,
    message: error.message ?? 'schema validation failed',
    params: error.params
  }))
}

export function validateSchema(name, data) {
  const validator = validatorFor(name)
  const valid = validator(data)
  return { valid: Boolean(valid), errors: valid ? [] : formatSchemaErrors(validator.errors) }
}

export class SchemaValidationError extends Error {
  constructor(name, errors) {
    super(`${name} schema validation failed: ${JSON.stringify(errors)}`)
    this.name = 'SchemaValidationError'
    this.schema = name
    this.errors = errors
  }
}

export function assertSchema(name, data) {
  const result = validateSchema(name, data)
  if (!result.valid) throw new SchemaValidationError(name, result.errors)
  return data
}
