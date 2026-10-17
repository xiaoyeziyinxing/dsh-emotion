import { describe, it, expect } from 'vitest'
import {
  ruleScore, nextState, decay, planeLabel, renderPrompt, isSalient, normalizeStyle,
  type EmotionState,
} from '../src/logic.js'

const NOW = 1_800_000_000_000
const calm: EmotionState = { valence: 0, arousal: 0.2, label: '平静', intensity: 0, source: 'rule', updatedAt: NOW }

describe('ruleScore 规则快评', () => {
  it('正面/负面词典命中并折半', () => {
    expect(ruleScore('谢谢').valence).toBeGreaterThan(0)
    expect(ruleScore('这系统真垃圾').valence).toBeCloseTo(-0.4, 5)
    expect(ruleScore('烂透了又崩').valence).toBeCloseTo(-0.9, 5)
    expect(ruleScore('烂透了又崩').strong).toBe(true)
  })

  it('无命中归零；空输入安全', () => {
    expect(ruleScore('哦，知道了')).toMatchObject({ valence: 0, strong: false, irony: false })
    expect(ruleScore('')).toMatchObject({ valence: 0, irony: false })
    expect(ruleScore(undefined).valence).toBe(0)
  })

  it('反讽线索命中不修正效价、只置 irony 标记（设计 §4① 对策）', () => {
    const s = ruleScore('呵呵')
    expect(s.valence).toBe(0)          // 呵呵不在词典，不给效价
    expect(s.irony).toBe(true)         // 但触发复核
    expect(ruleScore('真是太棒了').irony).toBe(true)
    expect(ruleScore('真是服了').irony).toBe(true)
  })
})

describe('nextState 状态机（新信号权重 0.4 平滑）', () => {
  it('中性起点 + 强负信号（-0.9）→ -0.36 / 沮丧 + 复核标记', () => {
    const s = nextState(calm, ruleScore('烂透了又崩'), NOW)
    expect(s.valence).toBeCloseTo(-0.36, 5)   // 0.4 × (-0.9) 平滑融合
    expect(s.arousal).toBeCloseTo(0.48, 5)
    expect(s.label).toBe('沮丧')
    expect(s.source).toBe('rule')
    expect(s.recheckWanted).toBe(true)        // |信号| ≥ 0.5 强信号
  })

  it('弱负信号（-0.4）→ -0.16 / 低落，不触发复核', () => {
    const s = nextState(calm, ruleScore('这系统真垃圾'), NOW)
    expect(s.valence).toBeCloseTo(-0.16, 5)
    expect(s.label).toBe('低落')
    expect(s.recheckWanted).toBe(false)
  })

  it('反讽标记即使效价中性也触发复核（C2 对策核心）', () => {
    const s = nextState(calm, ruleScore('呵呵'), NOW)
    expect(s.valence).toBe(0)
    expect(s.recheckWanted).toBe(true)
  })

  it('效应价向上/向下双向收敛且被 clamp', () => {
    const strong: EmotionState = { ...calm, valence: -0.9, arousal: 0.9 }
    const up = nextState(strong, ruleScore('好开心，顺利，谢谢'), NOW)
    expect(up.valence).toBeGreaterThan(-0.9) // 向正方向移动
    expect(up.valence).toBeLessThanOrEqual(1)
  })
})

