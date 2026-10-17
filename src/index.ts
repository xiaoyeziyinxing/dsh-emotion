// dsh-emotion 宿主入口（函数型插件）
// P0：感知(user/message 规则快评) + 状态机 + 动态 prompt 段 + pre-execute 守卫
// P1-a：storageDomain 持久化（跨进程）+ get_mood/express_emotion LLM 工具
// P1-b：LLM 复核（ctx.llm.stream + 剥 <think>）+ EmotionChip UI
//   UI 通路（实拆 dsh-better-sidebar@0.26.1 证实）：宿主 webServer.register 挂
//   /emotion/api 前缀路由（POST JSON {ok:true,value} 信封），浏览器半包 lib/client.js
//   由桌面端 ModuleLoader 自动加载，fetch 轮询读取状态 + 点击开关。
//   ctx.remote.$on 只转发 API_REMOTE_FORWARDED_EVENTS 白名单事件，自定义事件进不去，
//   故 chip 用 2s 轮询而非事件推送。
// v0.4.0：迁 TypeScript（src/*.ts → 构建 lib/*.js）+ Config schema（schemastery，
//   官方 tool-web 同款函数型插件惯例）+ expressionStyle 三档（设计 §5）
// helper 由 vendor.ts 内联（npm dsh 包滞后/受限，见 vendor.ts 头注）
import { z } from 'zod'
import sz from '@deepseek-ai/schemastery'
import { defineDomain, domainTable, defineTool } from './vendor.js'
import {
  ruleScore, nextState, decay, renderPrompt, normalizeStyle,
  type EmotionState, type ExpressionStyle,
} from './logic.js'

export const name = 'emotion'
export const inject = ['systemPrompt', 'storageDomain', 'tools', 'llm']
export const removable = true

/** 插件配置（cordis.patch.yml insert.config；缺省字段由宿主按 Config schema 填默认值） */
export interface EmotionConfig {
  /** 每小时向中性衰减（0~1），默认 0.15 */
  decayPerHour?: number
  /** 每 N 轮最多 1 次 LLM 复核，默认 6 */
  llmRecheckEvery?: number
  /** 表达风格：subtle（默认，显著时一行）/ explicit（始终全量）/ off（不注入，设计 §5） */
  expressionStyle?: ExpressionStyle
  /** LLM 复核 provider，默认 minimax */
  llmProvider?: string
  /** LLM 复核模型，默认 MiniMax-M2 */
  llmModel?: string
}

export const Config: sz<EmotionConfig> = sz.object({
  decayPerHour: sz.number().default(0.15),
  llmRecheckEvery: sz.number().default(6),
  expressionStyle: sz.union(['subtle', 'explicit', 'off'] as const).default('subtle'),
  llmProvider: sz.string().default('minimax'),
  llmModel: sz.string().default('MiniMax-M2'),
})

const stateSchema = z.object({
  valence: z.number(), arousal: z.number(), label: z.string(),
  intensity: z.number(), source: z.string(), updatedAt: z.number(),
})
const metaSchema = z.object({ enabled: z.boolean() })
const emotionDomain = defineDomain({
  name: 'emotion', version: 1,  // 加 meta 表不改版本：json 后端按表名懒建，无迁移
  tables: {
    state: domainTable(stateSchema),  // 键类型仅泛型，运行时只传 schema
    meta: domainTable(metaSchema),
  },
})

// ---- 宿主服务的最小结构类型（不依赖 cordis 类型包，保持零宿主依赖）----
interface StreamChunk { type?: string; text?: string }
interface TableHandle {
  get(key: string): unknown
  put(key: string, value: unknown): unknown
}
interface DomainHandle { table(name: string): TableHandle; close(): void }
interface SectionSpec { name: string; order: number; text: string | (() => string) }
interface HostCtx {
  on(event: string, listener: (...args: any[]) => unknown): void
  emit(event: string, ...args: unknown[]): void
  effect(fn: () => unknown, name?: string): void
  get(service: string): unknown
  inject?(deps: string[], cb: (svcCtx: HostCtx) => void): void
  systemPrompt: { section(spec: SectionSpec): void; getSectionOrder(name: string): number }
  storageDomain: { open(domain: unknown): Promise<DomainHandle> }
  tools: { register(tool: unknown): unknown }
  llm: { stream(options: Record<string, unknown>): AsyncIterable<StreamChunk> }
}

