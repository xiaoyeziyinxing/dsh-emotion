// dsh-emotion 浏览器半包（免构建手写 React）：
// 对话框输入区工具行（conversation.input.left）挂一枚情绪 chip：
//   启用中 → 色点 + 当前情绪标签，点击关闭；
//   已关闭 → 灰点 + 「情绪 关」，点击重新开启。
// 数据通路：POST /emotion/api/state | /emotion/api/setEnabled（2s 轮询，开关后立即刷新）。
// 加载契约（对齐 dsh-better-sidebar@0.26.1）：window.__ModuleLoader__.load({id, factory})，
// factory 返回 {apply, inject}，由桌面端 client cordis 运行时挂载。
window.__ModuleLoader__.load({
  id: 'dsh-emotion',
  factory: (require) => {
    const react = require('react')
    const h = react.createElement

    // 仅依赖宿主运行时提供的 slots 服务；react/react/jsx-runtime 为 shell 内建模块
    const inject = ['slots']

    const SLOT = 'conversation.input.left'
    const POLL_MS = 2000
    const FAIL_HIDE = 3  // 连续失败次数达到后隐藏 chip（headless/老宿主不渲染残留）

    // ---- 传输：document.baseURI 解析（桌面 shell 页面为 dsh-app://app/，同源转发到宿主）----
    function apiBase() {
      const url = new URL(document.baseURI || 'http://dsh.internal/')
      url.search = ''
      url.hash = ''
      if (!url.pathname.endsWith('/')) url.pathname += '/'
      return url.href
    }
    async function callApi(method, payload) {
      const response = await fetch(new URL(`emotion/api/${method}`, apiBase()).href, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      })
      const parsed = await response.json().catch(() => null)
      if (!response.ok || parsed === null || parsed.ok !== true || parsed.value === undefined) {
        throw new Error(parsed?.error?.message ?? `HTTP ${response.status}`)
      }
      return parsed.value
    }

    // ---- 视觉：效价 → 色点（负 #f2a1a1 / 正 #7ad39e / 中性 #98a2b3）----
    function dotColor(valence) {
      if (valence < -0.15) return '#f2a1a1'
      if (valence > 0.15) return '#7ad39e'
      return '#98a2b3'
    }

    function EmotionChip() {
      const [info, setInfo] = react.useState(null)      // {enabled,label,valence,...}
      const [ready, setReady] = react.useState(false)   // 首次应答到达前不渲染
      const fails = react.useRef(0)
      const busy = react.useRef(false)

      const refresh = react.useCallback(async () => {
        try {
          const value = await callApi('state')
          fails.current = 0
          setInfo(value)
          setReady(true)
        } catch {
          fails.current += 1
          if (fails.current >= FAIL_HIDE) setReady(false)
        }
      }, [])

      react.useEffect(() => {
        const tick = () => { if (!busy.current) void refresh() }
        tick()
        const timer = setInterval(tick, POLL_MS)
        const onVisible = () => { if (document.visibilityState === 'visible') tick() }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [refresh])

      const toggle = async () => {
        if (busy.current || !info) return
        busy.current = true
        const next = !info.enabled
        setInfo({ ...info, enabled: next })  // 乐观更新，轮询纠正
        try {
          const value = await callApi('setEnabled', { enabled: next })
          setInfo(value)
        } catch {
          void refresh()  // 失败回读真值
        } finally {
          busy.current = false
        }
      }

      if (!ready || !info) return null
      const on = info.enabled === true
      const title = on
        ? `情绪状态：${info.label ?? '—'}（点击关闭情绪表达）`
        : '情绪模块已关闭（点击开启）'
      return h('button', {
        type: 'button',
        onClick: toggle,
        title,
        'aria-pressed': on,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: '5px',
          height: '22px', padding: '0 9px', margin: '0 2px',
          border: '1px solid rgba(128,128,128,0.25)', borderRadius: '11px',
          background: 'transparent', color: 'inherit',
          font: 'inherit', fontSize: '12px', lineHeight: '20px',
          cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap',
          opacity: on ? 1 : 0.55,
        },
      },
        h('span', {
          'aria-hidden': true,
          style: {
            flex: 'none', width: '7px', height: '7px', borderRadius: '50%',
            background: on ? dotColor(info.valence) : '#6b7280',
          },
        }),
        h('span', null, on ? (info.label ?? '情绪') : '情绪 关'),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: 'dsh-emotion:chip',
        order: 90,
        registrant: 'dsh-emotion',
      }, () => h(EmotionChip))), 'dsh-emotion: input chip')
    }

    const module = { exports: {} }
    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
