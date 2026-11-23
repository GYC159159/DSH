/**
 * dsh-task-cost — 任务花销（Host 半边）
 *
 * 职责：
 *  1. 盯住每个会话的「布置任务 → 执行 → 结束」生命周期（session/event）。
 *  2. 任务开始时按 prompt 规模 + 当前上下文 token 估算 token 消耗，再按模型单价换成钱。
 *  3. 执行过程中按每个 assistant/message 的真实 usage 累加实际花费。
 *  4. 对外提供本地 HTTP 状态接口，供 Client 半边的小屏读取/写预算/做决策。
 *  5. 余额直接读 deepseekAccount.getBalance()，不落库。
 *
 * 估算口径（可改 prices.json）：
 *   单步输入 = 当前上下文 + 本次 prompt + 之前步骤的输出
 *   总输入 ≈ Σ步(上下文 + prompt) + 步骤²/2 × 单步输出 × 0.55
 *   总输出 ≈ 步骤 × 单步输出
 *   缓存命中按 55% 计入 cacheRead 单价（长会话重复前缀会被 DeepSeek 自动缓存）
 *   费用 = (未命中输入×输入单价 + 命中输入×缓存单价 + 输出×输出单价) / 1e6
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-task-cost'
export const inject = ['webServer']

const HERE = dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = process.env.DSH_PROFILE_DIR
  || join(process.env.DSH_HOME || join(process.env.USERPROFILE || '.', '.dsh'), 'profiles', 'desktop')
const DATA_DIR = join(PROFILE_DIR, 'data')
const STATE_FILE = join(DATA_DIR, 'task-cost-state.json')
const PRICE_FILE = join(HERE, 'prices.json')

const DEFAULT_PRICES = {
  currency: 'CNY',
  unit: '元 / 百万 token',
  default: { input: 2, cacheRead: 0.5, output: 8 },
  models: {},
}

const ROUTE_PREFIX = '/task-cost'

/* ------------------------------------------------------------------ utils */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
  } catch (err) {
    console.warn('[task-cost] 状态落盘失败:', err && err.message)
  }
}

function priceTable() {
  const file = readJson(PRICE_FILE, null)
  if (!file || typeof file !== 'object') return DEFAULT_PRICES
  return {
    currency: file.currency || 'CNY',
    unit: file.unit || DEFAULT_PRICES.unit,
    default: { ...DEFAULT_PRICES.default, ...(file.default || {}) },
    models: file.models || {},
  }
}

function rateFor(table, model) {
  const key = String(model || '').toLowerCase()
  if (key && table.models[key]) return { ...table.default, ...table.models[key] }
  for (const [name, rate] of Object.entries(table.models)) {
    if (key && (key.includes(name.toLowerCase()) || name.toLowerCase().includes(key))) {
      return { ...table.default, ...rate }
    }
  }
  // 粗粒度回退：reasoner 类模型输出更贵
  if (/reason|think|r1|pro/.test(key)) {
    return { ...table.default, output: table.default.output * 1.6 }
  }
  return { ...table.default }
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n')
  }
  if (content && typeof content.text === 'string') return content.text
  return ''
}

/* -------------------------------------------------------------- estimator */

/**
 * 任务规模分析：把一段 prompt 变成 step 数 / 单步输出 token / prompt token。
 * 目的不是精确，而是把「这句话大概要跑几步、要吐多少字」量化出来，
 * 再叠加当前上下文（那才是长会话里真正的大头）。
 */
