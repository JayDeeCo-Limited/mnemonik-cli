; Hand-written: tree-sitter-groovy ships no queries/tags.scm.
;
; Node names verified against the vendored groovy.wasm. Groovy distinguishes a
; top-level `function_definition` from a `method_declaration` inside a
; `class_body`, and both name via an `identifier` field - so methods get
; definition.method and keep their own name, which is the defect this plan
; exists to fix for every language.
(class_declaration
  name: (identifier) @name) @definition.class

(method_declaration
  name: (identifier) @name) @definition.method

(function_definition
  name: (identifier) @name) @definition.function
