'use strict'

// Antora generator extension: make Kroki PlantUML diagrams referenced by Antora resource id work in
// Antora Assembler exports (PDF, EPUB, HTML single), which are converted by the Ruby
// `asciidoctor-pdf -r asciidoctor-kroki` and not by the Antora-aware JavaScript kroki extension.
//
// The contract this supports: pages reference diagram sources by resource id,
//
//   plantuml::example$order-model.puml[align=center]
//
// while the .puml files themselves use plain relative PlantUML includes (`!include ./layout/colors.puml`),
// so they stay standalone-valid for the PlantUML plugin / CLI. The HTML site handles this already
// (asciidoctor-kroki 0.18.x resolves the macro target through the content catalog and joins relative
// includes against it). The Assembler, however, pipes the merged AsciiDoc to a Ruby process that
// knows nothing about resource ids: the macro target `example$order-model.puml` is not a path.
//
// This extension wraps Antora's `loadAsciiDoc` generator function and, only when the Assembler is the
// caller (intrinsic `loader-assembler` attribute), rewrites each page's source lines in place before the
// Assembler merges them: it writes the referenced resource family (the module's `examples/` tree, layout
// intact) to <export_dir>/<component>/<version>/<module>/<family>/ and points the macro at the exported file:
//
//   plantuml::/antora/build/assembler/resources/demo/1.0/ROOT/example/order-model.puml[align=center]
//
// The asciidoctor-kroki gem (2.0+, shipped in the vc-antora image) then resolves the diagram's relative
// `!include`s from that file's directory itself. Nothing Antora-specific reaches Ruby. This mirrors what
// the Assembler already does for `image$` targets and is the behavior proposed for the Assembler itself;
// once it has it, this extension retires. The regular HTML build is untouched.
//
// Playbook, next to @antora/pdf-extension:
//   antora:
//     extensions:
//       - '@antora/pdf-extension'
//       - require: ./extensions/antora-assembler-kroki.js
//         export_dir: build/assembler/resources   # relative to the playbook dir (default)
//         macros: [plantuml, c4plantuml]          # block macro names to handle (default)
//
// Constraints:
// - The converter needs the asciidoctor-kroki gem 2.0 or later (its include preprocessor resolves the
//   exported files' relative includes). Only prereleases exist so far: `gem install asciidoctor-kroki --pre`
//   (the Dockerfile pins one). Gem 1.x sends the `!include` lines to the Kroki server unresolved, which drops
//   them silently.
// - The macro target is an absolute path. The gem resolves it with Asciidoctor's `normalize_system_path`, so
//   the converter must run in unsafe mode (the asciidoctor-pdf CLI default) or `export_dir` must lie inside
//   the converter's base directory (the Assembler's `build.cwd`, the playbook dir by default). In safe mode
//   with an `export_dir` outside of it, Asciidoctor re-roots the path and every diagram fails to load.
// - Not handled: the `kroki-plantuml-include` attribute (the Ruby gem prepends it itself).
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_MACROS = ['plantuml', 'c4plantuml']
const DEFAULT_EXPORT_DIR = 'build/assembler/resources'
const DELIMITER_CHARS = ['-', '.', '+']

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Write every file of one resource family (component/version/module) below exportDir, once per run.
// The family's directory is replaced, so files deleted or renamed since the last run do not linger
// (the kroki gem skips an unresolvable include silently, a stale copy would mask that).
// Returns the directory that holds the family.
function exportFamily (contentCatalog, src, exportDir, exported) {
  const { component, version, module: module_, family } = src
  const key = [component, version, module_, family].join('|')
  const dir = path.join(exportDir, component, version || '_', module_, family)
  if (exported.has(key)) return dir
  fs.rmSync(dir, { recursive: true, force: true })
  for (const file of contentCatalog.findBy({ component, version, module: module_, family })) {
    const target = path.join(dir, file.src.relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.contents)
  }
  exported.add(key)
  return dir
}