function analyze(promptText, contextTokens) {
  const text = String(promptText || '')
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length
  const words = (text.match(/[A-Za-z0-9_.$#@/-]+/g) || []).length
  const codeFences = Math.floor(((text.match(/```/g) || []).length) / 2)
  const lines = text.split(/\r?\n/).length

  const promptTokens = Math.max(24, Math.round(cjk * 1.05 + words * 1.35 + lines * 0.8))

  const light = /^(你好|在吗|谢谢|多谢|早|晚安|hi|hello|thanks|ok|嗯|好)/i.test(text.trim()) && text.length < 40
  const heavy = /(实现|重构|修复|排查|部署|安装|写|改|插件|脚本|爬|分析|研究|审查|全量|所有|整个|批量|测试|文档|生成)/.test(text)

  let complexity = 1.1 + Math.min(2.6, text.length / 900) + Math.min(1.6, codeFences * 0.55)
  if (heavy) complexity += 1.05
  if (light) complexity = 0.3

  const steps = clamp(Math.round(1 + complexity * 1.55), 1, 14)
  const outputPerStep = clamp(240 + complexity * 300 + codeFences * 140, 200, 3600)

  const inputTokens = Math.round(steps * (contextTokens + promptTokens) + (steps * (steps - 1) / 2) * outputPerStep * 0.7)
  const outputTokens = Math.round(steps * outputPerStep)

  // 不确定性：复杂度越高、步骤越多，区间越宽
  const spread = clamp(0.34 + 0.22 * Math.min(1, complexity / 3.4) + 0.02 * Math.min(6, steps), 0.34, 0.95)

  return {
    promptTokens,
    contextTokens,
    steps,
    outputPerStep,
    tokens: { input: inputTokens, output: outputTokens },
    spread,
    complexity: round(complexity, 2),
  }
}

function costOf(tokens, rate) {
  const input = Math.max(0, tokens.input | 0)
  const output = Math.max(0, tokens.output | 0)
  const cacheRead = Math.round(input * 0.55)
  const miss = input - cacheRead
  return (miss * rate.input + cacheRead * rate.cacheRead + output * rate.output) / 1e6
}

/* --------------------------------------------------------------- the plugin */

export function apply(ctx) {
  const sessions = new Map()          // sessionId -> record
  const pendingPrompt = new Map()     // sessionId -> { text, at }
  const balanceCache = { at: 0, value: null }
  let persistTimer = null
  const eventCounts = {}          // type -> 收到的次数（诊断用）
  let lastEvent = null
  let lastError = null
  const startLog = []

  /* ---- 状态读写 ---- */

  const stored = readJson(STATE_FILE, { sessions: {} })
  if (stored && stored.sessions && typeof stored.sessions === 'object') {
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000
    for (const [id, rec] of Object.entries(stored.sessions)) {
      if (!rec || typeof rec !== 'object') continue
      if (rec.updatedAt && rec.updatedAt < cutoff) continue
      sessions.set(id, {
        budget: num(rec.budget),
        budgetError: num(rec.budgetError),
        task: rec.task && typeof rec.task === 'object' ? rec.task : null,
        history: Array.isArray(rec.history) ? rec.history.slice(-20) : [],
        updatedAt: rec.updatedAt || Date.now(),
      })
    }
  }

  function ensure(sessionId) {
    let rec = sessions.get(sessionId)
    if (!rec) {
      rec = { budget: undefined, budgetError: undefined, task: null, history: [], updatedAt: Date.now() }
      sessions.set(sessionId, rec)
    }
    return rec
  }

  function persistSoon() {
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      persist()
    }, 800)
    if (typeof persistTimer.unref === 'function') persistTimer.unref()
  }

  function persist() {
    const out = { version: 1, updatedAt: Date.now(), sessions: {} }
    const entries = [...sessions.entries()].sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0)).slice(0, 60)
    for (const [id, rec] of entries) out.sessions[id] = rec
    writeJson(STATE_FILE, out)
  }

  ctx.effect(() => () => {
    if (persistTimer) clearTimeout(persistTimer)
    persist()
  })

  /* ---- 余额 ---- */

  async function readBalance() {
    const now = Date.now()
    if (balanceCache.value && now - balanceCache.at < 20000) return balanceCache.value
    const account = ctx.get('deepseekAccount')
    if (!account || typeof account.getBalance !== 'function') {
      return { status: 'unavailable', reason: '账户服务未就绪' }
    }
    const meta = {
      version: '1.0.0',
      locale: 'zh-CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    }
    let value
    try {
      value = await Promise.race([
        account.getBalance(meta),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve({ status: 'timeout' }), 8000)
          if (typeof t.unref === 'function') t.unref()
        }),
      ])
    } catch (err) {
      value = { status: 'error', reason: err && err.message ? String(err.message) : '查询失败' }
    }
    const view = normalizeBalance(value)
    if (view.status === 'ready') {
      balanceCache.at = Date.now()
      balanceCache.value = view
    }
    return view
  }

  function normalizeBalance(value) {
    if (!value) return { status: 'unavailable', reason: '没有返回余额' }
    if (value.status !== 'ready') {
      return { status: value.status || 'unavailable', reason: value.reason || '余额不可用' }
    }
    const wallets = Array.isArray(value.value) ? value.value : []
    const bonus = Array.isArray(value.bonusWallets) ? value.bonusWallets : []
    const sumOf = (list) => list
      .filter((w) => w && (w.currency === 'CNY' || !w.currency))
      .reduce((s, w) => s + (Number(w.balance) || 0), 0)
    const main = sumOf(wallets)
    const extra = sumOf(bonus)
    return {
      status: 'ready',
      amount: round(main + extra, 2),
      main: round(main, 2),
      bonus: round(extra, 2),
      currency: 'CNY',
      raw: wallets.map((w) => ({ currency: w.currency, balance: w.balance })),
    }
  }

  /* ---- 会话上下文辅助 ---- */

  function contextTokensOf(session) {
    try {
      const meter = ctx.get('tokenMeter')
      if (!meter || typeof meter.measure !== 'function') return 0
      const m = meter.measure(session)
      const total = num(m && m.totalTokens) ?? num(m && m.surfaceTokens)
      return total && total > 0 ? total : 0
    } catch {
      return 0
    }
  }

  function modelOf(session) {
    try {
      const rc = session && typeof session.requestContext === 'function' ? session.requestContext() : null
      if (rc && rc.model) return rc.model
    } catch { /* 尚未发过请求 */ }
    try {
      const sel = ctx.get('agentDefaultModel') && ctx.get('agentDefaultModel').currentSelection()
      if (sel && sel.model) return sel.model
    } catch { /* ignore */ }
    return 'deepseek-chat'
  }

  /* ---- 任务生命周期 ---- */

  function plansFor(rec) {
    const task = rec.task
    if (!task || !task.estimate) return []
    const budget = num(rec.budget)
    const budgetError = num(rec.budgetError) || 0
    const upper = budget === undefined ? Infinity : budget + budgetError
    const lower = budget === undefined ? 0 : Math.max(0, budget - budgetError)
    const mk = (id, label, factor, detail) => {
      const center = round(task.estimate.center * factor, 4)
      const low = round(task.estimate.low * factor, 4)
      const high = round(task.estimate.high * factor, 4)
      return {
        id,
        label,
        detail,
        estimate: { center, low, high },
        within: high <= upper + 1e-9 && low >= lower - 1e-9,
      }
    }
    return [
      mk('as-is', '按当前模型跑完', 1, `≈${task.tokens.input.toLocaleString()} 输入 / ${task.tokens.output.toLocaleString()} 输出 token`),
      mk('lean', '节省模式：少探索、短输出', 0.55, '只做必要步骤，减少读文件与解释'),
      mk('cheap-model', '换低价模型/轻量模型', 0.3, '用便宜档模型重跑同一任务'),
    ]
  }

  function recheckDecision(rec) {
    const task = rec && rec.task
    if (!task || !task.estimate || task.status !== 'running') return
    const budget = num(rec.budget)
    const budgetError = num(rec.budgetError) || 0
    const hasBudget = budget !== undefined
    const upper = hasBudget ? budget + budgetError : Infinity
    const lower = hasBudget ? Math.max(0, budget - budgetError) : 0
    const within = hasBudget ? (task.estimate.high <= upper + 1e-9 && task.estimate.low >= lower - 1e-9) : true
    task.decision = hasBudget ? (within ? 'auto' : 'pending') : 'none'
    task.needsDecision = hasBudget ? !within : false
    if (within && task.decisionAt == null) task.decisionAt = Date.now()
    rec.updatedAt = Date.now()
  }

  function startTask(session, rec) {
    const pending = pendingPrompt.get(session.id)
    if (startLog.length > 24) startLog.shift()
    startLog.push({
      sid: session.id,
      hasPending: !!pending,
      textLen: pending ? String(pending.text || '').length : 0,
      at: Date.now(),
    })
    if (!pending || !String(pending.text || '').trim()) return
    if (String(pending.text).trim().startsWith('/')) {
      pendingPrompt.delete(session.id)
      return
    }
    // 上一轮若还挂着 running，结算掉
    if (rec.task && rec.task.status === 'running') settle(rec, 'completed')

    const table = priceTable()
    const model = modelOf(session)
    const rate = rateFor(table, model)
    const contextTokens = contextTokensOf(session)
    const a = analyze(pending.text, contextTokens)

    const modelCost = costOf(a.tokens, rate)
    const hist = rec.history.slice(-5)
    const histAvg = hist.length ? hist.reduce((s, v) => s + v, 0) / hist.length : 0
    const blend = histAvg > 0 ? 0.68 * modelCost + 0.32 * histAvg : modelCost

    const center = Math.max(0.0004, round(blend, 4))
    const low = Math.max(0.0001, round(center * (1 - a.spread), 4))
    const high = round(center * (1 + a.spread * 1.3), 4)

    const budget = num(rec.budget)
    const budgetError = num(rec.budgetError) || 0
    const hasBudget = budget !== undefined
    const upper = hasBudget ? budget + budgetError : Infinity
    const lower = hasBudget ? Math.max(0, budget - budgetError) : 0
    const within = hasBudget ? (high <= upper + 1e-9 && low >= lower - 1e-9) : true

    rec.task = {
      id: `t${Date.now().toString(36)}`,
      startedAt: Date.now(),
      model,
      rate,
      promptTokens: a.promptTokens,
      contextTokens: a.contextTokens,
      tokens: a.tokens,
      steps: a.steps,
      estimate: { center, low, high },
      status: 'running',
      decision: hasBudget ? (within ? 'auto' : 'pending') : 'none',
      needsDecision: hasBudget ? !within : false,
      decisionAt: null,
      chosenPlan: null,
      actual: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 },
      promptPreview: String(pending.text).trim().slice(0, 80),
      lastTurn: null,
    }
    pendingPrompt.delete(session.id)
    rec.updatedAt = Date.now()
    persistSoon()
    console.log(`[task-cost] 任务开始 ${rec.task.id} 预估 ¥${center} (${low}~${high}) withinBudget=${within}`)
  }

  function accumulate(session, rec, event) {
    const task = rec.task
    if (!task || task.status !== 'running') return
    const usage = event && event.usage
    if (!usage) return
    const rate = rateFor(priceTable(), modelOf(session) || task.model)
    const input = Number(usage.inputTokens) || 0
    const output = Number(usage.outputTokens) || 0
    const cacheRead = Number(usage.cacheReadTokens) || 0
    const cacheWrite = Number(usage.cacheWriteTokens) || 0
    const miss = Math.max(0, input - cacheRead)
    task.actual = (task.actual || 0)
      + (miss * rate.input + cacheRead * rate.cacheRead + output * rate.output) / 1e6
    const u = task.usage || (task.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 })
    u.input += input
    u.output += output
    u.cacheRead += cacheRead
    u.cacheWrite += cacheWrite
    u.messages += 1
    rec.updatedAt = Date.now()
    persistSoon()
  }

  function settle(rec, kind) {
    const task = rec.task
    if (!task || task.status !== 'running') return
    if (kind === 'cancelled') {
      task.status = 'cancelled'
      task.actual = 0
      task.cancelledAt = Date.now()
    } else {
      task.status = 'done'
      task.actual = round(task.actual || 0, 4)
      task.finishedAt = Date.now()
      rec.history = [...(rec.history || []), task.actual].slice(-20)
    }
    rec.updatedAt = Date.now()
    persistSoon()
  }

  function cancelTask(sessionId, rec) {
    const task = rec && rec.task
    if (!task) return
    settle(rec, 'cancelled')
    task.decision = 'cancelled'
    task.needsDecision = false
    task.decisionAt = Date.now()
    try {
      const agent = ctx.get('agents') && ctx.get('agents').get(sessionId)
      if (agent) {
        if (typeof agent.cancel === 'function') agent.cancel('task-cost: cancelled by user')
        else if (typeof agent.interrupt === 'function') agent.interrupt()
      }
    } catch (err) {
      console.warn('[task-cost] 取消运行失败:', err && err.message)
    }
    persistSoon()
  }

  /* ---- 事件订阅 ---- */

  ctx.on('session/event', (session, event) => {
    try {
      if (!session || !event) return
      const sid = session.id
      if (!sid) return
      const type = event.type
      // SessionEvent = { type, seq, time, data }；真实负载在 event.data 里
      const data = event.data || {}
      eventCounts[type] = (eventCounts[type] || 0) + 1
      lastEvent = { type, at: Date.now(), sessionId: sid }
      const rec = ensure(sid)

      if (type === 'user/message') {
        const text = textOf(data.content ?? (data.message && data.message.content))
        if (text && text.trim()) {
          pendingPrompt.set(sid, { text, at: Date.now() })
        }
        // 子代理/部分会话里 user/message 可能晚于 turn/start 落盘，这里补一次启动
        if (rec.awaitingStart != null && pendingPrompt.has(sid)) {
          rec.awaitingStart = null
          startTask(session, rec)
        }
        return
      }

      if (type === 'turn/start') {
        rec.task = rec.task || null
        if (pendingPrompt.has(sid)) {
          rec.awaitingStart = null
          startTask(session, rec)
        } else {
          rec.awaitingStart = num(data.turn) ?? 0
        }
        if (rec.task) rec.task.lastTurn = num(data.turn)
        return
      }

      if (type === 'assistant/message') {
        accumulate(session, rec, data)
        return
      }

      if (type === 'turn/end') {
        const reason = data.reason && data.reason.kind ? data.reason.kind : 'completed'
        if (reason === 'aborted' || reason === 'interrupted') settle(rec, 'cancelled')
        else settle(rec, 'completed')
        return
      }
    } catch (err) {
      lastError = String((err && err.stack) || err)
      console.warn('[task-cost] 事件处理异常:', err && err.message)
    }
  })

  /* ---- HTTP 接口 ---- */

  function sendJson(res, code, data) {
    const body = JSON.stringify(data)
    res.statusCode = code
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 1e6) req.destroy()
      })
      req.on('end', () => {
        try { resolve(raw ? JSON.parse(raw) : {}) } catch { resolve({}) }
      })
      req.on('error', () => resolve({}))
    })
  }

  function publicTask(rec) {
    const task = rec && rec.task
    if (!task) return null
    const out = {
      id: task.id,
      startedAt: task.startedAt,
      model: task.model,
      steps: task.steps,
      tokens: task.tokens,
      estimate: task.estimate,
      status: task.status,
      decision: task.decision,
      needsDecision: !!task.needsDecision,
      chosenPlan: task.chosenPlan || null,
      actual: task.status === 'cancelled' ? 0 : (task.status === 'done' ? round(task.actual || 0, 4) : null),
      runningActual: task.status === 'running' ? round(task.actual || 0, 4) : null,
      usage: task.usage,
      promptPreview: task.promptPreview,
    }
    if (task.needsDecision) out.plans = plansFor(rec)
    return out
  }

  function publicRecord(sessionId) {
    const rec = sessions.get(sessionId)
    return {
      budget: rec && num(rec.budget) !== undefined ? rec.budget : null,
      budgetError: rec && num(rec.budgetError) !== undefined ? rec.budgetError : null,
      task: publicTask(rec),
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    async handler(req, res) {
      const url = new URL(req.url || '/', 'http://localhost')
      const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          const sessionId = url.searchParams.get('sessionId') || ''
          const balance = await readBalance()
          sendJson(res, 200, {
            ok: true,
            now: Date.now(),
            sessionId,
            balance,
            session: sessionId ? publicRecord(sessionId) : { budget: null, budgetError: null, task: null },
            prices: { currency: 'CNY', unit: priceTable().unit },
          })
          return
        }
        if (route === '/budget' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId || '')
          if (!sessionId) return sendJson(res, 400, { ok: false, error: 'sessionId 缺失' })
          const rec = ensure(sessionId)
          rec.budget = num(Number(body.budget)) !== undefined && body.budget !== '' && body.budget != null
            ? Math.max(0, Number(body.budget))
            : undefined
          rec.budgetError = num(Number(body.budgetError)) !== undefined && body.budgetError !== '' && body.budgetError != null
            ? Math.max(0, Number(body.budgetError))
            : undefined
          recheckDecision(rec)
          rec.updatedAt = Date.now()
          persistSoon()
          return sendJson(res, 200, { ok: true, session: publicRecord(sessionId) })
        }
        if (route === '/decision' && req.method === 'POST') {
          const body = await readBody(req)
          const sessionId = String(body.sessionId || '')
          const action = String(body.action || '')
          const rec = ensure(sessionId)
          if (!rec.task) return sendJson(res, 409, { ok: false, error: '当前会话没有任务' })
          if (action === 'execute') {
            rec.task.decision = 'accepted-over-budget'
            rec.task.needsDecision = false
            rec.task.decisionAt = Date.now()
            rec.updatedAt = Date.now()
            persistSoon()
            return sendJson(res, 200, { ok: true, session: publicRecord(sessionId) })
          }
          if (action === 'switch') {
            const planId = String(body.planId || 'lean')
            rec.task.decision = 'switch:' + planId
            rec.task.chosenPlan = planId
            rec.task.needsDecision = false
            rec.task.decisionAt = Date.now()
            rec.updatedAt = Date.now()
            persistSoon()
            return sendJson(res, 200, { ok: true, session: publicRecord(sessionId) })
          }
          if (action === 'cancel') {
            cancelTask(sessionId, rec)
            return sendJson(res, 200, { ok: true, session: publicRecord(sessionId) })
          }
          return sendJson(res, 400, { ok: false, error: '未知 action' })
        }
        if (route === '/status' && req.method === 'GET') {
          let client = null
          try {
            const cm = ctx.get('clientModules')
            if (cm) {
              const g = cm.graph()
              const rows = g && Array.isArray(g.modules) ? g.modules : (g && Array.isArray(g.entries) ? g.entries : [])
              client = {
                path: (typeof cm.clientPath === 'function' && cm.clientPath('dsh-task-cost')) || null,
                baseline: (typeof cm.artifactBaseline === 'function' && cm.artifactBaseline('dsh-task-cost')) || null,
                graphKeys: g ? Object.keys(g) : [],
                rev: g && g.rev,
                entries: g && Array.isArray(g.entries) ? g.entries.map((e) => (e && (e.url || e.path || e.src || e.id || e)) || null).slice(0, 20) : null,
                batches: g && Array.isArray(g.batches) ? g.batches.slice(0, 10) : null,
                modules: rows.slice(0, 40).map((m) => (m && (m.id || m.name || m.package)) || String(m)),
              }
            }
          } catch (err) {
            client = { error: err && err.message ? String(err.message) : String(err) }
          }
          return sendJson(res, 200, {
            ok: true,
            version: '0.1.0',
            sessions: sessions.size,
            prices: priceTable(),
            stateFile: STATE_FILE,
            client,
            events: { counts: eventCounts, last: lastEvent, pending: pendingPrompt.size, lastError, startLog },
          })
        }
        sendJson(res, 404, { ok: false, error: 'not found' })
      } catch (err) {
        sendJson(res, 500, { ok: false, error: err && err.message ? String(err.message) : 'internal error' })
      }
    },
  }))

  console.log('[task-cost] 已就绪，状态接口 ' + ROUTE_PREFIX + '/state')
}
