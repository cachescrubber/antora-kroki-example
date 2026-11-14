# Reproducible build of this demo: Antora + asciidoctor-kroki (JS) for the HTML site, Ruby
# asciidoctor-pdf + the asciidoctor-kroki gem for the PDF export (Antora Assembler).
#
#   npm run build:docker      # = docker build -t antora-kroki-example . && docker run ... antora-playbook.yml
#
# The kroki gem is pinned to 2.0: it is the first release with a PlantUML include preprocessor,
# which the PDF export relies on to resolve the relative !include directives in the exported .puml
# files (see README, "PDF export"). The JS extension stays on 0.18.x, the Antora-compatible line.
FROM antora/antora:3.2.2

RUN yarn global add asciidoctor-kroki@0.18.2 @antora/pdf-extension@1.0.1

RUN apk add --no-cache ruby ruby-bigdecimal \
 && gem install --no-document asciidoctor-pdf:2.3.27 asciidoctor-kroki:2.0.0 rouge:5.1.0 logger:1.7.0
