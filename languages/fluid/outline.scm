; Structural ViewHelpers surfaced in the outline / breadcrumbs.

; <f:section name="…"> … </f:section>  (and any *:section)
(element
  (start_tag
    (tag_name) @context
    (attribute
      (attribute_name) @_n
      (quoted_attribute_value (attribute_value) @name))
    (#match? @context ":section$")
    (#eq? @_n "name"))) @item

; <f:layout name="…" />, <f:render section="…"|partial="…" /> (self-closing)
(self_closing_tag
  (tag_name) @context
  (attribute
    (attribute_name) @_n
    (quoted_attribute_value (attribute_value) @name))
  (#match? @context ":(layout|render|section)$")
  (#match? @_n "^(name|section|partial)$")) @item
