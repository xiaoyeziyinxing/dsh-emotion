// dsh-emotion 规则版情绪逻辑（P0，纯函数零依赖，供 index.js 与 node 冒烟共用）
// 词典与反讽线索来自设计 §12 C2 实测基线（24 样本纯规则命中 79%）

export const LEXICON = {
  棒: 0.7, 好: 0.5, 开心: 0.8, 谢谢: 0.6, 快: 0.4, 漂亮: 0.6, 喜欢: 0.7, 顺利: 0.6, 赞: 0.7,
  崩: -0.8, 烦: -0.7, 烂: -0.8, 垃圾: -0.8, 失望: -0.7, 慢: -0.4, 错: -0.5, 又: -0.2, 丢: -0.6,
}
export const IRONY_MARKS = ['呵呵', '真是', '可真是', '真行', '服了', '谢谢你啊', '是吧', '呢']
const STRONG = 0.5

const clamp = (x) => Math.max(-1, Math.min(1, x))

/** 规则快评：{valence, strong, irony}（P0 无 LLM；irony/strong 是 P1 复核触发条件） */
export function ruleScore(text) {
  const s = String(text || '')
  let v = 0
  for (const [w, d] of Object.entries(LEXICON)) if (s.includes(w)) v += d
  v = clamp(v / 2)
  return { valence: v, strong: Math.abs(v) >= STRONG, irony: IRONY_MARKS.some((m) => s.includes(m)) }
}

/** 状态机：事件 × 旧状态 → 新状态（新信号权重 0.4 平滑融合） */
export function nextState(state, score, now = Date.now()) {
  const k = 0.4
  const valence = clamp(state.valence * (1 - k) + score.valence * k)
  const arousal = clamp((state.arousal ?? 0.2) * (1 - k) + Math.abs(score.valence) * k)
  return {
    valence,
    arousal,
    label: planeLabel(valence, arousal),
    intensity: Math.max(Math.abs(valence), arousal * 0.8),
    source: 'rule',
    recheckWanted: Boolean(score.irony || score.strong), // P1 LLM 复核触发
    updatedAt: now,
  }
}

/** 惰性时间衰减（读时计算，免定时器）：valence 向 0 线性、arousal 向基线 0.2 收敛 */
export function decay(state, cfg, now = Date.now()) {
  const hours = Math.max(0, (now - (state.updatedAt || now)) / 3600000)
  const f = Math.max(0, 1 - hours * (cfg.decayPerHour ?? 0.15))
  return { ...state, valence: state.valence * f, arousal: 0.2 + (state.arousal - 0.2) * f }
}

/** vad 平面 → 中文标签 */
export function planeLabel(v, a) {
  if (v > 0.3) return a > 0.55 ? '兴奋' : '开心'
  if (v < -0.3) return a > 0.55 ? '烦躁' : '沮丧'
  if (v < -0.1) return '低落'
  if (v > 0.1) return '平静偏愉'
  return '平静'
}

/** P0 表达：恒注入一行（便于管线端到端验证），≤60 字；P1 换 subtle/explicit/off */
export function renderPrompt(state) {
  return `[EMOTION_STATE] 情绪=${state.label} 效价=${state.valence.toFixed(2)} 强度=${state.intensity.toFixed(2)} 来源=${state.source}`
}
