; Literal source target declarations, never command invocations as runtime functions.
((normal_command
  (identifier) @_command
  (argument_list . (argument (unquoted_argument) @name))) @definition.variable
 (#match? @_command "^[aA][dD][dD]_[lL][iI][bB][rR][aA][rR][yY]$")
 (#match? @name "^[A-Za-z_][A-Za-z0-9_.+-]*$"))
