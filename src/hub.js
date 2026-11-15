// 装配层：把账号表、状态、路由、工具、连接拼起来。
//
// 单独放在这里，是为了能在没有 DSH 的测试环境里跑：index.js 只留 Schema 和一句调用，
// 真正会出错的东西（账号解析、路径、启动、收尾）都在这个文件里，测试才够得着。

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { OneBotClient } from './onebot.js'
import { Store } from './store.js'
import { Router } from './router.js'
import { registerTools } from './tools.js'

export function statePath(explicit) {
  const want = String(explicit || '').trim()
  if (want) return want
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-gateway', 'state.json')
}

export function logPath(explicit) {
  const want = String(explicit || '').trim()
  if (want) return want
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'qq-gateway', 'gateway.log')
}

/**
 * 关键事件另写一份到文件。DSH 的日志只往终端走，验收时数不了数。
 * 每行独立 append，不重写整个文件——跟状态那种全量写不是一回事。
 */
export function createFileLogger(file) {
  const want = String(file || '').trim()
  if (!want) return null
  try { mkdirSync(dirname(want), { recursive: true }) } catch {}
  return (msg) => {
    try {
      const t = new Date().toTimeString().slice(0, 8)
      appendFileSync(want, t + ' ' + msg + '\n', 'utf8')
    } catch {}
  }
}

/** 账号表逐项校验。填不对的就跳过并说清，别带着半条配置去连。 */
export function parseAccounts(raw, log = () => {}) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    const id = String(item?.id ?? '').trim()
    if (!id) {
      log('有一项账号没填 id，跳过')
      continue
    }
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      log('账号别名 ' + id + ' 里有不认的字符，只用字母数字下划线连字符，跳过')
      continue
    }
    if (!String(item?.httpUrl ?? '').trim()) {
      log('账号 ' + id + ' 没填 httpUrl，跳过')
      continue
    }
    if (out.some((a) => a.id === id)) {
      log('账号别名 ' + id + ' 重复了，后一项跳过')
      continue
    }
    // 两个号配同一个会话，两条线就并进一个地方，效果跟串号一样。
    const session = String(item?.session ?? '').trim()
    if (session) {
      const sameSession = out.find((a) => a.session && a.session.replace(/^session-/, '') === session.replace(/^session-/, ''))
      if (sameSession) {
        log('账号 ' + id + ' 跟账号 ' + sameSession.id + ' 配的是同一个会话，后一项跳过（两个号投同一个会话等于串号）')
        continue
      }
    }
    // 两个号填同一个后端 = 消息串进别人的会话，而且从日志上看不出来。当面拦掉。
    const url = String(item.httpUrl).trim().replace(/\/+$/, '')
    const clash = out.find((a) => a.httpUrl.replace(/\/+$/, '') === url)
    if (clash) {
      log('账号 ' + id + ' 的 httpUrl 跟账号 ' + clash.id + ' 是同一个，后一项跳过（同一个后端不能挂两个别名）')
      continue
    }
    out.push({
      id,
      httpUrl: String(item.httpUrl).trim(),
      accessToken: String(item?.accessToken ?? ''),
      wsToken: String(item?.wsToken ?? ''),
      wsUrl: String(item?.wsUrl ?? '').trim(),
      session: String(item?.session ?? '').trim(),
      owner: String(item?.owner ?? '').trim(),
      allow: {
        private: Array.isArray(item?.allow?.private) ? item.allow.private.map(String) : [],
        groups: Array.isArray(item?.allow?.groups) ? item.allow.groups.map(String) : []
      },
      client: null
    })
  }
  return out
}

/**
 * @param {object} ctx 宿主上下文（测试时给假的）
 * @param {object} config 设置页那份配置
 * @param {(msg: string) => void} [log]
 */
