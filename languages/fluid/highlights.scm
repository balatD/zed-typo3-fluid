; ── HTML base ─────────────────────────────────────────────────────────────
(tag_name) @tag
(doctype) @tag.doctype
(attribute_name) @attribute
(attribute_value) @string
(comment) @comment
(cdata) @string
(entity) @string.special

"=" @punctuation.delimiter.html

[
  "<"
  ">"
  "<!"
  "</"
  "/>"
] @punctuation.bracket.html

; ── Fluid ViewHelper tags (later patterns win on overlap) ──────────────────
; <f:if>, <f:format.raw>, <v:page.menu>, <core:icon>, <my.vendor:widget>
((tag_name) @function
  (#match? @function "^[A-Za-z_][A-Za-z0-9_*]*(\\.[A-Za-z0-9_]+)*:[A-Za-z0-9_.]+$"))

; Fluid namespace declarations: xmlns:f, data-namespace-typo3-fluid
((attribute_name) @keyword
  (#match? @keyword "^(xmlns:[A-Za-z]|data-namespace-typo3-fluid)"))

; ── Fluid expressions ─────────────────────────────────────────────────────
(expression ["{" "}"] @punctuation.special)

(variable (identifier) @variable)
(variable "." @punctuation.delimiter)

(viewhelper_name) @function
(argument_name) @property
(array_key) @property
(type) @type
(boolean) @constant.builtin
(null) @constant.builtin
(special_variable) @variable.builtin
(number) @number
(string) @string
(operator) @operator

(namespace_definition "namespace" @keyword)
(namespace) @variable
(php_class) @type
(cast "as" @keyword)
(pipe "->" @operator)
(ternary ["?" ":" "?:"] @operator)
(pair ":" @punctuation.delimiter)
(argument ":" @punctuation.delimiter)

[
  ","
  "("
  ")"
] @punctuation.bracket

; Dim the plain-text body of <f:comment> (its content is never rendered).
; Nested {expressions}/elements keep their own scopes — full opacity needs a
; grammar-level change (see README, Known limitations).
((element (start_tag (tag_name) @_n) (text) @comment)
  (#eq? @_n "f:comment"))
