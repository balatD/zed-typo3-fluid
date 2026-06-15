((comment) @injection.content
  (#set! injection.language "comment"))

(script_element
  (raw_text) @injection.content
  (#set! injection.language "javascript"))

(style_element
  (raw_text) @injection.content
  (#set! injection.language "css"))

; Combine the literal fragments of a style value (the pieces around any
; {expressions}) into one CSS document instead of highlighting each separately.
(attribute
  (attribute_name) @_attribute_name
  (#eq? @_attribute_name "style")
  (quoted_attribute_value
    (attribute_value) @injection.content)
  (#set! injection.language "css")
  (#set! injection.combined))
