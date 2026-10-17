import sz from '@deepseek-ai/schemastery';
import { type ExpressionStyle } from './logic.js';
export declare const name = "emotion";
export declare const inject: string[];
export declare const removable = true;
/** 插件配置（cordis.patch.yml insert.config；缺省字段由宿主按 Config schema 填默认值） */
export interface EmotionConfig {
    /** 每小时向中性衰减（0~1），默认 0.15 */
    decayPerHour?: number;
    /** 每 N 轮最多 1 次 LLM 复核，默认 6 */
    llmRecheckEvery?: number;
    /** 表达风格：subtle（默认，显著时一行）/ explicit（始终全量）/ off（不注入，设计 §5） */
    expressionStyle?: ExpressionStyle;
    /** LLM 复核 provider，默认 minimax */
    llmProvider?: string;
    /** LLM 复核模型，默认 MiniMax-M2 */
    llmModel?: string;
}
export declare const Config: sz<EmotionConfig>;
interface StreamChunk {
    type?: string;
    text?: string;
}
interface TableHandle {
    get(key: string): unknown;
    put(key: string, value: unknown): unknown;
}
interface DomainHandle {
    table(name: string): TableHandle;
    close(): void;
}
interface SectionSpec {
    name: string;
    order: number;
    text: string | (() => string);
}
interface HostCtx {
    on(event: string, listener: (...args: any[]) => unknown): void;
    emit(event: string, ...args: unknown[]): void;
    effect(fn: () => unknown, name?: string): void;
    get(service: string): unknown;
    inject?(deps: string[], cb: (svcCtx: HostCtx) => void): void;
    systemPrompt: {
        section(spec: SectionSpec): void;
        getSectionOrder(name: string): number;
    };
    storageDomain: {
        open(domain: unknown): Promise<DomainHandle>;
    };
    tools: {
        register(tool: unknown): unknown;
    };
    llm: {
        stream(options: Record<string, unknown>): AsyncIterable<StreamChunk>;
    };
}
export declare function apply(ctx: HostCtx, config?: EmotionConfig): void;
export {};
