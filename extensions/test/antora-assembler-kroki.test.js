'use strict'

// Runs with the built-in test runner: `node --test extensions/test` (npm test). No extra dependencies:
// @asciidoctor/core and asciidoctor-kroki come with the Antora install in node_modules.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const asciidoctor = require('@asciidoctor/core')()

const extension = require(path.join(__dirname, '..', 'antora-assembler-kroki.js'))

class File {
  constructor (props) {
    Object.assign(this, props)
  }
}

const COMPONENT = { component: 'demo', version: '1.0', module: 'ROOT' }

const EXAMPLES = {
  'layout/colors.puml': '@startuml\nskinparam shadowing false\nskinparam class {\n  BackgroundColor #F7FBFF\n}\n@enduml\n',
  'order-model.puml': '@startuml\n!include layout/colors.puml\nclass Order\n@enduml\n',
  'roles.puml': '@startuml\n!startsub Core\n!include layout/colors.puml\nabstract class Party\n!endsub\n@enduml\n',
  'roles-simple.puml': '@startuml\n!includesub roles.puml!Core\n@enduml\n',
}

// Minimal content catalog: resolveResource + findBy over one example family, like Antora's.
function createContentCatalog (examples = EXAMPLES) {
  const files = Object.entries(examples).map(([relative, contents]) => ({
    contents: Buffer.from(contents),
    src: Object.assign({}, COMPONENT, { family: 'example', relative, path: `modules/ROOT/examples/${relative}` }),
  }))
  return {
    resolveResource (spec, ctx = {}, defaultFamily) {
      const m = /^(?:([^:$]+):)?(?:([a-z]+)\$)?(.+)$/.exec(spec)
      if (!m) return false
      const family = m[2] || defaultFamily || 'page'
      return files.find((f) => f.src.family === family && f.src.relative === m[3])
    },
    findBy ({ family }) {
      return files.filter((f) => f.src.family === family)
    },
    getById () {
      return undefined
    },
    addFile () {},
  }
}

function createPage (contents) {
  return new File({
    contents: Buffer.from(contents),
    path: 'modules/ROOT/pages/index.adoc',
    src: Object.assign({}, COMPONENT, { family: 'page', relative: 'index.adoc', path: 'modules/ROOT/pages/index.adoc' }),
  })
}

function fakeLoadAsciiDoc (file, contentCatalog, config = {}) {
  return asciidoctor.load(file.contents.toString(), { sourcemap: true, safe: 'safe', attributes: Object.assign({}, config.attributes) })
}

function createContext () {
  const warnings = []
  const state = {}
  const ctx = {
    getLogger: () => ({ info () {}, warn: (...args) => warnings.push(args) }),
    require (name) {
      if (name === '@antora/asciidoc-loader') return fakeLoadAsciiDoc
      throw new Error(`unexpected require: ${name}`)
    },
    replaceFunctions (fns) {
      state.replaced = fns
    },
  }
  return { ctx, state, warnings }
}

const ASSEMBLER = { attributes: { 'loader-assembler': '' } }

function loadWith (page, { config = {}, asciidocConfig = ASSEMBLER, catalog = createContentCatalog() } = {}) {
  const { ctx, state, warnings } = createContext()
  extension.register.call(ctx, { config, playbook: { dir: config.playbookDir || process.cwd() } })
  const doc = state.replaced.loadAsciiDoc(createPage(page), catalog, asciidocConfig)
  return { lines: doc.getSourceLines(), warnings }
}

function tmpDir () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'antora-assembler-kroki-'))
}

test('registers a loadAsciiDoc replacement', () => {
  const { ctx, state } = createContext()
  extension.register.call(ctx, { config: {}, playbook: { dir: process.cwd() } })
  assert.equal(typeof state.replaced.loadAsciiDoc, 'function')
})

test('leaves the regular (non-Assembler) load untouched', () => {
  const { lines } = loadWith('= Page\n\nplantuml::example$order-model.puml[]\n', { asciidocConfig: { attributes: {} } })
  assert.ok(lines.includes('plantuml::example$order-model.puml[]'))
})