export function createHub(ctx, config = {}, log = () => {}) {
  const accounts = parseAccounts(config?.accounts, log)
  const store = new Store(statePath(config?.stateFile), { log })
  const router = new Router({
    ctx,
    store,
    accounts,
    log,
    // 新旧两套同时挂着时，同一个号的消息会进两遍、都落进同一个会话。
    // 给新投的挂个标记，一眼分得出是谁投的，别把旧的那条当成新的通了。
    label: String(config?.label ?? '').trim(),
    followupTimeoutMs: Number(config?.followupTimeoutSec ?? 300) * 1000,
    maxQueueAgeMs: Number(config?.maxQueueAgeSec ?? 300) * 1000,
    batchQuietMs: Number(config?.batchQuietSec ?? 15) * 1000,
    criticalQuietMs: Number(config?.criticalQuietSec ?? 1.2) * 1000,
    batchMaxWaitMs: Number(config?.batchMaxWaitSec ?? 600) * 1000,
    groupWakeMode: config?.groupWakeMode,
      groupWakeRandom: config?.groupWakeRandom,
    groupWakeProbability: config?.groupWakeProbability,
    wakeGuidance: config?.wakeGuidance,
    contextMaxCount: Number(config?.contextMaxCount ?? 3),
    contextMaxChars: Number(config?.contextMaxChars ?? 6000)
  })
  const hub = { accounts, store, router }

  for (const account of accounts) {
    account.client = new OneBotClient({
      id: account.id,
      httpUrl: account.httpUrl,
      accessToken: account.accessToken,
      wsToken: account.wsToken,
      wsUrl: account.wsUrl,
      log,
      onEvent: (ev) => router.handleEvent(account, ev),
      onSystem: (msg) => { try { router.handleSystem(account, msg) } catch (e) { log('系统事件处理失败：' + (e?.message ?? e)) } }
    })
  }

  const disposers = []
  const register = (definition) => {
    try {
      const dispose = ctx.tools.register(definition)
      disposers.push(typeof dispose === 'function' ? dispose : () => {})
    } catch (error) {
      log('工具 ' + definition?.name + ' 挂不上：' + (error?.message ?? error))
    }
  }
  registerTools({ register, hub, log })

  let timer = null

  const start = () => {
    if (!accounts.length) {
      log('没配账号。工具已经挂上，qq_status 会告诉你列表是空的')
      return
    }
    for (const account of accounts) {
      account.client.start()
      account.client.probe().then((r) => {
        log('账号 ' + account.id + (r.ok ? ' 在线 ' + r.nickname : ' 暂时连不上：' + r.error))
      }).catch(() => {})
    }
    const intervalSec = Number(config?.probeIntervalSec ?? 120)
    if (intervalSec > 0) {
      timer = setInterval(() => {
        for (const account of accounts) account.client.probe().catch(() => {})
      }, intervalSec * 1000)
      if (typeof timer.unref === 'function') timer.unref()
    }
    log('起来了：' + accounts.length + ' 个账号，' + accounts.filter((a) => a.session).length + ' 个配了会话')
    // 把群唤醒策略打出来：概率是个静默配置，不写一行日志就没法确认它到底读没读到。
    // 开关关着的时候概率是不生效的，这行必须说清楚，否则日志上按 10% 掷、实际一条都不掷，排查时会被它骗。
    log('群唤醒：' + String(router?.groupWakeMode ?? 'mention') + (router?.groupWakeRandom === false
      ? '，概率唤醒已关，只认被点名'
      : '，没被点名时每条按 ' + String((router?.groupWakeProbability ?? 0) * 100) + '% 掷'))
  }

  const dispose = () => {
    if (timer) clearInterval(timer)
    timer = null
    // 先停排队：不然还没投的定时器会醒过来朝一个已经在拆的 ctx 投消息。
    try { router.dispose() } catch {}
    for (const account of accounts) {
      try { account.client?.stop() } catch {}
    }
    for (const d of disposers) {
      try { d() } catch {}
    }
    // 最后那批改动留在内存里会丢，卸载前必须落盘。
    try { store.flushNow() } catch {}
  }

  return { accounts, store, router, hub, start, dispose, dispositions: disposers }
}
