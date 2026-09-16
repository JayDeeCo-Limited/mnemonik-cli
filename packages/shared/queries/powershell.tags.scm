; Hand-written: tree-sitter-powershell ships no queries/tags.scm.
;
; Node names verified against the vendored powershell.wasm. PowerShell names
; differ from every other grammar here: a function's name node is
; `function_name` (not `identifier`), a class's is `simple_name`, and methods are
; `class_method_definition`. Guessing these from another language's convention
; would have produced a query that compiles and matches nothing.
(function_statement
  (function_name) @name) @definition.function

(class_statement
  (simple_name) @name) @definition.class

(class_method_definition) @definition.method
