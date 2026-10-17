export declare const LEXICON: Record<string, number>;
export declare const IRONY_MARKS: readonly ["呵呵", "真是", "可真是", "真行", "服了", "谢谢你啊", "是吧", "呢"];
export type ExpressionStyle = 'subtle' | 'explicit' | 'off';
export interface EmotionState {
    valence: number;
    arousal: number;
    label: string;
    intensity: number;
    source: 'rule' | 'llm' | 'decay' | 'user';
    updatedAt: number;
    recheckWanted?: boolean;
}
export interface RuleScore {
    valence: number;
    strong: boolean;
    irony: boolean;
}
/** 规则快评：{valence, strong, irony}（irony/strong 是 LLM 复核触发条件） */
export declare function ruleScore(text: string | undefined | null): RuleScore;
/** 状态机：事件 × 旧状态 → 新状态（新信号权重 0.4 平滑融合） */
export declare function nextState(state: EmotionState, score: RuleScore, now?: number): EmotionState;
/** 惰性时间衰减（读时计算，免定时器）：valence 向 0 线性、arousal 向基线 0.2 收敛 */
export declare function decay(state: EmotionState, cfg: {
    decayPerHour?: number;
} | undefined, now?: number): EmotionState;
/** vad 平面 → 中文标签 */
export declare function planeLabel(v: number, a: number): string;
/** expressionStyle 非法值兜底（schema 未生效的旧宿主/直调场景） */
export declare function normalizeStyle(v: unknown): ExpressionStyle;
/** subtle 档显著度：|效价| ≥0.3 或唤醒/强度 ≥0.5 才值得注入（平静不说话） */
export declare function isSalient(state: Pick<EmotionState, 'valence' | 'arousal' | 'intensity'>): boolean;
/** 表达层渲染（≤60 字硬上限，设计 §5）：
 *  subtle   显著时注入一行（当前情绪 + 语气提示），平静时空串；
 *  explicit 始终注入完整状态行；
 *  off      不注入（纯内部记录，只供 UI / get_mood） */
export declare function renderPrompt(state: EmotionState, style?: ExpressionStyle): string;
