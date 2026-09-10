'use strict'

// Antora generator extension: make Kroki PlantUML diagrams referenced by Antora resource id work in
// Antora Assembler exports (PDF, EPUB, HTML single), which are converted by the Ruby
// `asciidoctor-pdf -r asciidoctor-kroki` and not by the Antora-aware JavaScript kroki extension.
//
// The contract this supports: pages reference diagram sources by resource id,
//
//   plantuml::example$order-model.puml[align=center]
//
// while the .puml files themselves use plain relative PlantUML includes (`!include layout/colors.puml`),
// so they stay standalone-valid for the PlantUML plugin / CLI. The HTML site handles this already
// (asciidoctor-kroki 0.18.x resolves the macro target through the content catalog and joins relative
// includes against it). The Assembler, however, pipes the merged AsciiDoc to a Ruby process that
// knows nothing about resource ids: the macro target `example$order-model.puml` is not a path.
//
// This extension wraps Antora's `loadAsciiDoc` generator function and, only when the Assembler is the
// caller (intrinsic `loader-assembler` attribute), rewrites each page before it is merged. Two modes:
//
//   export (default)  Write the referenced resource family (the module's `examples/` tree, layout
//                     intact) to <export_dir>/<component>/<version>/<module>/<family>/ and point the
//                     macro at the exported file:
//                        plantuml::/abs/build/assembler/resources/demo/1.0/ROOT/example/order-model.puml[align=center]
//                     asciidoctor-kroki >= 2.0 (Ruby) then resolves the relative `!include`s from that
//                     file's directory itself. Nothing Antora-specific reaches Ruby. This mirrors what
//                     the Assembler already does for `image$` targets and is the behavior proposed for
//                     the Assembler itself; once it has it, this extension retires.
//
//   inline            For converters with asciidoctor-kroki < 2.0 (no include preprocessor): resolve
//                     and inline every include here, turning the macro into a `[plantuml]` literal block
//                     holding the self-contained diagram, and inline `!include example$…` lines found in
//                     `[plantuml]` blocks. Reuses asciidoctor-kroki 0.18.x's own preprocess.js and
//                     antora-adapter.js, so the result matches the HTML site exactly.
//
// Playbook:
//   antora:
//     extensions:
//       - '@antora/pdf-extension'
//       - require: ./extensions/antora-assembler-kroki.js
//         mode: export                      # or inline
//         export_dir: build/assembler/resources   # relative to the playbook dir (default)
//         macros: [plantuml, c4plantuml]    # block macro names to handle (default)
//
// The regular HTML build is untouched. Not handled: the `kroki-plantuml-include` attribute (the Ruby gem
// prepends it itself). Requires asciidoctor-kroki 0.x (the Antora-compatible line) to be resolvable from
// the playbook dir or NODE_PATH.
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_MACROS = ['plantuml', 'c4plantuml']
const DEFAULT_EXPORT_DIR = 'build/assembler/resources'
const BLOCK_ATTRLIST_RX = /^\[.*\]$/
const BLOCK_TITLE_RX = /^\.[^\s.].*$/
const DELIMITER_RX = /^(-{4,}|\.{4,})$/
// An `!include` directive (any variant) whose target carries an Antora family marker.
const ANTORA_INCLUDE_RX = /^\s*!include(?:_many|_once|url|sub)?\s+\S*\$/i

function escapeRegExp (s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function locateKroki (fromDir) {
  let main
  try {
    main = require.resolve('asciidoctor-kroki', { paths: [fromDir, process.cwd(), __dirname] })
  } catch {
    return undefined
  }
  // The package's `exports` field blocks deep imports; load the modules by resolved path instead.
  const srcDir = path.dirname(main)
  try {
    return {
      preprocess: require(path.join(srcDir, 'preprocess.js')),
      antoraAdapter: require(path.join(srcDir, 'antora-adapter.js')),
      module: require(main),
    }
  } catch {
    return undefined
  }
}

// --- export mode -------------------------------------------------------------------------------------

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

function rewriteExport (lines, file, contentCatalog, opts, logger) {
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
        logger.warn({ file: { path: pagePath }, line: idx + 1 }, `${type} block macro target not found in the content catalog: ${target}`)
      }
      return out.push(line)
    }
    const familyDir = exportFamily(contentCatalog, resource.src, exportDir, exported)
    out.push(`${type}::${path.join(familyDir, resource.src.relative)}[${attrlist}]`)
    changed = true
  })
  return changed ? out : undefined
}

// --- inline mode -------------------------------------------------------------------------------------

function literalDelimiter (bodyLines) {
  let delimiter = '....'
  while (bodyLines.includes(delimiter)) delimiter += '.'
  return delimiter
}

function endOfBlock (lines, styleIdx) {
  let idx = styleIdx + 1
  while (idx < lines.length && (BLOCK_ATTRLIST_RX.test(lines[idx]) || BLOCK_TITLE_RX.test(lines[idx]))) idx++
  if (idx >= lines.length || !DELIMITER_RX.test(lines[idx])) return undefined
  const delimiter = lines[idx]
  const bodyStart = idx + 1
  for (let end = bodyStart; end < lines.length; end++) {
    if (lines[end] === delimiter) return { bodyStart, bodyEnd: end }
  }
  return undefined
}