// Indices of the source lines where a macro is literal text and must not be rewritten: the lines (delimiters
// included) of verbatim, passthrough and substitution-free blocks, e.g. a documented sample in a listing.
// Same approach as the Assembler's own image macro rewrite; relies on the sourcemap the Assembler enables.
function literalLineIndices (doc, lines) {
  const indices = new Set()
  const literal = (block) =>
    ['verbatim', 'raw', 'simple'].includes(block.content_model) && !block.hasSubstitution('macros')
  for (const block of doc.findBy({ traverse_documents: true }, literal)) {
    const lineno = block.getLineNumber()
    if (typeof lineno !== 'number' || !Array.isArray(block.lines)) continue
    const idx = lineno - 1
    const startLine = lines[idx]
    if (startLine == null) continue
    const char0 = startLine.charAt(0)
    const delimited =
      startLine.length > 3 && DELIMITER_CHARS.includes(char0) && startLine === char0.repeat(startLine.length)
    for (let i = idx, end = idx + block.lines.length + (delimited ? 2 : 0); i < end; i++) indices.add(i)
  }
  return indices
}

function isCommentFence (line) {
  return line.length > 3 && line.charAt(0) === '/' && line === '/'.repeat(line.length)
}

// Rewrite the (include-expanded) source lines of the loaded page in place. Returns true when a line changed.
function rewritePage (doc, file, contentCatalog, opts, logger) {
  const { macroRx, exportDir, exported } = opts
  const pagePath = file.src.path || file.path
  const lines = doc.getSourceLines()
  const literalLines = literalLineIndices(doc, lines)
  let changed = false
  let commentFence
  lines.forEach((line, idx) => {
    if (isCommentFence(line)) {
      if (!commentFence) commentFence = line
      else if (line === commentFence) commentFence = undefined
      return
    }
    if (commentFence || literalLines.has(idx)) return
    const m = macroRx.exec(line)
    if (!m) return
    const [, type, target, attrlist] = m
    // only resource ids; a plain path is read from the file system by the HTML build and the converter alike
    if (!target.includes('$')) return
    const resource = contentCatalog.resolveResource(target, file.src, 'example')
    if (!resource) {
      logger.warn(
        { file: { path: pagePath }, line: idx + 1 },
        `${type} block macro target not found in the content catalog: ${target}`
      )
      return
    }
    const familyDir = exportFamily(contentCatalog, resource.src, exportDir, exported)
    lines[idx] = `${type}::${path.join(familyDir, resource.src.relative)}[${attrlist}]`
    changed = true
  })
  return changed
}

// NOTE: keep exactly one declared parameter without a default value. Antora decides by `register.length`
// whether to pass `{ config, playbook, ... }` at all; a parameter with a default value does not count.
module.exports.register = function register ({ config = {}, playbook }) {
  const logger = this.getLogger('antora-assembler-kroki')
  const playbookDir = (playbook && playbook.dir) || process.cwd()
  const macros = Array.isArray(config.macros) && config.macros.length ? config.macros : DEFAULT_MACROS
  const macroRx = new RegExp(`^(${macros.map(escapeRegExp).join('|')})::(\\S+?)\\[(.*)\\]\\s*$`)
  const exportDir = path.resolve(playbookDir, config.export_dir || DEFAULT_EXPORT_DIR)
  const opts = { macroRx, exportDir, exported: new Set() }
  // Chain to a replacement an earlier extension registered; Antora binds the built-in function only after all
  // extensions registered, so it is absent here and has to be required.
  const loadAsciiDoc = this.getFunctions().loadAsciiDoc || this.require('@antora/asciidoc-loader')
  this.replaceFunctions({
    loadAsciiDoc (file, contentCatalog, asciidocConfig = {}) {
      const doc = loadAsciiDoc(file, contentCatalog, asciidocConfig)
      const attrs = asciidocConfig.attributes || {}
      if (asciidocConfig.headerOnly || !contentCatalog || !('loader-assembler' in attrs)) return doc
      // the Assembler merges exactly these source lines, so the in-place rewrite is all it takes
      rewritePage(doc, file, contentCatalog, opts, logger)
      return doc
    },
  })
}
