'use strict'

// Antora generator extension: make Kroki PlantUML diagrams that reference Antora resource ids work in
// Antora Assembler exports (PDF, EPUB, HTML single) built with the Ruby asciidoctor-kroki gem.
//
// Problem. In the HTML site the asciidoctor-kroki JavaScript extension resolves Antora resource ids
// (`plantuml::example$model.puml[]`, `!include example$layout/colors.puml`) through the content
// catalog. Antora Assembler, however, expands `include::` directives and rewrites xrefs/images only,
// then pipes the merged AsciiDoc to an external converter (asciidoctor-pdf -r asciidoctor-kroki). That
// Ruby gem has no notion of Antora resource ids, so such diagrams fail or reach the Kroki server with
// unresolved `!include` lines.
//
// Fix. The Assembler loads every page through the generator's `loadAsciiDoc` function. This extension
// wraps that function and, only when the Assembler is the caller (intrinsic `loader-assembler`
// attribute), rewrites the page source before it is merged:
//
//   plantuml::example$model.puml[align=center]   ->   [plantuml,align=center]
//                                                     ....
//                                                     <model.puml with all includes inlined>
//                                                     ....
//
//   [plantuml]                                   ->   body with `!include example$…` inlined
//   ----
//   !include example$layout/colors.puml
//   ...
//
// Resolution and inlining reuse asciidoctor-kroki's own preprocessor (src/preprocess.js) and its Antora
// adapter (src/antora-adapter.js), so `!include`, `!includesub`, `!include_once`, `!startsub`/`!endsub`,
// `<stdlib>` pass-through and cycle detection behave exactly as in the HTML build. The Ruby side then
// receives self-contained diagrams. The regular HTML build is not touched.
//
// Enable it via the playbook's `antora.extensions` key (or `--extension`), next to @antora/pdf-extension,
// by file path or npm subpath (in the vc-antora image: /opt/extensions/antora-assembler-kroki.js):
//   antora:
//     extensions:
//       - '@antora/pdf-extension'
//       - ./extensions/antora-assembler-kroki.js
//
// Requires asciidoctor-kroki 0.x (the Antora-compatible line) to be resolvable from the playbook dir or
// NODE_PATH. Not handled: the `kroki-plantuml-include` attribute (the Ruby gem
// prepends it itself).
const path = require('node:path')