function rewriteInline (lines, file, contentCatalog, doc, opts, logger) {
  const { kroki, macroRx, blockRx } = opts
  const vfs = kroki.antoraAdapter(file, contentCatalog, undefined)
  const context = { vfs, logger }
  const includePaths = doc.getAttribute('kroki-plantuml-include-paths')
  const pagePath = file.src.path || file.path
  const out = []
  let changed = false
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    let match
    if ((match = macroRx.exec(line))) {
      const [, type, target, attrlist] = match
      const resource = vfs.parse(target)
      if (!(resource && resource.module)) {
        out.push(line)
        continue
      }
      try {
        const text = kroki.preprocess.preprocessPlantUML(vfs.read(target), context, includePaths, resource)
        const body = text.split('\n')
        const delimiter = literalDelimiter(body)
        // macro positional attrs are [format]; block positional attrs are [target, format]
        const attrs = attrlist.trim() === '' ? '' : ',' + (/^[\w-]+=/.test(attrlist.trim()) ? attrlist : ',' + attrlist)
        out.push(`[${type}${attrs}]`, delimiter, ...body, delimiter)
        changed = true
      } catch (err) {
        logger.warn({ file: { path: pagePath }, line: idx + 1 }, `${type} block macro not inlined for export: ${err.message}`)
        out.push(line)
      }
      continue
    }
    if ((match = blockRx.exec(line))) {
      const block = endOfBlock(lines, idx)
      if (block) {
        const body = lines.slice(block.bodyStart, block.bodyEnd)
        if (body.some((it) => ANTORA_INCLUDE_RX.test(it))) {
          const head = lines.slice(idx, block.bodyStart)
          try {
            const text = kroki.preprocess.preprocessPlantUML(body.join('\n'), context, includePaths, file.src)
            const newBody = text.split('\n')
            const opening = head[head.length - 1]
            const delimiter = newBody.includes(opening) ? literalDelimiter(newBody) : opening
            out.push(...head.slice(0, -1), delimiter, ...newBody, delimiter)
            changed = true
          } catch (err) {
            logger.warn({ file: { path: pagePath }, line: idx + 1 }, `${match[1]} block not inlined for export: ${err.message}`)
            out.push(...lines.slice(idx, block.bodyEnd + 1))
          }
          idx = block.bodyEnd
          continue
        }
      }
    }
    out.push(line)
  }
  return changed ? out : undefined
}

// --- registration ------------------------------------------------------------------------------------

module.exports.register = function register ({ config = {}, playbook } = {}) {
  const logger = this.getLogger('antora-assembler-kroki')
  const playbookDir = (playbook && playbook.dir) || process.cwd()
  const mode = config.mode || 'export'
  const macros = Array.isArray(config.macros) && config.macros.length ? config.macros : DEFAULT_MACROS
  const macroRx = new RegExp(`^(${macros.map(escapeRegExp).join('|')})::(\\S+?)\\[(.*)\\]\\s*$`)
  const blockRx = new RegExp(`^\\[(${macros.map(escapeRegExp).join('|')})(?=[,\\]#.%])`)
  const exportDir = path.resolve(playbookDir, config.export_dir || DEFAULT_EXPORT_DIR)
  const kroki = locateKroki(playbookDir)
  if (!kroki) {
    logger.warn('asciidoctor-kroki not found; resource ids in Kroki diagrams will not be handled for exports')
    return
  }
  if (!['export', 'inline'].includes(mode)) {
    logger.warn(`unknown mode '${mode}' (expected export or inline); extension disabled`)
    return
  }
  const opts = { kroki, macroRx, blockRx, exportDir, exported: new Set() }
  const loadAsciiDoc = this.require('@antora/asciidoc-loader')
  this.replaceFunctions({
    loadAsciiDoc (file, contentCatalog, asciidocConfig = {}) {
      const doc = loadAsciiDoc(file, contentCatalog, asciidocConfig)
      const attrs = asciidocConfig.attributes || {}
      if (asciidocConfig.headerOnly || !contentCatalog || !('loader-assembler' in attrs)) return doc
      const lines = doc.getSourceLines()
      const rewritten = mode === 'export'
        ? rewriteExport(lines, file, contentCatalog, opts, logger)
        : rewriteInline(lines, file, contentCatalog, doc, opts, logger)
      if (!rewritten) return doc
      // Reload the rewritten page. Includes are already expanded; asciidoctor-kroki is dropped from this
      // scratch parse so the diagrams are not fetched a second time.
      const extensions = (asciidocConfig.extensions || []).filter((ext) => ext !== kroki.module)
      const file2 = new file.constructor(Object.assign({}, file, { contents: Buffer.from(rewritten.join('\n')) }))
      return loadAsciiDoc(file2, contentCatalog, Object.assign({}, asciidocConfig, { extensions }))
    },
  })
}
