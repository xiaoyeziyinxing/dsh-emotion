import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apply, type EmotionConfig } from '../src/index.js'

// ---- fake 宿主 ctx：覆盖 emotion 用到的最小面 ----
function isThenable(v: any): boolean { return v && typeof v.then === 'function' }
function isGeneratorResult(v: any): boolean { return v && typeof v.next === 'function' && typeof v[Symbol.iterator] === 'function' }

function makeFakeCtx(opts: { withWeb?: boolean } = {}) {
  const listeners: Record<string, Array<(...a: any[]) => any>> = {}
  const sections: any[] = []
  const tools: any[] = []
  const tables: Record<string, Map<string, any>> = { state: new Map(), meta: new Map() }
  const asyncEffects: Promise<any>[] = []
  // 模拟真实 WebServer.register 的 class 方法语义（依赖 this）——
  // 用于抓住「裸解引用调用丢 this」这类只在真宿主暴露的 bug（v0.4.0 冒烟踩坑）
  class FakeWebServer {
    readonly routes = new Map<string, any>()
    register(route: any): () => void {
      if (this.routes.has(route.path)) throw new Error(`duplicate ${route.kind} route "${route.path}"`)
      this.routes.set(route.path, route)
      return () => { this.routes.delete(route.path) }
    }
  }
  const webServer = new FakeWebServer()

  const ctx: any = {
    on: (ev: string, fn: (...a: any[]) => any) => { (listeners[ev] ||= []).push(fn) },
    emit: vi.fn(),
    // cordis effect 语义近似：注册即执行；generator 逐个 drain（yield=注册）；async 收集待 settled
    effect: (fn: any) => {
      const r = typeof fn === 'function' ? fn() : undefined
      if (isThenable(r)) { asyncEffects.push(r); return }
      if (isGeneratorResult(r)) { for (const _ of r) { /* drain */ } }
    },
    get: (name: string) =>
      name === 'webServer' ? webServer
        : name === 'webRuntime' ? { trustedHosts: [] }
          : undefined,
    inject: (deps: string[], cb: (c: any) => void) => { if (opts.withWeb) cb(ctx) }, // 缺席 → 不调用（PENDING）
    systemPrompt: {
      section: (spec: any) => sections.push(spec),
      getSectionOrder: () => { throw new Error('rc.2 has no getSectionOrder') },
    },
    storageDomain: {
      open: async () => ({
        table: (n: string) => ({
          get: (k: string) => tables[n]?.get(k),
          put: async (k: string, v: any) => { (tables[n] ||= new Map()).set(k, v) },
        }),
        close() { /* noop */ },
      }),
    },
    tools: { register: (t: any) => { tools.push(t) } },
    llm: { stream: vi.fn() },
  }
  const runEffects = async () => { await Promise.allSettled(asyncEffects) }
  const onEvent = (event: any) => listeners['session/event'][0](null, event)
  const preExecute = (tool: string, next: any) => listeners['tools/pre-execute'][0]({ tool }, next)
  return { ctx, listeners, sections, tools, tables, webServer, runEffects, onEvent, preExecute }
}

const userMsg = (text: string) => ({
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

const jsonStream = (body: object) => vi.fn(async function* () {
  yield { type: 'text-delta', text: `<think>推理过程</think>${JSON.stringify(body)}` }
})

// ---- fake HTTP（/emotion/api handler 直调）----
function fakeReq(body: unknown, headers: Record<string, string>, url: string): any {
  return {
    headers, url, method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body ?? {})) },
  }
}
function fakeRes(): any {
  return {
    headersSent: false, statusCode: 0, body: '',
    writeHead(code: number) { this.statusCode = code },
    end(b?: string) { this.body = b ?? '' },
  }
}

beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { vi.useRealTimers() })

describe('挂载与感知（P0 主链路）', () => {
  it('挂载：prompt 段注册（order 回退 50）+ 两个工具注册 + 主插件日志', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    expect(f.sections).toHaveLength(1)
    expect(f.sections[0]).toMatchObject({ name: 'EMOTION_STATE', order: 50 })
    expect(f.tools.map((t: any) => t.name)).toEqual(['get_mood', 'express_emotion'])
  })

  it('非用户消息/注入前缀一律过滤，不产生状态', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    f.onEvent({ type: 'turn/start', data: {} })
    f.onEvent({ type: 'user/message', data: { source: { kind: 'runtime' }, content: [{ type: 'text', text: '垃圾' }] } })
    f.onEvent({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>注入</system-reminder>' }] } })
    expect(f.tables.state.get('current')).toBeUndefined()
  })

  it('用户消息 → 状态机 → 落盘 + emit emotion/changed + prompt 可读', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0, expressionStyle: 'explicit' })
    await f.runEffects()
    f.onEvent(userMsg('烂透了又崩'))
    const saved = f.tables.state.get('current')
    expect(saved.label).toBe('沮丧')
    expect(saved.source).toBe('rule')
    expect(saved.valence).toBeCloseTo(-0.36, 5)
    expect(f.ctx.emit).toHaveBeenCalledWith('emotion/changed', expect.objectContaining({ label: '沮丧' }))
    expect(f.sections[0].text()).toContain('情绪=沮丧')
  })
})

