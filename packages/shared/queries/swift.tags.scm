; Upstream 0.7.3 tags capture the enclosing class as a method definition.
; Capture each declaration itself so chunks retain its exact line range.
(class_declaration name: (type_identifier) @name) @definition.class
(protocol_declaration name: (type_identifier) @name) @definition.interface
(source_file (function_declaration name: (simple_identifier) @name) @definition.function)
(class_body (function_declaration name: (simple_identifier) @name) @definition.method)
(enum_class_body (function_declaration name: (simple_identifier) @name) @definition.method)
(protocol_body (protocol_function_declaration name: (simple_identifier) @name) @definition.method)
(init_declaration "init" @name) @definition.method
(deinit_declaration "deinit" @name) @definition.method
(typealias_declaration name: (type_identifier) @name) @definition.type
