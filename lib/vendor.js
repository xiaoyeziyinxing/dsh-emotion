// 内联 helper（vendor）：npm 上 dsh 包滞后/受限，无法作依赖安装。
// 行为对齐 dsh@1517a4db 源码：storage-domain/src/spec.ts + core/tools/src/schema.ts。
// P1-b 迁 TS 时改回正式包引用。

export const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/ // storage/src/backend.ts:10

/** domainTable：schema 包一层 valueSchema（spec.ts:91-93） */
export const domainTable = (schema) => ({ valueSchema: schema })

/** defineDomain：字段校验 + 原样返回（spec.ts:107-147 精简，无 global/layout 高级项） */
export function defineDomain(spec) {
  if (!UNIT_NAME_RE.test(spec.name)) throw new Error(`domain name '${spec.name}' must match ${UNIT_NAME_RE}`)
  if (!Number.isInteger(spec.version) || spec.version < 0) throw new Error(`invalid version`)
  for (const t of Object.keys(spec.tables)) {
    if (!UNIT_NAME_RE.test(t)) throw new Error(`table name '${t}' must match ${UNIT_NAME_RE}`)
  }
  return spec
}

/** 参数 DSL → JSON Schema（schema.ts parameterSchemaSpecToJsonSchema 的最小等价） */
function paramsToJsonSchema(params) {
  const properties = {}
  const required = []
  for (const [name, p] of Object.entries(params || {})) {
    properties[name] = { type: p.type, description: p.description || '' }
    if (p.required) required.push(name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** defineTool：产出 registry 可用的 ToolDefinition（schema.ts:553-600 最小等价） */
export function defineTool(options) {
  const parameters = paramsToJsonSchema(options.parameters)
  const output = options.output || {}
  // {type:'json'} 是 DSL：转成"任意 JSON"的空 JSON Schema（schema.ts valueSchemaSpecToJsonSchema 等价）
  const outSchema = output.schema?.type === 'json' ? {} : (output.schema || {})
  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outSchema,
      render: (args, value) => output.render
        ? output.render(args, value)
        : [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      // 参数校验：必填缺失即抛（ToolArgsError 语义简化为 Error）
      const missing = (parameters.required || []).filter((k) => args?.[k] === undefined)
      if (missing.length) throw new Error(`missing required argument(s): ${missing.join(', ')}`)
      return options.execute(args, exec)
    },
  }
}
