# Antora `example$` Kroki demo

A small, self-contained Antora project that demonstrates resolving **Antora resource ids
(`example$…`)** in the Kroki PlantUML extension — both as a `plantuml::` block-macro target and
inside PlantUML `!include` / `!includesub` directives.

It accompanies the IntelliJ AsciiDoc plugin change for
[asciidoctor-intellij-plugin#516](https://github.com/asciidoctor/asciidoctor-intellij-plugin/issues/516)
(refs #489). The Kroki server has no filesystem access, so every `example$…` include must be
**resolved and inlined** before the diagram is sent — that is exactly what the plugin now does in
the IDE preview, mirroring the official `asciidoctor-kroki` JavaScript extension.

## What it covers

`docs/modules/ROOT/pages/index.adoc` exercises, in order:

1. **Block macro + shared-layout include** — `plantuml::example$order-model.puml[]`, whose `.puml`
   does `!include example$layout/colors.puml` and `!include example$layout/legend.puml`.
2. **Reusing the shared layout** in a second diagram (`order-lifecycle.puml`).
3. **`[plantuml]` delimited block** form with `!include example$layout/colors.puml`.
4. **`!includesub`** with a named sub-block — `!includesub example$roles.puml!Core` (the section
   itself includes the shared layout, so nested includes are inlined recursively).
5. **Pass-through** — `!include <C4/C4_Context>` is *not* an Antora id, so it is left untouched and
   resolved by the Kroki server. Remote `http(s)` includes are passed through the same way.

## Two ways to use it

### A. Live preview in IntelliJ (the feature)

1. Install the patched plugin build (`asciidoctor-intellij-plugin`, branch
   `feature/kroki-antora-resource-ids`).
2. Open this folder in IntelliJ and open `docs/modules/ROOT/pages/index.adoc`.
3. In **Settings ▸ Languages & Frameworks ▸ AsciiDoc**, enable the **Kroki** diagram renderer and set
   a server URL — either the public `https://kroki.io` or a local Kroki, e.g. `http://localhost:8000`.
4. The preview renders all five diagrams; the shared `colors`/`legend` layout proves the `example$`
   includes were inlined.

### B. Build the reference site (Node / Antora)

```sh
npm install
npm run build
```

Open `build/site/index.html`. This builds with the official `asciidoctor-kroki` JS extension, so it
is the reference rendering the IDE preview should match.

> The build reads from `branches: HEAD`, so it needs at least one git commit. If you unzipped this
> rather than cloning it, run `git init && git add -A && git commit -m init` first.
> Diagram rendering needs network access to `https://kroki.io` (or change `kroki-server-url` in
> `antora-playbook.yml` to a local Kroki server).

## Layout

```
docs/
└── modules/ROOT/
    ├── pages/index.adoc        the demo page
    └── examples/
        ├── layout/colors.puml  shared skin, included via example$layout/colors.puml
        ├── layout/legend.puml  shared legend
        ├── order-model.puml    class model + shared-layout includes
        ├── order-lifecycle.puml
        ├── roles.puml          !startsub Core/Roles library
        ├── roles-simple.puml   !includesub example$roles.puml!Core
        └── context.puml        !include <C4/C4_Context> pass-through
```