test('export mode: rewrites the macro target to the exported file and writes the family to disk', () => {
  const dir = tmpDir()
  const { lines, warnings } = loadWith('= Page\n\nplantuml::example$order-model.puml[align=center]\n', {
    config: { mode: 'export', export_dir: dir, playbookDir: '/' },
  })
  assert.deepEqual(warnings, [])
  const expected = path.join(dir, 'demo', '1.0', 'ROOT', 'example', 'order-model.puml')
  assert.ok(lines.includes(`plantuml::${expected}[align=center]`), lines.join('\n'))
  // the whole family is exported with its layout, so relative includes resolve on disk
  assert.equal(fs.readFileSync(expected, 'utf8'), EXAMPLES['order-model.puml'])
  assert.equal(fs.readFileSync(path.join(dir, 'demo', '1.0', 'ROOT', 'example', 'layout', 'colors.puml'), 'utf8'), EXAMPLES['layout/colors.puml'])
  assert.ok(fs.existsSync(path.join(dir, 'demo', '1.0', 'ROOT', 'example', 'roles.puml')))
  // the macro form is kept: nothing inlined, attrs untouched
  assert.ok(!lines.join('\n').includes('!include'))
})

test('export mode: export_dir defaults to build/assembler/resources under the playbook dir', () => {
  const playbookDir = tmpDir()
  const { lines } = loadWith('= Page\n\nplantuml::example$order-model.puml[]\n', {
    config: { mode: 'export', playbookDir },
  })
  const expected = path.join(playbookDir, 'build', 'assembler', 'resources', 'demo', '1.0', 'ROOT', 'example', 'order-model.puml')
  assert.ok(lines.includes(`plantuml::${expected}[]`), lines.join('\n'))
})

test('export mode: leaves non-resource targets alone and warns on an unknown example$ id', () => {
  const dir = tmpDir()
  const page = '= Page\n\nplantuml::diagrams/local.puml[]\n\nplantuml::example$missing.puml[]\n\n[plantuml]\n----\nclass Plain\n----\n'
  const { lines, warnings } = loadWith(page, { config: { mode: 'export', export_dir: dir, playbookDir: '/' } })
  assert.ok(lines.includes('plantuml::diagrams/local.puml[]'))
  assert.ok(lines.includes('plantuml::example$missing.puml[]'))
  assert.ok(lines.includes('class Plain'))
  assert.equal(warnings.length, 1)
  assert.match(warnings[0][1], /example\$missing\.puml/)
})

test('inline mode: turns the macro into a self-contained literal block with relative includes inlined', () => {
  const { lines, warnings } = loadWith('= Page\n\nplantuml::example$roles-simple.puml[align=center]\n', {
    config: { mode: 'inline', playbookDir: process.cwd() },
  })
  assert.deepEqual(warnings, [])
  const source = lines.join('\n')
  assert.ok(lines.includes('[plantuml,align=center]'), source)
  assert.ok(lines.includes('abstract class Party'), source)
  assert.ok(lines.includes('  BackgroundColor #F7FBFF'), source)
  assert.ok(!source.includes('!include'), source)
  assert.ok(!source.includes('@startuml'), source)
})

test('inline mode: moves a positional format behind the empty target slot', () => {
  const { lines } = loadWith('= Page\n\nplantuml::example$order-model.puml[svg]\n', {
    config: { mode: 'inline', playbookDir: process.cwd() },
  })
  assert.ok(lines.includes('[plantuml,,svg]'), lines.join('\n'))
})

test('inline mode: inlines example$ includes inside a [plantuml] block, resolving against the page module', () => {
  const page = '= Page\n\n[plantuml]\n----\n@startuml\n!include example$layout/colors.puml\nclass InlineBlock\n@enduml\n----\n'
  const { lines, warnings } = loadWith(page, { config: { mode: 'inline', playbookDir: process.cwd() } })
  assert.deepEqual(warnings, [])
  assert.ok(lines.includes('  BackgroundColor #F7FBFF'), lines.join('\n'))
  assert.ok(lines.includes('class InlineBlock'))
  assert.ok(!lines.join('\n').includes('example$'))
})

test('unknown mode disables the extension with a warning', () => {
  const { ctx, state, warnings } = createContext()
  extension.register.call(ctx, { config: { mode: 'bogus' }, playbook: { dir: process.cwd() } })
  assert.equal(state.replaced, undefined)
  assert.equal(warnings.length, 1)
})