describe('decay 惰性时间衰减', () => {
  it('valence 向 0 线性、arousal 向基线 0.2 收敛（2 小时 × 0.15/h）', () => {
    const s: EmotionState = { ...calm, valence: -0.8, arousal: 0.8, updatedAt: NOW - 2 * 3600_000 }
    const d = decay(s, { decayPerHour: 0.15 }, NOW)
    expect(d.valence).toBeCloseTo(-0.56, 5)  // -0.8 × (1-0.3)
    expect(d.arousal).toBeCloseTo(0.62, 5)   // 0.2 + 0.6×0.7
    expect(d.label).toBe(calm.label)         // 衰减不改标签
  })

  it('无 decayPerHour 配置时用默认 0.15', () => {
    const s: EmotionState = { ...calm, valence: -0.8, arousal: 0.8, updatedAt: NOW - 2 * 3600_000 }
    expect(decay(s, undefined, NOW).valence).toBeCloseTo(-0.56, 5)
  })

  it('updatedAt 在未来/缺失时视作无衰减；衰减因子不越 0', () => {
    const future: EmotionState = { ...calm, valence: -0.8, arousal: 0.8, updatedAt: NOW + 3600_000 }
    expect(decay(future, { decayPerHour: 0.15 }, NOW).valence).toBeCloseTo(-0.8, 5)
    const extreme: EmotionState = { ...calm, valence: -0.8, arousal: 0.8, updatedAt: NOW - 100 * 3600_000 }
    const d = decay(extreme, { decayPerHour: 1 }, NOW)
    expect(d.valence).toBeCloseTo(0, 5)      // -0.8 × 0 = -0（符号零）
    expect(d.arousal).toBeCloseTo(0.2, 5)
  })
})

describe('planeLabel vad 平面分区', () => {
  it('七个分区边界', () => {
    expect(planeLabel(0.6, 0.6)).toBe('兴奋')
    expect(planeLabel(0.4, 0.3)).toBe('开心')
    expect(planeLabel(-0.4, 0.7)).toBe('烦躁')
    expect(planeLabel(-0.4, 0.3)).toBe('沮丧')
    expect(planeLabel(-0.2, 0.1)).toBe('低落')
    expect(planeLabel(0.2, 0.3)).toBe('平静偏愉')
    expect(planeLabel(0, 0.2)).toBe('平静')
  })
})

describe('expressionStyle 三档（设计 §5）', () => {
  it('normalizeStyle 非法值兜底为 subtle', () => {
    expect(normalizeStyle('explicit')).toBe('explicit')
    expect(normalizeStyle('off')).toBe('off')
    expect(normalizeStyle('subtle')).toBe('subtle')
    expect(normalizeStyle(undefined)).toBe('subtle')
    expect(normalizeStyle('bogus')).toBe('subtle')
  })

  it('off 恒空串（纯内部记录）', () => {
    expect(renderPrompt({ ...calm, label: '烦躁', valence: -0.7, intensity: 0.7 }, 'off')).toBe('')
  })

  it('subtle 平静不注入；显著时注入一行含语气提示', () => {
    expect(renderPrompt(calm, 'subtle')).toBe('')
    const annoyed: EmotionState = { ...calm, valence: -0.4, arousal: 0.28, intensity: 0.4, label: '沮丧' }
    const line = renderPrompt(annoyed, 'subtle')
    expect(line).toContain('当前情绪：沮丧')
    expect(line).toContain('valence=-0.40')
    expect(line).toContain('更温和并多些肯定')
  })

  it('explicit 始终注入完整状态行', () => {
    const line = renderPrompt(calm, 'explicit')
    expect(line).toContain('[EMOTION_STATE]')
    expect(line).toContain('情绪=平静')
    expect(line).toContain('来源=rule')
  })

  it('所有档位输出 ≤60 字硬上限（设计 §5）', () => {
    const states: EmotionState[] = [
      calm,
      { ...calm, valence: -0.9, arousal: 0.95, intensity: 0.9, label: '烦躁', source: 'llm' },
      { ...calm, valence: 0.9, arousal: 0.95, intensity: 0.9, label: '兴奋', source: 'llm' },
    ]
    for (const st of states) for (const style of ['subtle', 'explicit'] as const) {
      expect(renderPrompt(st, style).length, `${style}:${st.label}`).toBeLessThanOrEqual(60)
    }
  })

  it('isSalient 显著度边界', () => {
    expect(isSalient(calm)).toBe(false)
    expect(isSalient({ ...calm, valence: -0.3 })).toBe(true)   // ≥0.3 含边界
    expect(isSalient({ ...calm, valence: 0.29 })).toBe(false)
    expect(isSalient({ ...calm, arousal: 0.5 })).toBe(true)
    expect(isSalient({ ...calm, intensity: 0.5 })).toBe(true)
  })
})
