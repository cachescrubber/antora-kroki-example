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
// caller (intrinsic `loader-assembler` attribute), rewrites each page before it is merged: it writes the
// referenced resource family (the module's `examples/` tree, layout intact) to
// <export_dir>/<component>/<version>/<module>/<family>/ and points the macro at the exported file:
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
// Requires the asciidoctor-kroki gem 2.0+ in the PDF converter (its include preprocessor resolves the
// exported files' relative includes). Not handled: the `kroki-plantuml-include` attribute (the Ruby gem
// prepends it itself).
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_MACROS = ['plantuml', 'c4plantuml']
const DEFAULT_EXPORT_DIR = 'build/assembler/resources'

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// The asciidoctor-kroki module as registered in the playbook, if resolvable: it is dropped from the
// scratch parse of a rewritten page so the (unchanged) diagrams are not fetched a second time.
function resolveKrokiModule (fromDir) {
  try {
    return require(require.resolve('asciidoctor-kroki', { paths: [fromDir, process.cwd(), __dirname] }))
  } catch {
    return undefined
  }
}

// Write every file of one resource family (component/version/module) below exportDir, once per run.
// Returns the directory that holds the family.
function exportFamily (contentCatalog, src, exportDir, exported) {
  const { component, version, module: module_, family } = src
  const key = [component, version, module_, family].join('|')
  const dir = path.join(exportDir, component, version || '_', module_, family)
  if (exported.has(key)) return dir
  for (const file of contentCatalog.findBy({ component, version, module: module_, family })) {
    const target = path.join(dir, file.src.relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, file.contents)
  }
  exported.add(key)
  return dir
}

// Rewrite the (include-expanded) source lines of one page. Returns undefined when nothing changed.
function rewritePage (lines, file, contentCatalog, opts, logger) {
  const { macroRx, exportDir, exported } = opts
  const pagePath = file.src.path || file.path
  const out = []
  let changed = false
  lines.forEach((line, idx) => {
    const m = macroRx.exec(line)
    if (!m) return out.push(line)
    const [, type, target, attrlist] = m
    const resource = contentCatalog.resolveResource(target, file.src, 'example')
    if (!resource) {
      // not a resource id, or not in the catalog: leave it for the converter to report
      if (target.includes('$')) {
        const msg = `${type} block macro target not found in the content catalog: ${target}`
        logger.warn({ file: { path: pagePath }, line: idx + 1 }, msg)
      }
      return out.push(line)
    }
    const familyDir = exportFamily(contentCatalog, resource.src, exportDir, exported)
    out.push(`${type}::${path.join(familyDir, resource.src.relative)}[${attrlist}]`)
    changed = true
  })
  return changed ? out : undefined
}

// NOTE: keep exactly one declared parameter without a default value. Antora decides by `register.length`
// whether to pass `{ config, playbook, ... }` at all; a parameter with a default value does not count.
module.exports.register = function register ({ config = {}, playbook }) {
  const logger = this.getLogger('antora-assembler-kroki')
  const playbookDir = (playbook && playbook.dir) || process.cwd()
  if (config.mode && config.mode !== 'export') {
    logger.warn(`ignoring mode '${config.mode}': this extension only exports (the earlier inline mode was removed)`)
  }
  const macros = Array.isArray(config.macros) && config.macros.length ? config.macros : DEFAULT_MACROS
  const macroRx = new RegExp(`^(${macros.map(escapeRegExp).join('|')})::(\\S+?)\\[(.*)\\]\\s*$`)
  const exportDir = path.resolve(playbookDir, config.export_dir || DEFAULT_EXPORT_DIR)
  const krokiModule = resolveKrokiModule(playbookDir)
  const opts = { macroRx, exportDir, exported: new Set() }
  const loadAsciiDoc = this.require('@antora/asciidoc-loader')
  this.replaceFunctions({
    loadAsciiDoc (file, contentCatalog, asciidocConfig = {}) {
      const doc = loadAsciiDoc(file, contentCatalog, asciidocConfig)
      const attrs = asciidocConfig.attributes || {}
      if (asciidocConfig.headerOnly || !contentCatalog || !('loader-assembler' in attrs)) return doc
      const rewritten = rewritePage(doc.getSourceLines(), file, contentCatalog, opts, logger)
      if (!rewritten) return doc
      // Reload the rewritten page. Includes are already expanded; asciidoctor-kroki is dropped from this
      // scratch parse so the diagrams are not fetched a second time.
      const extensions = (asciidocConfig.extensions || []).filter((ext) => ext !== krokiModule)
      const file2 = new file.constructor(Object.assign({}, file, { contents: Buffer.from(rewritten.join('\n')) }))
      return loadAsciiDoc(file2, contentCatalog, Object.assign({}, asciidocConfig, { extensions }))
    },
  })
}