describe('LLM 复核（P1-b）：节流 + 剥 <think> + 失败降级', () => {
  it('首轮反讽消息触发复核，复核结果翻转 source=llm 且剥壳解析', async () => {
    const f = makeFakeCtx()
    f.ctx.llm.stream = jsonStream({ valence: -0.5, arousal: 0.6, label: '讽刺' })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    f.onEvent(userMsg('呵呵，干得真漂亮'))
    await vi.waitFor(() => {
      expect(f.tables.state.get('current')).toMatchObject({ source: 'llm', label: '讽刺' })
    })
    expect(f.ctx.llm.stream).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'minimax', model: 'MiniMax-M2', maxTokens: 512,
    }))
  })

  it('复核按 llmRecheckEvery 节流：第 2 条消息不再调用', async () => {
    const f = makeFakeCtx()
    f.ctx.llm.stream = jsonStream({ valence: -0.5, arousal: 0.6, label: '讽刺' })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    f.onEvent(userMsg('呵呵，干得真漂亮'))
    await vi.waitFor(() => { expect(f.tables.state.get('current').source).toBe('llm') })
    f.onEvent(userMsg('呵呵'))
    await new Promise((r) => setTimeout(r, 30))
    expect(f.ctx.llm.stream).toHaveBeenCalledTimes(1)
  })

  it('复核输出不可解析 → 状态降级保留 rule，不抛错', async () => {
    const f = makeFakeCtx()
    f.ctx.llm.stream = vi.fn(async function* () { yield { type: 'text-delta', text: '<think>…</think>抱歉无法输出' } })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    f.onEvent(userMsg('呵呵'))
    await new Promise((r) => setTimeout(r, 30))
    expect(f.ctx.llm.stream).toHaveBeenCalledTimes(1)
    expect(f.tables.state.get('current').source).toBe('rule')
  })

  it('复核异常（stream 抛错）→ 不阻塞对话，状态保留', async () => {
    const f = makeFakeCtx()
    f.ctx.llm.stream = vi.fn(() => { throw new Error('gateway down') })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    expect(() => f.onEvent(userMsg('呵呵'))).not.toThrow()
    await new Promise((r) => setTimeout(r, 30))
    expect(f.tables.state.get('current').source).toBe('rule')
  })
})

