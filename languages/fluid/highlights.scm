; ── HTML base ─────────────────────────────────────────────────────────────
(tag_name) @tag
(doctype) @tag.doctype
(attribute_name) @attribute
(attribute_value) @string
(comment) @comment
(cdata) @comment
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
  (#match? @function "^[A-Za-z][A-Za-z0-9*]*(\\.[A-Za-z0-9]+)*:[A-Za-z0-9.]+$"))

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
(number) @number
(string) @string
(operator) @operator

(namespace_definition "namespace" @keyword)
(namespace) @namespace
(php_class) @type
(cast "as" @keyword)
(pipe "->" @operator)
(ternary ["?" ":"] @operator)
(pair ":" @punctuation.delimiter)
(argument ":" @punctuation.delimiter)

[
  ","
  "("
  ")"
] @punctuation.bracket
