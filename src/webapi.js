// 侧边栏按钮用的 HTTP 接口：查每个号在不在线、断了就起 SnowLuma。
//
// 为什么走 HTTP 而不是再做一个工具：网页那半边只能 fetch，调不到 ctx.tools。
// 数据跟 qq_status 用同一份（hub.accounts 上的 client.probe），别各算各的。
//
// webServer 是可选依赖：它可能比本插件晚就绪，拿不到就先不挂，侧边栏按钮没数据源而已，
// 消息收发不受影响。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PREFIX = '/dsh-qq-gateway'

// 鱼塘 = fishtalk 的批注台（fishtalk label）。端口固定 8765：快捷入口的地址不能一次一换。
// 数据在 ~/.fishtalk，跟命令行共用一份，别让它回落到 cwd 下的空目录。
const FISHTALK_DIR = '<工作区>\\tools\\fishtalk-main'
const FISHTALK_DATA = path.join(os.homedir(), '.fishtalk')
const FISHTALK_PORT = 8765
const FISHTALK_URL = 'http://127.0.0.1:' + FISHTALK_PORT + '/'

/** 把 DSH 存在盘上的工作区目录名还原成路径：--D-AI-lan_work-- → D:\AI\lan_work。 */
function 解工作区(name) {
  const core = String(name).replace(/^--+/, '').replace(/--+$/, '')
  const parts = core.split('-')
  if (parts.length < 2) return ''
  const rest = parts.slice(1).map((seg) =>
    seg.replace(/~([0-9A-Fa-f]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
  )
  return parts[0] + ':\\' + rest.join('\\')
}

/** 白名单收成字符串数组：去掉空白和空项，别让逗号尾巴变成一条空规则。 */
function 收号表(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean)
  return String(value ?? '')
    .split(/[,，、;；\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
}

/** 收完整个请求体。设置页只发小 JSON，不设上限反而容易被误用。 */
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function 回(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(s)
  })
  res.end(s)
}

/** 逐个号问一遍登录态。跟 qq_status 工具同一套 probe，不另起一路。 */
export async function collectStatus(hub, config) {
  const byId = new Map((config?.accounts ?? []).map((a) => [String(a.id ?? ''), a]))
  const accounts = []
  for (const account of hub.accounts ?? []) {
    let probe = { ok: false, error: '没有 client' }
    try {
      probe = await account.client.probe()
    } catch (error) {
      probe = { ok: false, error: String(error?.message ?? error) }
    }
    const cfg = byId.get(String(account.id)) ?? {}
    accounts.push({
      id: account.id,
      label: String(cfg.label ?? ''),
      uin: String(cfg.uin ?? ''),
      owner: String(cfg.owner ?? ''),
      allow: {
        private: Array.isArray(cfg?.allow?.private) ? cfg.allow.private.map(String) : [],
        groups: Array.isArray(cfg?.allow?.groups) ? cfg.allow.groups.map(String) : []
      },
      httpUrl: String(account.httpUrl ?? ''),
      session: String(account.session ?? ''),
      online: probe.ok === true,
      nickname: String(probe.nickname ?? ''),
      selfId: String(probe.selfId ?? ''),
      error: String(probe.error ?? '')
    })
  }
  return accounts
}

/**
 * 挂上 /dsh-qq-gateway 前缀下的几条路由。
 * @returns 卸载函数；webServer 没就绪时给一个空函数，调用方不用判断。
 */
export function registerWebApi(ctx, hub, config, log) {
  const web = ctx?.get?.('webServer')
  if (!web?.register) return null

  const startScript = String(config?.snowlumaStartScript ?? 'D:\\AI\\snowluma\\start-snowluma.cmd')

  return web.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const route = String(req.url ?? '').split('?')[0]

      if (route === PREFIX + '/api/status') {
        return 回(res, 200, {
          ok: true,
          editor: Boolean(ctx.get('configEditor')),
          // 设置页要显示的全局项：这三个不按号分，一份管三个号。
          wake: {
            mode: String(config?.groupWakeMode ?? 'mention'),
            enabled: config?.groupWakeRandom !== false,
            probabilityPercent: Math.round(Number(config?.groupWakeProbability ?? 0) * 1000) / 10,
            intervalMin: Math.round((Number(config?.batchMaxWaitSec ?? 600) / 60) * 10) / 10,
            guidance: String(config?.wakeGuidance ?? ''),
            contextCount: Number(config?.contextMaxCount ?? 3),
            contextChars: Number(config?.contextMaxChars ?? 6000)
          },
          accounts: await collectStatus(hub, config)
        })
      }

      if (route === PREFIX + '/api/start') {
        if (req.method !== 'POST') return 回(res, 405, { ok: false, error: '用 POST' })

        // 已经有号在线上就别再拉一个 SnowLuma：两个实例抢同一组端口，
        // 表现是互相踢、连上又断。这类故障排查起来很费劲，不如在这里挡住。
        const accounts = await collectStatus(hub, config)
        if (accounts.some((a) => a.online)) {
          return 回(res, 200, { ok: true, started: false, reason: '已经有号在线，不用再起' })
        }

        if (!fs.existsSync(startScript)) {
          return 回(res, 200, { ok: false, error: '启动脚本不在：' + startScript })
        }
        try {
          // detached + unref：那个 cmd 里包的 wscript 是阻塞等的，不让它缠住 DSH。
          const child = spawn('cmd.exe', ['/c', startScript], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          })
          child.unref()
          log('侧边栏点了启动，拉了 ' + startScript)
          return 回(res, 200, { ok: true, started: true, script: startScript })
        } catch (error) {
          return 回(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      }

      // 鱼塘：本机 127.0.0.1:8765。没起就先拉起来（--no-open，窗口由这里开），起了就直接开。
      // 为什么走宿主：客户端 window.open 开出来的是 DSH 自己那个窗口，主人要的是默认浏览器满屏。
      if (route === PREFIX + '/api/fishtalk') {
        if (req.method !== 'POST') return 回(res, 405, { ok: false, error: '用 POST' })
        try {
          let alive = false
          try {
            const probe = await fetch(FISHTALK_URL, { signal: AbortSignal.timeout(1200) })
            alive = probe.status < 500
          } catch {
            alive = false
          }
          if (!alive) {
            const script = path.join(FISHTALK_DIR, 'fishtalk.js')
            if (!fs.existsSync(script)) {
              return 回(res, 200, { ok: false, error: '鱼塘脚本不在：' + script })
            }
            const child = spawn(process.execPath, [script, 'label', '--no-open', '--port', String(FISHTALK_PORT)], {
              cwd: FISHTALK_DIR,
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
              env: { ...process.env, FISHTALK_HOME: FISHTALK_DATA }
            })
            child.unref()
            // 它起 http 服务要一点时间，太早开浏览器会白页
            await new Promise((resolve) => setTimeout(resolve, 1600))
          }
          spawn('cmd.exe', ['/c', 'start', '', FISHTALK_URL], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true
          }).unref()
          log('侧边栏点了鱼塘，' + (alive ? '已经在跑，直接开' : '没在跑，拉起来再开'))
          return 回(res, 200, { ok: true, started: !alive, url: FISHTALK_URL })
        } catch (error) {
          return 回(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      }

      // 设置页要的：能选哪些对话。
      // 不能只列 ctx.sessions.list()：那只给当前进程里活着的，
      // lan 那间在 D 盘另一套工作区，没打开过就查不到，下拉里就只剩当前这间。
      // 所以盘上的也扫一遍，活的那个标 live，能不能投递一眼看得出来。
      if (route === PREFIX + '/api/sessions') {
        const seen = new Map()
        try {
          const store = ctx.get('sessions')
          for (const s of store?.list?.() ?? []) {
            const id = String(s?.id ?? '')
            if (!id) continue
            seen.set(id, { id, cwd: String(s?.header?.cwd ?? s?.cwd ?? ''), live: true })
          }
        } catch (error) {
          log('列活会话失败：' + String(error?.message ?? error))
        }
        try {
          const home = path.join(os.homedir(), '.dsh', 'sessions')
          for (const dir of fs.readdirSync(home, { withFileTypes: true })) {
            if (!dir.isDirectory()) continue
            const cwd = 解工作区(dir.name)
            let ids = []
            try {
              ids = fs.readdirSync(path.join(home, dir.name))
            } catch {
              continue
            }
            for (const id of ids) {
              if (seen.has(id)) continue
              seen.set(id, { id, cwd, live: false })
            }
          }
        } catch (error) {
          log('扫盘上的会话失败：' + String(error?.message ?? error))
        }
        const list = [...seen.values()]
          .filter((s) => s.id)
          .map((s) => ({
            id: s.id,
            cwd: s.cwd,
            live: s.live,
            title: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
          }))
          .sort((a, b) => Number(b.live) - Number(a.live) || a.cwd.localeCompare(b.cwd))
        return 回(res, 200, { ok: true, sessions: list })
      }

      // 设置页保存：写回 profile patch 里 qq-gateway 那条的 config。
      // 走 configEditor 而不是自己改 yaml：它会验证候选值、保留注释、写完立刻按正常生命周期应用。
      if (route === PREFIX + '/api/save') {
        if (req.method !== 'POST') return 回(res, 405, { ok: false, error: '用 POST' })
        const editor = ctx.get('configEditor')
        if (!editor) return 回(res, 200, { ok: false, error: '配置编辑服务没起来，先看 profile 里 config-editor 那条' })
        let body = {}
        try {
          body = JSON.parse(await readBody(req))
        } catch {
          return 回(res, 200, { ok: false, error: '请求体不是 JSON' })
        }
        const wanted = Array.isArray(body?.accounts) ? body.accounts : []
        const wake = body?.wake && typeof body.wake === 'object' ? body.wake : null
        if (wanted.length === 0 && !wake) return 回(res, 200, { ok: false, error: '没有要改的东西' })
        const entry = editor.entries().find((e) => e.options?.id === 'qq-gateway')
        if (!entry) return 回(res, 200, { ok: false, error: '找不到 qq-gateway 这条配置' })
        try {
          await editor.edit(entry, (current) => {
            const accounts = Array.isArray(current?.accounts) ? current.accounts : []
            const patchById = new Map(wanted.map((a) => [String(a.id ?? ''), a]))
            const nextWake = { ...current }
            if (wake) {
              if (wake.enabled !== undefined) nextWake.groupWakeRandom = Boolean(wake.enabled)
              if (wake.probabilityPercent !== undefined) {
                const p = Number(wake.probabilityPercent)
                nextWake.groupWakeProbability = Number.isFinite(p) ? Math.max(0, Math.min(100, p)) / 100 : 0
              }
              if (wake.intervalMin !== undefined) {
                const m = Number(wake.intervalMin)
                nextWake.batchMaxWaitSec = Number.isFinite(m) ? Math.max(0, Math.min(1440, m)) * 60 : 600
              }
              if (wake.guidance !== undefined) nextWake.wakeGuidance = String(wake.guidance)
              if (wake.contextCount !== undefined) {
                const n = Number(wake.contextCount)
                nextWake.contextMaxCount = Number.isFinite(n) ? Math.max(0, Math.min(200, n)) : 3
              }
              if (wake.contextChars !== undefined) {
                const n = Number(wake.contextChars)
                nextWake.contextMaxChars = Number.isFinite(n) ? Math.max(0, Math.min(200000, n)) : 6000
              }
            }
            return {
              ...nextWake,
              accounts: accounts.map((account) => {
                const patch = patchById.get(String(account?.id ?? ''))
                if (!patch) return account
                const next = { ...account }
                if (patch.label !== undefined) next.label = String(patch.label)
                if (patch.uin !== undefined) next.uin = String(patch.uin)
                if (patch.session !== undefined) next.session = String(patch.session)
                if (patch.owner !== undefined) next.owner = String(patch.owner)
                // 白名单整份换掉，不做合并：设置页那边看到什么就是什么，
                // 合并会让人删不掉一条，删了重启又回来。
                if (patch.private !== undefined || patch.groups !== undefined) {
                  const allow = { ...(account?.allow ?? {}) }
                  if (patch.private !== undefined) allow.private = 收号表(patch.private)
                  if (patch.groups !== undefined) allow.groups = 收号表(patch.groups)
                  next.allow = allow
                }
                return next
              })
            }
          })
          log('设置页保存了账号改动：' + wanted.map((a) => a.id).join(','))
          return 回(res, 200, { ok: true })
        } catch (error) {
          return 回(res, 200, { ok: false, error: String(error?.message ?? error) })
        }
      }

      return 回(res, 404, { ok: false, error: 'not found' })
    }
  })
}
