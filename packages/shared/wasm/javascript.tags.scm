(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name) @definition.method
  (#not-eq? @name "constructor")
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name)
    (class_declaration
      name: (_) @name)
  ] @definition.class
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_expression
      name: (identifier) @name)
    (function_declaration
      name: (identifier) @name)
    (generator_function
      name: (identifier) @name)
    (generator_function_declaration
      name: (identifier) @name)
  ] @definition.function
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  (variable_declaration
    (variable_declarator
      name: (identifier) @name
      value: [(arrow_function) (function_expression)]) @definition.function)
  (#strip! @doc "^[\\s\\*/]+|^[\\s\\*/]$")
  (#select-adjacent! @doc @definition.function)
)

; Module-scope value bindings, so `code_search({symbol:'FOO'})` finds an exported
; `const`. Function-valued `const foo = () => {}` already matched above as
; definition.function on the same variable_declarator; collectDefinitions keeps
; the more specific kind when both fire.
;
; ANCHORED TO `program` ON PURPOSE, and the anchor is load-bearing. The chunker's
; leaf rule only suppresses a definition nested inside ANOTHER DEFINITION; a bare
; block, an `if` body and a `for` initialiser are not definitions, so an
; unanchored variable_declarator pattern writes locals - the `i` of every
; for-loop, every `const` in every block - straight into
; `memory_file_index.symbol_name`, where the `symbol:` leg prefix-matches them.
; Measured on this repo, unanchored inflates the chunk count 28.9% and makes
; `symbol: i` return loop bodies. python.tags.scm anchors its constant pattern to
; `(module ...)` for the same reason.
;
; `export` wraps the declaration in an export_statement, which is why the
; exported form needs its own pattern rather than being reachable from the first.
(program
  (lexical_declaration
    (variable_declarator
      name: (identifier) @name) @definition.constant))

(program
  (export_statement
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name) @definition.constant)))

(program
  (variable_declaration
    (variable_declarator
      name: (identifier) @name) @definition.constant))

(program
  (export_statement
    (variable_declaration
      (variable_declarator
        name: (identifier) @name) @definition.constant)))

(assignment_expression
  left: [
    (identifier) @name
    (member_expression
      property: (property_identifier) @name)
  ]
  right: [(arrow_function) (function_expression)]
) @definition.function

(pair
  key: (property_identifier) @name
  value: [(arrow_function) (function_expression)]) @definition.function

(
  (call_expression
    function: (identifier) @name) @reference.call
  (#not-match? @name "^(require)$")
)

(call_expression
  function: (member_expression
    property: (property_identifier) @name)
  arguments: (_) @reference.call)

(new_expression
  constructor: (_) @name) @reference.class

(export_statement value: (assignment_expression left: (identifier) @name right: ([
 (number)
 (string)
 (identifier)
 (undefined)
 (null)
 (new_expression)
 (binary_expression)
 (call_expression)
]))) @definition.constant
