export declare const UNIT_NAME_RE: RegExp;
export interface DomainTableSpec {
    valueSchema: unknown;
}
export interface DomainSpec {
    name: string;
    version: number;
    tables: Record<string, DomainTableSpec>;
}
/** domainTable：schema 包一层 valueSchema（spec.ts:91-93） */
export declare const domainTable: (schema: unknown) => DomainTableSpec;
/** defineDomain：字段校验 + 原样返回（spec.ts:107-147 精简，无 global/layout 高级项） */
export declare function defineDomain(spec: DomainSpec): DomainSpec;
export interface ToolParam {
    type?: string;
    description?: string;
    required?: boolean;
}
export interface ToolOptions {
    name: string;
    description: string;
    parameters?: Record<string, ToolParam>;
    output?: {
        type?: string;
        schema?: Record<string, unknown>;
        render?: (args: unknown, value: unknown) => unknown[];
    };
    execute: (args: Record<string, unknown>, exec?: unknown) => unknown;
}
/** defineTool：产出 registry 可用的 ToolDefinition（schema.ts:553-600 最小等价） */
export declare function defineTool(options: ToolOptions): {
    name: string;
    description: string;
    parameters: {
        required?: string[] | undefined;
        type: string;
        properties: Record<string, unknown>;
    };
    output: {
        schema: Record<string, unknown>;
        render: (args: unknown, value: unknown) => unknown[];
    };
    execute(args: Record<string, unknown> | undefined, exec?: unknown): Promise<unknown>;
};