const DIAGRAM_TYPES = ['plantuml', 'c4plantuml']
const BLOCK_MACRO_RX = /^(plantuml|c4plantuml)::(\S+?)\[(.*)\]\s*$/
const BLOCK_STYLE_RX = /^\[(plantuml|c4plantuml)(?=[,\]#.%])/
const BLOCK_ATTRLIST_RX = /^\[.*\]$/
const BLOCK_TITLE_RX = /^\.[^\s.].*$/
const DELIMITER_RX = /^(-{4,}|\.{4,})$/
// An `!include` directive (any variant) whose target carries an Antora family marker, e.g.
// `!include example$layout/colors.puml` or `!includesub module:example$roles.puml!Core`.
const ANTORA_INCLUDE_RX = /^\s*!include(?:_many|_once|url|sub)?\s+\S*\$/i

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

// Split a block-macro attribute list on top-level commas, honoring double and single quotes.
function splitAttrlist (attrlist) {
  const parts = []
  let current = ''
  let quote = null
  for (const ch of attrlist) {
    if (quote) {
      if (ch === quote) quote = null
      current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === ',') {
      parts.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim() !== '' || parts.length) parts.push(current.trim())
  return parts
}

// Block-macro positional attributes are [format]; block positional attributes are [target, format].
// Shift a positional format into the second slot so `plantuml::x.puml[svg]` becomes `[plantuml,,svg]`.
function macroAttrsToBlockAttrs (attrlist) {
  const parts = splitAttrlist(attrlist)
  const positional = parts.filter((it) => it !== '' && !/^[\w-]+=/.test(it))
  const named = parts.filter((it) => it !== '' && /^[\w-]+=/.test(it))
  const out = []
  if (positional.length) out.push('', positional[0])
  return out.concat(named)
}

// A literal-block delimiter that does not occur as a line in the body.
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

// Rewrite the (include-expanded) source lines of one page. Returns undefined when nothing changed.
function rewritePage (lines, file, contentCatalog, doc, kroki, logger) {
  const vfs = kroki.antoraAdapter(file, contentCatalog, undefined)
  const context = { vfs, logger }
  const includePaths = doc.getAttribute('kroki-plantuml-include-paths')
  const pagePath = file.src.path || file.path
  const out = []
  let changed = false
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]
    let match
    if ((match = BLOCK_MACRO_RX.exec(line))) {
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
        out.push(`[${[type].concat(macroAttrsToBlockAttrs(attrlist)).join(',')}]`, delimiter, ...body, delimiter)
        changed = true
      } catch (err) {
        const msg = `${type} block macro not inlined for export: ${err.message}`
        logger.warn({ file: { path: pagePath }, line: idx + 1 }, msg)
        out.push(line)
      }
      continue
    }
    if ((match = BLOCK_STYLE_RX.exec(line)) && DIAGRAM_TYPES.includes(match[1])) {
      const block = endOfBlock(lines, idx)
      if (block) {
        const body = lines.slice(block.bodyStart, block.bodyEnd)
        if (body.some((it) => ANTORA_INCLUDE_RX.test(it))) {
          const head = lines.slice(idx, block.bodyStart)
          try {
            // Pass the page as the resource so ids resolve against its module, like a block-macro target.
            const text = kroki.preprocess.preprocessPlantUML(body.join('\n'), context, includePaths, file.src)
            const newBody = text.split('\n')
            const delimiter = literalDelimiter(newBody)
            const hasDelimiterCollision = newBody.includes(head[head.length - 1])
            out.push(...head.slice(0, -1), hasDelimiterCollision ? delimiter : head[head.length - 1])
            out.push(...newBody, hasDelimiterCollision ? delimiter : lines[block.bodyEnd])
            changed = true
          } catch (err) {
            const msg = `${match[1]} block not inlined for export: ${err.message}`
            logger.warn({ file: { path: pagePath }, line: idx + 1 }, msg)
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

module.exports.register = function register ({ playbook } = {}) {
  const logger = this.getLogger('antora-assembler-kroki')
  const kroki = locateKroki((playbook && playbook.dir) || process.cwd())
  if (!kroki) {
    logger.warn('asciidoctor-kroki not found; Antora resource ids in Kroki diagrams will not be inlined for exports')
    return
  }
  const loadAsciiDoc = this.require('@antora/asciidoc-loader')
  this.replaceFunctions({
    loadAsciiDoc (file, contentCatalog, config = {}) {
      const doc = loadAsciiDoc(file, contentCatalog, config)
      const attrs = config.attributes || {}
      if (config.headerOnly || !contentCatalog || !('loader-assembler' in attrs)) return doc
      const lines = doc.getSourceLines()
      const rewritten = rewritePage(lines, file, contentCatalog, doc, kroki, logger)
      if (!rewritten) return doc
      // Reload the rewritten page. Includes are already expanded, and asciidoctor-kroki is dropped so the
      // (now self-contained) diagrams are not fetched a second time during this scratch parse.
      const extensions = (config.extensions || []).filter((ext) => ext !== kroki.module)
      const file2 = new file.constructor(Object.assign({}, file, { contents: Buffer.from(rewritten.join('\n')) }))
      return loadAsciiDoc(file2, contentCatalog, Object.assign({}, config, { extensions }))
    },
  })
}

// exported for tests
module.exports.rewritePage = rewritePage
module.exports.macroAttrsToBlockAttrs = macroAttrsToBlockAttrs
