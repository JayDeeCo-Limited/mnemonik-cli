; Hand-written: tree-sitter-bash ships no queries/tags.scm.
;
; Node names verified by parsing a sample with the vendored bash.wasm rather than
; taken from documentation - `function_definition` carries its name in a `name`
; field typed `word`, covering both `foo() { }` and `function foo { }`.
(function_definition
  name: (word) @name) @definition.function
