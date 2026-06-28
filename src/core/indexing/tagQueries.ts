/**
 * Tree-sitter tag queries for symbol extraction (Aider-style tags.scm).
 * Each query captures @name (symbol name) and @def (definition node).
 */
export const TAG_QUERIES: Record<string, string> = {
  typescript: `
    (class_declaration name: (type_identifier) @name) @def
    (interface_declaration name: (type_identifier) @name) @def
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (type_alias_declaration name: (type_identifier) @name) @def
    (enum_declaration name: (identifier) @name) @def
    (lexical_declaration (variable_declarator name: (identifier) @name)) @def
  `,
  tsx: `
    (class_declaration name: (type_identifier) @name) @def
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (lexical_declaration (variable_declarator name: (identifier) @name)) @def
  `,
  javascript: `
    (class_declaration name: (identifier) @name) @def
    (function_declaration name: (identifier) @name) @def
    (method_definition name: (property_identifier) @name) @def
    (lexical_declaration (variable_declarator name: (identifier) @name)) @def
  `,
  python: `
    (class_definition name: (identifier) @name) @def
    (function_definition name: (identifier) @name) @def
  `,
  go: `
    (function_declaration name: (identifier) @name) @def
    (method_declaration name: (field_identifier) @name) @def
    (type_declaration (type_spec name: (type_identifier) @name)) @def
  `,
  java: `
    (class_declaration name: (identifier) @name) @def
    (interface_declaration name: (identifier) @name) @def
    (method_declaration name: (identifier) @name) @def
    (enum_declaration name: (identifier) @name) @def
  `,
  rust: `
    (function_item name: (identifier) @name) @def
    (struct_item name: (type_identifier) @name) @def
    (enum_item name: (type_identifier) @name) @def
    (trait_item name: (type_identifier) @name) @def
    (impl_item type: (type_identifier) @name) @def
  `,
  ruby: `
    (class name: (constant) @name) @def
    (module name: (constant) @name) @def
    (method name: (identifier) @name) @def
    (singleton_method name: (identifier) @name) @def
  `,
  php: `
    (class_declaration name: (name) @name) @def
    (interface_declaration name: (name) @name) @def
    (function_definition name: (name) @name) @def
    (method_declaration name: (name) @name) @def
  `,
  c: `
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
    (struct_specifier name: (type_identifier) @name) @def
    (enum_specifier name: (type_identifier) @name) @def
  `,
  cpp: `
    (class_specifier name: (type_identifier) @name) @def
    (struct_specifier name: (type_identifier) @name) @def
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
  `,
  csharp: `
    (class_declaration name: (identifier) @name) @def
    (interface_declaration name: (identifier) @name) @def
    (method_declaration name: (identifier) @name) @def
    (enum_declaration name: (identifier) @name) @def
  `,
  kotlin: `
    (class_declaration (type_identifier) @name) @def
    (function_declaration (simple_identifier) @name) @def
    (object_declaration (type_identifier) @name) @def
  `,
  swift: `
    (class_declaration name: (type_identifier) @name) @def
    (struct_declaration name: (type_identifier) @name) @def
    (enum_declaration name: (type_identifier) @name) @def
    (protocol_declaration name: (type_identifier) @name) @def
    (function_declaration name: (simple_identifier) @name) @def
  `,
  scala: `
    (class_definition name: (identifier) @name) @def
    (object_definition name: (identifier) @name) @def
    (function_definition name: (identifier) @name) @def
    (trait_definition name: (identifier) @name) @def
  `,
  lua: `
    (function_declaration name: (identifier) @name) @def
    (function_definition name: (identifier) @name) @def
  `,
  elixir: `
    (call target: (identifier) @name (#eq? @name "defmodule")) @def
    (call target: (identifier) @name (#eq? @name "def")) @def
  `,
  solidity: `
    (contract_declaration name: (identifier) @name) @def
    (interface_declaration name: (identifier) @name) @def
    (function_definition name: (identifier) @name) @def
  `,
  bash: `
    (function_definition name: (word) @name) @def
  `,
  css: `
    (rule_set (selectors) @name) @def
  `,
  html: `
    (element (start_tag (tag_name) @name)) @def
  `,
  json: `
    (pair key: (string) @name) @def
  `,
  yaml: `
    (block_mapping_pair key: (flow_node) @name) @def
  `,
  toml: `
    (table (bare_key) @name) @def
    (pair (bare_key) @name) @def
  `,
  dart: `
    (class_definition name: (identifier) @name) @def
    (function_signature name: (identifier) @name) @def
    (method_signature name: (identifier) @name) @def
  `,
  zig: `
    (function_declaration name: (identifier) @name) @def
    (variable_declaration name: (identifier) @name) @def
  `,
  objc: `
    (class_interface name: (identifier) @name) @def
    (method_definition name: (identifier) @name) @def
    (function_definition declarator: (function_declarator declarator: (identifier) @name)) @def
  `,
  ocaml: `
    (value_definition (value_name) @name) @def
    (type_definition (type_constructor) @name) @def
    (module_definition (module_binding name: (module_name) @name)) @def
  `,
  elm: `
    (function_declaration_left (lower_case_identifier) @name) @def
    (type_alias_declaration_left (upper_case_identifier) @name) @def
  `,
  vue: `
    (script_element) @def
  `,
  rescript: `
    (let_declaration (value_name) @name) @def
    (type_declaration (type_constructor) @name) @def
  `,
  ql: `
    (class (className) @name) @def
    (predicate (predicateName) @name) @def
  `,
};

export function getTagQuery(language: string): string | undefined {
  return TAG_QUERIES[language];
}