describe('安全守卫（⑥ 对齐）：只追加确认，绝不放行风险操作', () => {
  it('强负面 + 风险工具 → ask；自身工具与安全工具不受影响', async () => {
    const f = makeFakeCtx()
    f.tables.state.set('current', { valence: -0.9, arousal: 0.9, label: '烦躁', intensity: 0.9, source: 'rule', updatedAt: Date.now() })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await expect(f.preExecute('shell.run', next)).resolves.toMatchObject({ kind: 'ask' })
    expect(next).not.toHaveBeenCalled()
    await expect(f.preExecute('get_mood', next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('中性情绪 → 一律放行（情绪无权改变权限边界）', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    const next = vi.fn(async () => ({ kind: 'allow' }))
    await expect(f.preExecute('file.delete', next)).resolves.toEqual({ kind: 'allow' })
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('持久化与恢复（P1-a）', () => {
  it('跨重启恢复：装载旧状态并按 decayPerHour 衰减（2h × 0.15）', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const f = makeFakeCtx()
    f.tables.state.set('current', { valence: -0.8, arousal: 0.8, label: '沮丧', intensity: 0.8, source: 'rule', updatedAt: now - 2 * 3600_000 })
    apply(f.ctx, { decayPerHour: 0.15, expressionStyle: 'explicit' })
    await f.runEffects()
    expect(f.sections[0].text()).toContain('效价=-0.56')
    expect(f.sections[0].text()).toContain('情绪=沮丧')
  })

  it('恢复后多次读取幂等（v0.3.0 复合衰减 bug 回归）', async () => {
    vi.useFakeTimers()
    const now = Date.now()
    const f = makeFakeCtx()
    f.tables.state.set('current', { valence: -0.8, arousal: 0.8, label: '沮丧', intensity: 0.8, source: 'rule', updatedAt: now - 2 * 3600_000 })
    apply(f.ctx, { decayPerHour: 0.15, expressionStyle: 'explicit' })
    await f.runEffects()
    const t1 = f.sections[0].text()
    expect(t1).toContain('效价=-0.56')
    expect(f.sections[0].text()).toBe(t1)  // 重复读取不叠加衰减
  })

  it('UI 开关状态持久化恢复：enabled=false 时感知冻结、prompt 段置空', async () => {
    vi.useFakeTimers()
    const f = makeFakeCtx()
    f.tables.meta.set('ui', { enabled: false })
    apply(f.ctx, { decayPerHour: 0, expressionStyle: 'explicit' })
    await f.runEffects()
    expect(f.sections[0].text()).toBe('')
    f.onEvent(userMsg('烂透了又崩'))
    expect(f.tables.state.get('current')).toBeUndefined() // 感知停摆，未落盘
  })
})

describe('UI API（⑦ /emotion/api）：围栏 + 信封 + 开关', () => {
  it('无 webServer（headless）→ UI API 静默跳过，主链路不受影响', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    expect(f.webServer.routes.size).toBe(0)
    f.onEvent(userMsg('烂透了又崩'))
    expect(f.tables.state.get('current')).toMatchObject({ label: '沮丧' })
  })

  it('state/setEnabled 往返 + 落盘 + 未知方法 404 + 跨站 403', async () => {
    const f = makeFakeCtx({ withWeb: true })
    apply(f.ctx, { decayPerHour: 0 })
    await f.runEffects()
    expect(f.webServer.routes.size).toBe(1)
    const { path, handler } = f.webServer.routes.get('/emotion/api') as any
    expect(path).toBe('/emotion/api')
    const call = async (method: string, body?: unknown, headers: Record<string, string> = { host: 'localhost:3000' }) => {
      const res = fakeRes()
      await handler(fakeReq(body, headers, `/emotion/api/${method}`), res)
      return { status: res.statusCode as number, body: JSON.parse(res.body || '{}') }
    }

    const st0 = await call('state')
    expect(st0.status).toBe(200)
    expect(st0.body).toMatchObject({ ok: true, value: { enabled: true, label: '平静' } })

    const st1 = await call('setEnabled', { enabled: false })
    expect(st1.body.value.enabled).toBe(false)
    expect(f.tables.meta.get('ui')).toEqual({ enabled: false })

    // 开关关闭后感知冻结
    const before = f.tables.state.get('current')
    f.onEvent(userMsg('烂透了又崩'))
    expect(f.tables.state.get('current')).toEqual(before)

    const unknown = await call('nope')
    expect(unknown.status).toBe(404)
    expect(unknown.body.ok).toBe(false)

    const evil = await call('state', {}, { host: 'localhost:3000', origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' })
    expect(evil.status).toBe(403)
  })
})

describe('expressionStyle 配置贯通（v0.4.0）', () => {
  it('off：prompt 段恒空 + express_emotion 返回空行说明', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0, expressionStyle: 'off' })
    await f.runEffects()
    expect(f.sections[0].text()).toBe('')
    const express = f.tools.find((t: any) => t.name === 'express_emotion')
    await expect(express.execute({ text: '嗯' })).resolves.toMatchObject({ line: '' })
  })

  it('subtle：平静时空串，强负消息后注入一行', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0, expressionStyle: 'subtle' })
    await f.runEffects()
    expect(f.sections[0].text()).toBe('')
    f.onEvent(userMsg('烂透了又崩'))
    const line = f.sections[0].text()
    expect(line).toContain('当前情绪：沮丧')
    expect(line.length).toBeLessThanOrEqual(60)
  })

  it('get_mood 只读返回当前状态；express_emotion explicit 返回完整行', async () => {
    const f = makeFakeCtx()
    apply(f.ctx, { decayPerHour: 0, expressionStyle: 'explicit' })
    await f.runEffects()
    const getMood = f.tools.find((t: any) => t.name === 'get_mood')
    const express = f.tools.find((t: any) => t.name === 'express_emotion')
    await expect(getMood.execute({})).resolves.toMatchObject({ label: '平静', source: 'rule' })
    const r = await express.execute({})
    expect(r.line).toContain('[EMOTION_STATE]')
  })
})
