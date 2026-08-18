import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function within(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export class EvidenceImporter {
  constructor({ runRoot, sourceRoots = [] }) {
    this.runRoot = path.resolve(runRoot)
    this.sourceRoots = sourceRoots.map((root) => path.resolve(root))
    this.entries = []
    this.manifestPath = path.join(this.runRoot, 'mcp', 'evidence-manifest.json')
  }

  import(sourcePath, destination) {
    const source = path.resolve(sourcePath)
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) throw new Error(`MCP evidence file is missing: ${source}`)
    if (this.sourceRoots.length > 0 && !this.sourceRoots.some((root) => within(root, source))) {
      throw new Error(`MCP evidence source is outside configured staging roots: ${source}`)
    }
    const relative = path.normalize(destination)
    const target = path.resolve(this.runRoot, relative)
    if (!within(this.runRoot, target)) throw new Error(`MCP evidence destination escapes run root: ${destination}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
    const entry = {
      source,
      path: path.relative(this.runRoot, target).split(path.sep).join('/'),
      sha256: sha256(target),
      size: fs.statSync(target).size,
      imported_at: new Date().toISOString()
    }
    this.entries.push(entry)
    this.persist()
    return entry.path
  }

  persist() {
    fs.mkdirSync(path.dirname(this.manifestPath), { recursive: true })
    fs.writeFileSync(
      this.manifestPath,
      `${JSON.stringify({ version: 1, artifacts: this.entries }, null, 2)}\n`,
      'utf8'
    )
  }
}

