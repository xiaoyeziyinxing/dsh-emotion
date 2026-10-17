// dsh-emotion P1-a 入口（函数型，免构建 JS）
// P0：感知(user/message 规则快评) + 状态机 + 动态 prompt 段 + pre-execute 守卫
// P1-a 新增：storageDomain 持久化（跨进程）+ get_mood/express_emotion LLM 工具
// P1-b 待做：LLM 复核（ctx.llm.stream 签名待核）、EmotionChip UI（API remote）、迁 TS+vitest
// helper 由 lib/vendor.js 内联（npm dsh 包滞后/受限，见 vendor.js 头注）
import { defineDomain, domainTable, defineTool } from './vendor.js'
import { z } from 'zod'
import { ruleScore, nextState, decay, renderPrompt } from './logic.js'

export const name = 'emotion'
export const inject = ['systemPrompt', 'storageDomain', 'tools', 'llm']
export const removable = true

const stateSchema = z.object({
  valence: z.number(), arousal: z.number(), label: z.string(),
  intensity: z.number(), source: z.string(), updatedAt: z.number(),
})
const emotionDomain = defineDomain({
  name: 'emotion', version: 1,
  tables: { state: domainTable(stateSchema) },  // 键类型仅泛型，运行时只传 schema
})

export function apply(ctx, config = {}) {
  let state = {
    valence: 0, arousal: 0.2, label: '平静', intensity: 0, source: 'rule', updatedAt: Date.now(),
  }
  let domain = null

  // 持久化：异步 open + 启动时装载上次状态；句柄就绪前感知照走内存
  try {
    ctx.effect(async () => {
    try {
      domain = await ctx.storageDomain.open(emotionDomain)
      const saved = domain.table('state').get('current')
      if (saved) {
        state = decay(saved, config)
        console.log(`[emotion] restored: ${state.label} v=${state.valence.toFixed(2)}`)
      }
    } catch (e) {
      console.log('[emotion] storage open failed:', e?.message)
    }
    return () => { try { domain?.close() } catch { /* noop */ } }
    }, 'emotion.storage')
  } catch (e) { console.log('[emotion] storage effect failed:', e?.message) }

  const persist = () => {
    try { void domain?.table('state').put('current', state) } catch { /* noop */ }
  }

  // ②' LLM 复核（P1-b）：强信号/反讽触发，每 6 轮最多 1 次，M2 剥 <think> 后解析 JSON
  let turnCount = 0
  let rechecking = false
  const RECHECK_SYSTEM =
    '你是情绪分析器。对用户消息输出情绪 JSON：{"valence":数值-1~1,"arousal":数值0~1,"label":"中文两字词"}。'
    + '注意反讽/阴阳怪气：表面褒义词实际负面。只输出一行 JSON，不要输出思考过程。'
  const recheck = (text) => {
    if (rechecking || turnCount % (config.llmRecheckEvery ?? 6) !== 1) return
    rechecking = true
    void (async () => {
      try {
        let out = ''
        const stream = ctx.llm.stream({
          provider: config.llmProvider ?? 'minimax',
          model: config.llmModel ?? 'MiniMax-M2',
          system: RECHECK_SYSTEM,
          messages: [{ role: 'user', content: [{ type: 'text', text: `消息：${text}` }] }],
          maxTokens: 512,
        })
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') out += chunk.text
        }
        const json = out.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/)?.[0]
        const parsed = json ? JSON.parse(json) : null
        if (parsed && typeof parsed.valence === 'number') {
          state = nextState(decay(state, config), { valence: Math.max(-1, Math.min(1, parsed.valence)), strong: false, irony: false })
          state.source = 'llm'
          if (parsed.label) state.label = String(parsed.label).slice(0, 4)
          persist()
          console.log(`[emotion] recheck -> ${state.label} v=${state.valence.toFixed(2)} (llm)`)
        } else {
          console.log('[emotion] recheck unparsable:', out.slice(-80))
        }
      } catch (e) {
        console.log('[emotion] recheck failed:', e?.message)
      } finally {
        rechecking = false
      }
    })()
  }

  // ① 感知 + ② 生成：user/message(source=user) 取正文 → 规则快评 → 状态机 → 落盘
  ctx.on('session/event', (session, event) => {
    try {
      if (event?.type !== 'user/message') return
      const msg = event.data || {}
      if (msg.source?.kind !== 'user') return
      const text = (msg.content || []).filter((c) => c?.type === 'text').map((c) => c.text).join(' ')
      if (!text || text.startsWith('<') || text.startsWith('Current ')) return
      state = nextState(decay(state, config), ruleScore(text))
      persist()
      ctx.emit('emotion/changed', { ...state }) // 未来宿主 fork 转发浏览器的挂点（api-remotes 白名单）
      turnCount += 1
      console.log(`[emotion] state -> ${state.label} v=${state.valence.toFixed(2)} recheck=${state.recheckWanted}`)
      if (state.recheckWanted) recheck(text)
    } catch (e) {
      console.log('[emotion] perception skipped:', e?.message)
    }
  })

  // ④ 表达：函数式 prompt 段；rc.2 无 getSectionOrder → 数字回退 50（P0 实测）
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'EMOTION_STATE',
      order: ctx.systemPrompt.getSectionOrder('AGENT_PERSONA'),
      text: () => renderPrompt(decay(state, config)),
    }), 'emotion.section()')
  } catch {
    try {
      ctx.systemPrompt.section({
        name: 'EMOTION_STATE',
        order: 50,
        text: () => renderPrompt(decay(state, config)),
      })
      console.log('[emotion] section order fallback=50')
    } catch (e) {
      console.log('[emotion] prompt section skipped:', e?.message)
    }
  }

  // ⑤ 行动策略：get_mood（只读）/ express_emotion（表达）
  try {
    ctx.effect(function* () {
    yield ctx.tools.register(defineTool({
      name: 'get_mood',
      description: '查询助手当前的情绪状态（效价/标签/强度）。回复涉及情感色彩时可先调用。',
      parameters: {},
      output: { type: 'json' },
      execute: () => {
        const cur = decay(state, config)
        return { label: cur.label, valence: Number(cur.valence.toFixed(3)), intensity: Number(cur.intensity.toFixed(3)), source: cur.source }
      },
    }))
    yield ctx.tools.register(defineTool({
      name: 'express_emotion',
      description: '以当前情绪状态生成一行表达文本（≤60字），用于在回复中自然流露情绪。',
      parameters: {
        text: { type: 'string', required: false, description: '可选：想表达的核心内容' },
      },
      output: { type: 'json' },
      execute: (args) => {
        const cur = decay(state, config)
        const line = renderPrompt(cur)
        console.log(`[emotion] express: ${args?.text ? 'user-guided' : 'auto'}`)
        return { line, mood: cur.label, note: args?.text || null }
      },
    }))
  }, 'emotion.tools')
  } catch (e) { console.log('[emotion] tools effect failed:', e?.message) }

  // ⑥ 守卫：强负面情绪 + 风险类工具 → 追加 ask（approval 缺席时 fail-closed 拒绝）
  const RISKY = /write|delete|remove|exec|run|shell|command|install|uninstall/i
  ctx.on('tools/pre-execute', async (exec, next) => {
    const cur = decay(state, config)
    if (cur.valence < -0.5 && cur.intensity > 0.7 && RISKY.test(String(exec?.tool || ''))) {
      return { kind: 'ask', reason: `[emotion] 当前情绪 ${cur.label}，建议人工确认该操作` }
    }
    return next()
  })

  console.log('[emotion] P1-a mounted (rule+storage+tools)')
}
