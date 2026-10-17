; Top-level resources only. Nested provider blocks are not module declarations.
(config_file
  (body
    (block
      (identifier) @_kind
      (string_lit) @_type
      (string_lit (template_literal) @name)) @definition.variable
    (#eq? @_kind "resource")))
