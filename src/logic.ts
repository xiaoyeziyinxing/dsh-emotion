// dsh-emotion 纯函数内核（零依赖）：词典快评 / 状态机 / 惰性衰减 / prompt 表达
// 词典与反讽线索来自设计 §12 C2 实测基线：
//   24 样本规则直判 19/24 = 79%（> 70% 阈值），5 条误判全部含反讽线索
//   → 反讽命中只升级 LLM 复核、不修正效价。回归基线见 tests/regression.test.ts

export const LEXICON: Record<string, number> = {
  棒: 0.7, 好: 0.5, 开心: 0.8, 谢谢: 0.6, 快: 0.4, 漂亮: 0.6, 喜欢: 0.7, 顺利: 0.6, 赞: 0.7,
  崩: -0.8, 烦: -0.7, 烂: -0.8, 垃圾: -0.8, 失望: -0.7, 慢: -0.4, 错: -0.5, 又: -0.2, 丢: -0.6,
}
export const IRONY_MARKS = ['呵呵', '真是', '可真是', '真行', '服了', '谢谢你啊', '是吧', '呢'] as const
const STRONG = 0.5

export type ExpressionStyle = 'subtle' | 'explicit' | 'off'

export interface EmotionState {
  valence: number      // -1~1  效价
  arousal: number      // 0~1   唤醒度
  label: string        // 中文标签
  intensity: number    // 0~1   表达强度上限
  source: 'rule' | 'llm' | 'decay' | 'user'
  updatedAt: number
  recheckWanted?: boolean
}

export interface RuleScore { valence: number; strong: boolean; irony: boolean }

const clamp = (x: number): number => Math.max(-1, Math.min(1, x))

/** 规则快评：{valence, strong, irony}（irony/strong 是 LLM 复核触发条件） */
export function ruleScore(text: string | undefined | null): RuleScore {
  const s = String(text || '')
  let v = 0
  for (const [w, d] of Object.entries(LEXICON)) if (s.includes(w)) v += d
  v = clamp(v / 2)
  return { valence: v, strong: Math.abs(v) >= STRONG, irony: IRONY_MARKS.some((m) => s.includes(m)) }
}

/** 状态机：事件 × 旧状态 → 新状态（新信号权重 0.4 平滑融合） */
export function nextState(state: EmotionState, score: RuleScore, now = Date.now()): EmotionState {
  const k = 0.4
  const valence = clamp(state.valence * (1 - k) + score.valence * k)
  const arousal = clamp((state.arousal ?? 0.2) * (1 - k) + Math.abs(score.valence) * k)
  return {
    valence,
    arousal,
    label: planeLabel(valence, arousal),
    intensity: Math.max(Math.abs(valence), arousal * 0.8),
    source: 'rule',
    recheckWanted: Boolean(score.irony || score.strong),
    updatedAt: now,
  }
}

/** 惰性时间衰减（读时计算，免定时器）：valence 向 0 线性、arousal 向基线 0.2 收敛 */
export function decay(
  state: EmotionState,
  cfg: { decayPerHour?: number } | undefined,
  now = Date.now(),
): EmotionState {
  const hours = Math.max(0, (now - (state.updatedAt || now)) / 3600000)
  const f = Math.max(0, 1 - hours * (cfg?.decayPerHour ?? 0.15))
  return { ...state, valence: state.valence * f, arousal: 0.2 + (state.arousal - 0.2) * f }
}

/** vad 平面 → 中文标签 */
export function planeLabel(v: number, a: number): string {
  if (v > 0.3) return a > 0.55 ? '兴奋' : '开心'
  if (v < -0.3) return a > 0.55 ? '烦躁' : '沮丧'
  if (v < -0.1) return '低落'
  if (v > 0.1) return '平静偏愉'
  return '平静'
}

/** expressionStyle 非法值兜底（schema 未生效的旧宿主/直调场景） */
export function normalizeStyle(v: unknown): ExpressionStyle {
  return v === 'explicit' || v === 'off' ? v : 'subtle'
}

/** subtle 档显著度：|效价| ≥0.3 或唤醒/强度 ≥0.5 才值得注入（平静不说话） */
export function isSalient(state: Pick<EmotionState, 'valence' | 'arousal' | 'intensity'>): boolean {
  return Math.abs(state.valence) >= 0.3 || state.arousal >= 0.5 || state.intensity >= 0.5
}

/** subtle 档按标签给的语气提示（只描述不指令，设计 §5 示例风格） */
const STYLE_HINTS: Record<string, string> = {
  兴奋: '可保持热忱',
  开心: '可轻松一些',
  烦躁: '更克制温和',
  沮丧: '更温和并多些肯定',
  低落: '更柔和、多些鼓励',
  平静偏愉: '自然即可',
  平静: '自然即可',
}

/** 表达层渲染（≤60 字硬上限，设计 §5）：
 *  subtle   显著时注入一行（当前情绪 + 语气提示），平静时空串；
 *  explicit 始终注入完整状态行；
 *  off      不注入（纯内部记录，只供 UI / get_mood） */
export function renderPrompt(state: EmotionState, style: ExpressionStyle = 'subtle'): string {
  if (style === 'off') return ''
  if (style === 'subtle') {
    if (!isSalient(state)) return ''
    const hint = STYLE_HINTS[state.label] ?? '相应调整'
    return `（当前情绪：${state.label} valence=${state.valence.toFixed(2)}，回复语气${hint}）`
  }
  return `[EMOTION_STATE] 情绪=${state.label} 效价=${state.valence.toFixed(2)} 强度=${state.intensity.toFixed(2)} 来源=${state.source}`
}