export function apply(ctx: HostCtx, config: EmotionConfig = {}): void {
  const style = normalizeStyle(config.expressionStyle)
  const state: { cur: EmotionState } = {
    cur: { valence: 0, arousal: 0.2, label: '平静', intensity: 0, source: 'rule', updatedAt: Date.now() },
  }
  let domain: DomainHandle | null = null
  let enabled = true  // 对话框开关：关掉后感知停摆、prompt 段置空、守卫放行

  // 持久化：异步 open + 启动时装载上次状态；句柄就绪前感知照走内存
  try {
    ctx.effect(async () => {
    try {
      domain = await ctx.storageDomain.open(emotionDomain)
      const saved = domain.table('state').get('current') as EmotionState | undefined
      if (saved) {
        // 只装载原始值：衰减统一由读取方瞬态计算（幂等）。
        // 若在此处 decay 并回写，updatedAt 未推进会令后续每次读取重复衰减（v0.3.0 复合衰减 bug，0.4.0 修正）。
        state.cur = saved
        const shown = decay(saved, config)
        console.log(`[emotion] restored: ${shown.label} v=${shown.valence.toFixed(2)}`)
      }
      const meta = domain.table('meta').get('ui') as { enabled?: boolean } | undefined
      if (meta && typeof meta.enabled === 'boolean') {
        enabled = meta.enabled
        console.log(`[emotion] ui switch restored: ${enabled ? 'on' : 'off'}`)
      }
    } catch (e) {
      console.log('[emotion] storage open failed:', (e as Error)?.message)
    }
    return () => { try { domain?.close() } catch { /* noop */ } }
    }, 'emotion.storage')
  } catch (e) { console.log('[emotion] storage effect failed:', (e as Error)?.message) }

  const persist = () => {
    try { void domain?.table('state').put('current', state.cur) } catch { /* noop */ }
  }

  // ②' LLM 复核（P1-b）：强信号/反讽触发，每 6 轮最多 1 次，M2 剥 <think> 后解析 JSON
  let turnCount = 0
  let rechecking = false
  const RECHECK_SYSTEM =
    '你是情绪分析器。对用户消息输出情绪 JSON：{"valence":数值-1~1,"arousal":数值0~1,"label":"中文两字词"}。'
    + '注意反讽/阴阳怪气：表面褒义词实际负面。只输出一行 JSON，不要输出思考过程。'
  const recheck = (text: string): void => {
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
        const parsed = json ? JSON.parse(json) as { valence?: unknown; label?: unknown } : null
        if (parsed && typeof parsed.valence === 'number') {
          state.cur = nextState(decay(state.cur, config), {
            valence: Math.max(-1, Math.min(1, parsed.valence)), strong: false, irony: false,
          })
          state.cur.source = 'llm'
          if (parsed.label) state.cur.label = String(parsed.label).slice(0, 4)
          persist()
          console.log(`[emotion] recheck -> ${state.cur.label} v=${state.cur.valence.toFixed(2)} (llm)`)
        } else {
          console.log('[emotion] recheck unparsable:', out.slice(-80))
        }
      } catch (e) {
        console.log('[emotion] recheck failed:', (e as Error)?.message)
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
      const text = (msg.content || []).filter((c: any) => c?.type === 'text').map((c: any) => c.text).join(' ')
      if (!text || text.startsWith('<') || text.startsWith('Current ')) return
      if (!enabled) return  // 开关关闭：感知停摆，状态冻结不衰减
      state.cur = nextState(decay(state.cur, config), ruleScore(text))
      persist()
      ctx.emit('emotion/changed', { ...state.cur }) // 未来宿主 fork 转发浏览器的挂点（api-remotes 白名单）
      turnCount += 1
      console.log(`[emotion] state -> ${state.cur.label} v=${state.cur.valence.toFixed(2)} recheck=${state.cur.recheckWanted}`)
      if (state.cur.recheckWanted) recheck(text)
    } catch (e) {
      console.log('[emotion] perception skipped:', (e as Error)?.message)
    }
  })

  // ④ 表达：函数式 prompt 段；rc.2 无 getSectionOrder → 数字回退 50（P0 实测）
  // 开关关闭时段文本为空（sessionPrompt 对空段按无段处理）
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'EMOTION_STATE',
      order: ctx.systemPrompt.getSectionOrder('AGENT_PERSONA'),
      text: () => (enabled ? renderPrompt(decay(state.cur, config), style) : ''),
    }), 'emotion.section()')
  } catch {
    try {
      ctx.systemPrompt.section({
        name: 'EMOTION_STATE',
        order: 50,
        text: () => (enabled ? renderPrompt(decay(state.cur, config), style) : ''),
      })
      console.log('[emotion] section order fallback=50')
    } catch (e) {
      console.log('[emotion] prompt section skipped:', (e as Error)?.message)
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
        if (!enabled) return { disabled: true, note: '情绪模块已被用户关闭' }
        const cur = decay(state.cur, config)
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
        if (!enabled) return { line: '', mood: null, note: '情绪模块已被用户关闭' }
        const cur = decay(state.cur, config)
        if (style === 'off') return { line: '', mood: cur.label, note: 'expressionStyle=off，情绪仅内部记录' }
        const line = renderPrompt(cur, 'explicit')
        console.log(`[emotion] express: ${args?.text ? 'user-guided' : 'auto'}`)
        return { line, mood: cur.label, note: args?.text || null }
      },
    }))
  }, 'emotion.tools')
  } catch (e) { console.log('[emotion] tools effect failed:', (e as Error)?.message) }

  // ⑥ 守卫：强负面情绪 + 风险类工具 → 追加 ask（approval 缺席时 fail-closed 拒绝）
  const RISKY = /write|delete|remove|exec|run|shell|command|install|uninstall/i
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (!enabled) return next()
    const cur = decay(state.cur, config)
    if (cur.valence < -0.5 && cur.intensity > 0.7 && RISKY.test(String(exec?.tool || ''))) {
      return { kind: 'ask', reason: `[emotion] 当前情绪 ${cur.label}，建议人工确认该操作` }
    }
    return next()
  })

  // ⑦ UI API：/emotion/api 前缀路由（POST JSON，{ok:true,value} 信封），供对话框 chip 轮询与开关。
  // webServer/webRuntime 仅桌面端与 dsh web 存在：用 ctx.inject 声明依赖，缺席时内层插件
  // 保持 PENDING（headless 场景静默跳过），不拖累 emotion 本体加载。
  const mountUiApi = (svcCtx: HostCtx): void => {
    const webServer = svcCtx.get('webServer') as { register?: (r: unknown) => void } | undefined
    if (typeof webServer?.register !== 'function') {
      console.log('[emotion] webServer unavailable, UI api skipped')
      return
    }
    // bind 保留 this：WebServer.register 是 class 方法，裸解引用调用会丢 this（v0.4.0 冒烟实测踩坑）
    const registerRoute = webServer.register.bind(webServer)
    const webRuntime = svcCtx.get('webRuntime') as { trustedHosts?: string[] } | undefined
    const trustedHosts = webRuntime?.trustedHosts ?? []
    const json = (res: any, status: number, body: unknown) => {
      if (res.headersSent === true) { res.destroy?.(); return }
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(body))
    }
    const ok = (res: any, value: unknown) => json(res, 200, { ok: true, value })
    const fail = (res: any, status: number, code: string, message: string) => json(res, status, { ok: false, error: { code, message } })
    // 浏览器信任围栏（对齐 better-sidebar isTrustedApiRequest 的 API 分支）：
    // Host 头必须是 loopback 或受信主机；跨站一律拒；origin 缺省放行（桌面 shell 为 dsh-app://app）
    const loopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]'
      || (/^127(\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every((p) => Number(p) <= 255))
    const fence = (req: any): boolean => {
      try {
        const host = req.headers?.host
        if (!host) return false
        const hostUrl = new URL(`http://${host}`)
        if (!loopback(hostUrl.hostname)) {
          const trusted = trustedHosts.some((entry) => {
            try { return new URL(`http://${entry}`).hostname === hostUrl.hostname } catch { return false }
          })
          if (!trusted) return false
        }
        if (req.headers['sec-fetch-site'] === 'cross-site') return false
        const origin = req.headers.origin
        if (origin === undefined || origin === 'dsh-app://app') return true
        try { return new URL(origin).hostname === hostUrl.hostname } catch { return false }
      } catch { return false }
    }
    const readBody = async (req: any): Promise<Record<string, unknown>> => {
      const chunks: Buffer[] = []
      let total = 0
      for await (const chunk of req) {
        total += Buffer.from(chunk).length
        if (total > 65536) throw new Error('request body too large')
        chunks.push(Buffer.from(chunk))
      }
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return {}
      return JSON.parse(text)  // 非法 JSON 由外层 catch 兜底
    }
    const snapshot = () => {
      if (!enabled) return { enabled: false, label: null, valence: 0, arousal: 0, intensity: 0, source: null, updatedAt: 0 }
      const cur = decay(state.cur, config)
      return {
        enabled: true, label: cur.label, valence: Number(cur.valence.toFixed(3)),
        arousal: Number(cur.arousal.toFixed(3)), intensity: Number(cur.intensity.toFixed(3)),
        source: cur.source, updatedAt: cur.updatedAt,
      }
    }
    const api: Record<string, (payload: any) => unknown | Promise<unknown>> = {
      state: async () => snapshot(),
      setEnabled: async (payload) => {
        const next = payload?.enabled === true
        if (next !== enabled) {
          enabled = next
          try { void domain?.table('meta').put('ui', { enabled }) } catch { /* noop */ }
          ctx.emit('emotion/changed', { ...snapshot() })
          console.log(`[emotion] ui switch -> ${enabled ? 'on' : 'off'}`)
        }
        return snapshot()
      },
    }
    svcCtx.effect(() => registerRoute({
      kind: 'prefix',
      path: '/emotion/api',
      handler: async (req: any, res: any) => {
        try {
          if (!fence(req)) return fail(res, 403, 'forbidden', 'forbidden')
          if (req.method !== 'POST') return fail(res, 405, 'method-error', 'method not allowed')
          const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
          const method = pathname.startsWith('/emotion/api/') ? pathname.slice(13) : undefined
          if (!method || method.includes('/')) return fail(res, 404, 'not-found', 'unknown emotion api method')
          const handler = method && Object.hasOwn(api, method) ? api[method] : undefined
          if (typeof handler !== 'function') return fail(res, 404, 'not-found', `unknown emotion api method "${method}"`)
          ok(res, await handler(await readBody(req)))
        } catch (e) {
          fail(res, 400, 'bad-request', e instanceof Error ? e.message : String(e))
        }
      },
    }), 'emotion: /emotion/api route')
    console.log('[emotion] UI api mounted at /emotion/api')
  }
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer', 'webRuntime'], mountUiApi)
    } else {
      mountUiApi(ctx)  // 旧运行时无 ctx.inject：直接尝试，缺席则记日志跳过
    }
  } catch (e) { console.log('[emotion] ui api mount failed:', (e as Error)?.message) }

  console.log('[emotion] mounted (rule+storage+tools+ui-api)')
}
