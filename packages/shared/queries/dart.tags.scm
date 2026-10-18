; Upstream represents a routine's signature and body as siblings. Capture its
; signature, not their enclosing program/class and unrelated routine bodies.
(function_signature name: (identifier) @name) @definition.function
