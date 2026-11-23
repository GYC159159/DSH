/**
 * dsh-task-cost — 任务花销（Client 半边）
 *
 * 两处界面：
 *  1. conversation.input.left 里的「¥ 任务花销」按钮（每个会话一份）。
 *  2. shell.overlay 里的浮动小屏（整帧浮层，避免被输入框容器裁切）。
 *
 * 两块组件通过模块内的 store 通信；数据全部走 Host 的 /task-cost/* 接口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-task-cost',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /* ------------------------------------------------ app base (子路径部署兼容) */
    function detectBase() {
      try {
        const doc = typeof document === 'undefined' ? null : document
        if (!doc) return ''
        const fromPath = (p) => {
          const m = /^(.*?)\/plugins\//.exec(String(p || ''))
          return m ? String(m[1]).replace(/\/+$/, '') : null
        }
        const cur = doc.currentScript && doc.currentScript.src
        if (cur) {
          const b = fromPath(new URL(cur, doc.baseURI).pathname)
          if (b !== null) return b
        }
        for (const el of doc.querySelectorAll('script[src]')) {
          const b = fromPath(new URL(el.src, doc.baseURI).pathname)
          if (b !== null) return b
        }
        const path = new URL(doc.baseURI).pathname
        if (path.endsWith('/')) return path.replace(/\/+$/, '')
      } catch (e) { /* ignore */ }
      return ''
    }
    const APP_BASE = detectBase()
    const api = (route) => APP_BASE + '/task-cost' + route

    /* --------------------------------------------------------------- store */
    const store = {
      open: false,
      sessionId: null,
      listeners: new Set(),
    }
    const notify = () => {
      for (const fn of [...store.listeners]) {
        try { fn() } catch (e) { /* ignore */ }
      }
    }
    function setOpen(sessionId, open) {
      store.sessionId = sessionId || store.sessionId
      store.open = open
      notify()
    }
    function useStore() {
      const [, force] = React.useReducer((x) => x + 1, 0)
      React.useEffect(() => {
        store.listeners.add(force)
        return () => store.listeners.delete(force)
      }, [])
      return store
    }

    /* ---------------------------------------------------------------- fetch */
    async function getState(sessionId) {
      const qs = sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''
      const res = await fetch(api('/state' + qs), { credentials: 'same-origin' })
      if (!res.ok) throw new Error('state ' + res.status)
      return res.json()
    }
    async function post(route, body) {
      const res = await fetch(api(route), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || ('HTTP ' + res.status))
      }
      return data
    }

    /* -------------------------------------------------------------- format */
    function money(v, fallback = '—') {
      if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
      if (v > 0 && v < 0.01) return '¥' + v.toFixed(4)
      return '¥' + v.toFixed(2)
    }
    function spread(task, kind) {
      if (!task) return '—'
      const est = kind === 'budget' ? null : task.estimate
      if (!est) return '—'
      const down = est.center - est.low
      const up = est.high - est.center
      const fmt = (x) => (x < 0.01 ? x.toFixed(4) : x.toFixed(2))
      return '-' + fmt(down) + ' / +' + fmt(up)
    }
    function compactTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '?'
      if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
      if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
      return String(Math.round(n))
    }

    /* --------------------------------------------------------------- styles */
    const S = {
      btn: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '24px',
        padding: '0 8px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        fontSize: '11px',
        lineHeight: '16px',
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      },
      btnHot: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      panel: {
        position: 'fixed',
        right: '22px',
        bottom: '140px',
        width: '324px',
        zIndex: 70,
        padding: '12px 14px 14px',
        borderRadius: '14px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-overlay, var(--dsw-alias-bg-layer-1))',
        boxShadow: '0 18px 48px rgba(0,0,0,.28)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12.5px',
        lineHeight: '18px',
        fontFamily: 'inherit',
      },
      head: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: '8px',
      },
      title: { fontWeight: 600, fontSize: '13px', letterSpacing: '.02em' },
      close: {
        border: 'none',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: '15px',
        lineHeight: '15px',
        padding: '2px 4px',
      },
      row: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '5px 0',
        borderBottom: '1px dashed var(--dsw-alias-border-l1)',
      },
      label: { color: 'var(--dsw-alias-label-secondary)', flex: 'none' },
      value: {
        fontVariantNumeric: 'tabular-nums',
        textAlign: 'right',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '12px',
      },
      input: {
        width: '88px',
        height: '22px',
        padding: '0 6px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '12px',
        fontFamily: 'inherit',
        textAlign: 'right',
      },
      hint: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', marginTop: '6px' },
      block: {
        marginTop: '10px',
        padding: '9px 10px',
        borderRadius: '10px',
        border: '1px solid var(--dsw-alias-state-warn-primary)',
        background: 'color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent)',
      },
      plan: {
        marginTop: '6px',
        padding: '7px 8px',
        borderRadius: '8px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        cursor: 'pointer',
      },
      planTop: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'baseline' },
      tagOk: { fontSize: '10px', color: 'var(--dsw-alias-state-success-primary)' },
      tagBad: { fontSize: '10px', color: 'var(--dsw-alias-state-error-primary)' },
      actions: { display: 'flex', gap: '6px', marginTop: '9px', flexWrap: 'wrap' },
      action: {
        flex: '1 1 auto',
        height: '26px',
        padding: '0 8px',
        borderRadius: '7px',
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-primary)',
        fontSize: '11.5px',
        fontFamily: 'inherit',
        cursor: 'pointer',
      },
      actionPrimary: {
        borderColor: 'var(--dsw-alias-brand-primary)',
        color: 'var(--dsw-alias-brand-primary)',
      },
      foot: { marginTop: '8px', fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' },
    }

    function Row(props) {
      return h('div', { style: S.row },
        h('span', { style: S.label }, props.label),
        h('span', { style: Object.assign({}, S.value, props.style || {}) }, props.children))
    }

    /* ------------------------------------------------------ budget controls */
    function BudgetEditor(props) {
      const state = props.state
      const [budget, setBudget] = React.useState('')
      const [err, setErr] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [msg, setMsg] = React.useState('')
      const taskRunning = !!(state && state.task)

      React.useEffect(() => {
        if (!state) return
        setBudget(state.budget == null ? '' : String(state.budget))
        setErr(state.budgetError == null ? '' : String(state.budgetError))
      }, [state && state.budget, state && state.budgetError, state && state.task && state.task.id])

      const save = async () => {
        setBusy(true)
        setMsg('')
        try {
          await post('/budget', { sessionId: props.sessionId, budget, budgetError: err })
          setMsg('已保存')
          props.onSaved && props.onSaved()
        } catch (e) {
          setMsg('保存失败：' + (e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }

      return h('div', null,
        h('div', { style: S.row },
          h('span', { style: S.label }, '预算'),
          h('input', {
            style: S.input,
            type: 'number',
            min: '0',
            step: '0.1',
            placeholder: '元',
            value: budget,
            disabled: busy,
            onChange: (e) => setBudget(e.target.value),
          })),
        h('div', { style: S.row },
          h('span', { style: S.label }, '预算误差'),
          h('input', {
            style: S.input,
            type: 'number',
            min: '0',
            step: '0.1',
            placeholder: '±元',
            value: err,
            disabled: busy,
            onChange: (e) => setErr(e.target.value),
          })),
        h('div', { style: S.actions },
          h('button', {
            style: Object.assign({}, S.action, S.actionPrimary),
            disabled: busy,
            onClick: save,
          }, busy ? '保存中…' : (taskRunning ? '保存预算（立即重新判定）' : '保存预算')),
          msg ? h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-secondary)', alignSelf: 'center' } }, msg) : null))
    }

    /* ------------------------------------------------------------- decision */
    function DecisionBlock(props) {
      const task = props.state && props.state.task
      const [busy, setBusy] = React.useState(false)
      if (!task || !task.needsDecision) return null
      const plans = Array.isArray(task.plans) ? task.plans : []
      const act = async (action, planId) => {
        setBusy(true)
        try {
          await post('/decision', { sessionId: props.sessionId, action, planId })
          props.onDone && props.onDone()
        } catch (e) {
          props.onError && props.onError('操作失败：' + (e && e.message ? e.message : e))
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: S.block },
        h('div', { style: { fontWeight: 600, marginBottom: '2px' } }, '预估超出预算，等你定'),
        h('div', { style: S.hint }, '下面从小到大排列，优先选落在预算内的方案'),
        plans.length ? h('div', null, plans.map((p) => h('div', {
          key: p.id,
          style: S.plan,
          onClick: () => { if (!busy) act('switch', p.id) },
          title: '点一下改用这个方案',
        },
          h('div', { style: S.planTop },
            h('span', { style: { fontSize: '11.5px' } }, p.label),
            h('span', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '11px' } },
              money(p.estimate.low) + ' ~ ' + money(p.estimate.high))),
          h('div', { style: { display: 'flex', justifyContent: 'space-between', marginTop: '3px' } },
            h('span', { style: { fontSize: '10.5px', color: 'var(--dsw-alias-label-secondary)' } }, p.detail || ''),
            h('span', { style: p.within ? S.tagOk : S.tagBad }, p.within ? '预算内' : '超预算'))))) : null,
        h('div', { style: S.actions },
          h('button', { style: S.action, disabled: busy, onClick: () => act('execute') }, '仍按超预算执行'),
          h('button', { style: Object.assign({}, S.action, S.actionPrimary), disabled: busy, onClick: () => act('switch', 'lean') }, '改用节省方案'),
          h('button', { style: S.action, disabled: busy, onClick: () => act('cancel') }, '取消任务')))
    }

    /* ---------------------------------------------------------------- panel */
    function CostPanel() {
      const st = useStore()
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [refreshKey, setRefreshKey] = React.useState(0)

      const sessionId = st.sessionId

      React.useEffect(() => {
        if (!st.open || !sessionId) return undefined
        let alive = true
        const load = async () => {
          try {
            const data = await getState(sessionId)
            if (alive) {
              setState(data)
              setError('')
            }
          } catch (e) {
            if (alive) setError('读取失败：' + (e && e.message ? e.message : e))
          }
        }
        load()
        const timer = setInterval(load, 1500)
        return () => { alive = false; clearInterval(timer) }
      }, [st.open, sessionId, refreshKey])

      if (!st.open) return null

      const sess = (state && state.session) || { budget: null, budgetError: null, task: null }
      const task = sess.task
      const balance = (state && state.balance) || null
      const balanceText = balance && balance.status === 'ready' ? money(balance.amount) : '—'

      const actualText = !task
        ? '—'
        : task.status === 'cancelled'
          ? money(0)
          : task.status === 'done'
            ? money(task.actual)
            : '—'

      const meta = task
        ? '≈' + compactTokens(task.tokens && task.tokens.input) + ' in / '
          + compactTokens(task.tokens && task.tokens.output) + ' out · '
          + (task.steps || '?') + ' 步 · ' + (task.model || '?')
        : ''

      const decisionNote = task && task.decision && task.decision !== 'pending' && task.decision !== 'none'
        ? '决策：' + task.decision
        : ''

      return h('div', { style: S.panel, 'data-plugin': 'dsh-task-cost' },
        h('div', { style: S.head },
          h('div', { style: S.title }, '任务花销'),
          h('button', { style: S.close, title: '关闭', onClick: () => setOpen(sessionId, false) }, '×')),
        h(Row, { label: '该任务预计花费' }, task ? money(task.estimate.center) : '—'),
        h(Row, { label: '预估误差' }, spread(task)),
        h(Row, { label: '实际花费' }, actualText),
        h(Row, { label: '余额', style: { color: 'var(--dsw-alias-brand-primary)' } }, balanceText),
        h(BudgetEditor, {
          state: sess,
          sessionId,
          onSaved: () => setRefreshKey((k) => k + 1),
        }),
        task && meta ? h('div', { style: S.foot }, meta) : null,
        task && task.promptPreview ? h('div', { style: S.foot }, '任务：' + task.promptPreview) : null,
        task && task.status === 'running' && task.runningActual != null
          ? h('div', { style: S.foot }, '已消耗（进行中，仅供参考）：' + money(task.runningActual))
          : null,
        decisionNote ? h('div', { style: S.foot }, decisionNote) : null,
        h(DecisionBlock, {
          state: sess,
          sessionId,
          onDone: () => setRefreshKey((k) => k + 1),
          onError: (m) => setError(m),
        }),
        error ? h('div', { style: { marginTop: '6px', fontSize: '11px', color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h('div', { style: S.foot }, '单位：元 · 估算 = 模型单价 × token'),
      )
    }

    /* --------------------------------------------------------------- button */
    function CostButton(props) {
      const sessionId = props.sessionId
      const st = useStore()
      const [state, setState] = React.useState(null)
      const lastTaskRef = React.useRef(null)
      const seenDecisionRef = React.useRef(null)

      React.useEffect(() => {
        if (!sessionId) return undefined
        let alive = true
        const load = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
          try {
            const data = await getState(sessionId)
            if (!alive) return
            setState(data)
            const task = data && data.session && data.session.task
            if (!task) {
              lastTaskRef.current = null
              seenDecisionRef.current = null
              return
            }
            const isNewTask = lastTaskRef.current !== task.id
            const newDecision = task.needsDecision && seenDecisionRef.current !== task.id
            if (isNewTask || newDecision) {
              lastTaskRef.current = task.id
              if (newDecision) seenDecisionRef.current = task.id
              // 估算出来了 / 需要决策 → 自动弹出小屏
              if (!store.open) setOpen(sessionId, true)
            }
          } catch (e) { /* 静默：按钮不报错 */ }
        }
        load()
        const timer = setInterval(load, 2500)
        return () => { alive = false; clearInterval(timer) }
      }, [sessionId])

      const task = state && state.session && state.session.task
      const needs = !!(task && task.needsDecision)
      const opened = st.open && st.sessionId === sessionId
      const label = needs ? '花销 · 待决策' : (task && task.status === 'running' ? '花销 · 执行中' : '任务花销')

      return h('button', {
        type: 'button',
        style: Object.assign({}, S.btn, (needs || opened) ? S.btnHot : null),
        title: '任务花销：预算 / 预估 / 实际 / 余额',
        onClick: () => setOpen(sessionId, !opened),
      }, h('span', { style: { fontSize: '12px' } }, '¥'), label)
    }

    /* ---------------------------------------------------------------- apply */
    function apply(ctx) {
      ctx.slots.inject('conversation.input.left', () =>
        ctx.slots.register({
          name: 'conversation.input.left',
          id: 'dsh-task-cost:button',
          order: 24,
        }, CostButton))

      ctx.slots.inject('shell.overlay', () =>
        ctx.slots.register({
          name: 'shell.overlay',
          id: 'dsh-task-cost:panel',
          order: 88,
        }, CostPanel))
    }

    exports.name = 'dsh-task-cost'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})
