; ── Base HTML highlighting (from Zed's bundled HTML grammar) ───────────────────
(tag_name) @tag

(doctype) @tag.doctype

(attribute_name) @attribute

[
  "\""
  "'"
  (attribute_value)
] @string

(comment) @comment

(entity) @string.special

"=" @punctuation.delimiter.html

[
  "<"
  ">"
  "<!"
  "</"
  "/>"
] @punctuation.bracket.html

; ── Fluid specialization (later patterns win on overlap) ──────────────────────

; ViewHelper tags carry a namespace prefix: <f:if>, <f:for>, <v:page.menu>,
; <core:icon>, <my.vendor:widget> ... — highlight them as functions, matching
; the source extension's `entity.name.function.fluid` scope.
((tag_name) @function
  (#match? @function "^[A-Za-z][A-Za-z0-9*]*(\\.[A-Za-z0-9]+)*:[A-Za-z0-9.]+$"))

; Fluid namespace declarations on the <html> tag: xmlns:f, xmlns:core, and the
; data-namespace-typo3-fluid marker.
((attribute_name) @keyword
  (#match? @keyword "^(xmlns:[A-Za-z][A-Za-z0-9*]*|data-namespace-typo3-fluid)$"))

; Attribute values that are a single Fluid expression, e.g. each="{items}".
; (Interior of {...} is not separately tokenized — see README; this colors the
; whole expression value as a cue.)
((attribute_value) @variable.special
  (#match? @variable.special "^\\{[^{}]*\\}$"))
