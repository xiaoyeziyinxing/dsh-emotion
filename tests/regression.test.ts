import { describe, it, expect } from 'vitest'
import { ruleScore } from '../src/logic.js'

// 设计 §12 C2 人工标注基线：24 条混合样本（直接情绪 6 / 反讽阴阳 10 / 混合转折 5 / 中性口头语 3）
// 容差 ±0.45；TS 词典实现实测直判 19/24 = 79%（> 70% 可行阈值，与 C2 Python 原型一致），
// 5 条误判全部含反讽线索 → 反讽命中不修正效价、只升级 LLM 复核。
const SAMPLES: Array<{ text: string; human: number }> = [
  { text: '今天一切顺利，好开心', human: 0.8 },          // 1
  { text: '你这个功能做得真棒', human: 0.7 },            // 2
  { text: '谢谢，帮大忙了', human: 0.6 },                // 3
  { text: '文件又丢了，烦死了', human: -0.8 },           // 4
  { text: '这系统真垃圾', human: -0.8 },                 // 5
  { text: '太失望了，说好的支持呢', human: -0.7 },       // 6
  { text: '真是太棒了，又崩了一次', human: -0.7 },       // 7
  { text: '呵呵，干得真漂亮', human: -0.7 },             // 8
  { text: '可真是谢谢你啊，数据全没了', human: -0.8 },   // 9
  { text: '你真行，改一处崩三处', human: -0.7 },         // 10
  { text: '行吧，就这样吧', human: -0.1 },               // 11
  { text: '哦，知道了', human: 0.0 },                    // 12
  { text: '嗯，挺好的', human: 0.3 },                    // 13
  { text: '呵呵', human: -0.4 },                         // 14
  { text: '真是服了', human: -0.5 },                     // 15
  { text: '虽然崩了，但你修得真快，谢谢', human: 0.2 },  // 16
  { text: '速度是快，就是结果全错了', human: -0.5 },     // 17
  { text: '不是我说你，这么慢谁受得了', human: -0.6 },   // 18
  { text: '哈哈，又来了是吧', human: -0.4 },             // 19
  { text: '有没有搞错，又要重新登录', human: -0.6 },     // 20
  { text: '好了好了，我知道了', human: -0.2 },           // 21
  { text: '这个设计我真的很喜欢', human: 0.7 },          // 22
  { text: '无所谓，随便吧', human: -0.1 },               // 23
  { text: '比上次好多了，赞', human: 0.6 },              // 24
]

describe('§12 C2 24 样本回归基线', () => {
  const results = SAMPLES.map((s) => ({ ...s, score: ruleScore(s.text) }))
  const misses = results.filter((r) => Math.abs(r.score.valence - r.human) > 0.45)

  it('规则直判命中率 ≥ 70% 且对齐 C2 实测的 19/24', () => {
    expect(SAMPLES.length - misses.length).toBe(19)
    expect((SAMPLES.length - misses.length) / SAMPLES.length).toBeGreaterThanOrEqual(0.7)
  })

  it('误判样本固定为 5 条且全部含反讽线索（升级复核而非接受误差）', () => {
    expect(misses.map((r) => r.text)).toEqual([
      '太失望了，说好的支持呢',
      '真是太棒了，又崩了一次',
      '呵呵，干得真漂亮',
      '可真是谢谢你啊，数据全没了',
      '真是服了',
    ])
    for (const m of misses) expect(m.score.irony, m.text).toBe(true)
  })

  it('每条样本：直判命中 或 反讽升级，二者必有其一（不允许静默误判）', () => {
    for (const r of results) {
      const hit = Math.abs(r.score.valence - r.human) <= 0.45
      expect(hit || r.score.irony, r.text).toBe(true)
    }
  })
})
