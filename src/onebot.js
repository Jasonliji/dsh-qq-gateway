// OneBot 11 后端客户端。
//
// 一个账号一个实例：HTTP 用来调接口（发消息、查资料、改签名），WS 或者 HTTP 上报用来收
// 事件。这里只管协议，不管「消息该去哪个人」——那是 router 的事。
//
// 只认 OneBot 11 这一层，具体后端是 SnowLuma、NapCat 还是别的，都与本文件无关。

const DEFAULT_TIMEOUT = 20000

export class OneBotError extends Error {
  constructor(message, { action, status, body } = {}) {
    super(message)
    this.name = 'OneBotError'
    this.action = action
    this.status = status
    this.body = body
  }
}

function trimUrl(u) {
  return String(u || '').replace(/\/+$/, '')
}

export class OneBotClient {
  /**
   * @param {object} opts
   * @param {string} opts.id 账号别名，工具里用它区分是谁
   * @param {string} opts.httpUrl 例：http://127.0.0.1:3010
   * @param {string} [opts.accessToken] 后端令牌，走 Authorization: Bearer
   * @param {string} [opts.wsUrl] 例：ws://127.0.0.1:3011
   * @param {string} [opts.wsToken] WS 的令牌，跟 HTTP 那个通常不是同一个。不给就退回 accessToken
   * @param {(ev: object) => void} [opts.onEvent] 收到事件（含心跳）时回调
   * @param {(msg: string) => void} [opts.onSystem] 连接状态变化时回调（断线、恢复）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.id = opts.id
    this.httpUrl = trimUrl(opts.httpUrl)
    this.accessToken = String(opts.accessToken || '')
    // WS 的令牌跟 HTTP 是两把，别混。OneBot 的配置里 httpServers 和 wsServers 各有一个
    // accessToken，实测 SnowLuma 就是这么分的——拿 HTTP 那把去连 WS，1006。
    this.wsToken = String(opts.wsToken || opts.accessToken || '')
    this.wsUrl = opts.wsUrl ? String(opts.wsUrl) : ''
    this.onEvent = opts.onEvent ?? (() => {})
    this.onSystem = opts.onSystem ?? (() => {})
    this.log = opts.log ?? (() => {})
    this.selfId = 0
    this.nickname = ''
    this.online = false
    this.ws = null
    this.wsRetryMs = 3000
    this.wsStopped = false
    this.lastError = ''
  }

  headers() {
    const h = { 'content-type': 'application/json' }
    if (this.accessToken) h.authorization = 'Bearer ' + this.accessToken
    return h
  }

  /** 调一个 OneBot 动作。失败抛 OneBotError，调用方决定是重试还是报给用户。 */
  async call(action, params = {}, { timeout = DEFAULT_TIMEOUT } = {}) {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeout)
    try {
      const res = await fetch(this.httpUrl + '/' + action, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify(params),
        signal: ctl.signal
      })
      const text = await res.text()
      let json
      try { json = JSON.parse(text) } catch { json = null }
      if (!res.ok) {
        throw new OneBotError(action + ' 返回 HTTP ' + res.status, { action, status: res.status, body: text.slice(0, 400) })
      }
      if (json && json.status === 'failed') {
        throw new OneBotError(action + ' 失败：' + (json.wording || json.message || '后端拒绝'), { action, status: res.status, body: text.slice(0, 400) })
      }
      return json?.data ?? json
    } catch (error) {
      if (error instanceof OneBotError) throw error
      const reason = error?.name === 'AbortError'
        ? action + ' 超时（' + timeout + 'ms）'
        : action + ' 连不上后端：' + (error?.message ?? String(error))
      this.lastError = reason
      throw new OneBotError(reason, { action })
    } finally {
      clearTimeout(timer)
    }
  }

  /** 探一次登录态。拿不到就当掉线，不抛。 */
  async probe() {
    try {
      const info = await this.call('get_login_info', {}, { timeout: 8000 })
      this.selfId = Number(info?.user_id ?? 0) || this.selfId
      this.nickname = String(info?.nickname ?? this.nickname ?? '')
      this.online = true
      this.lastError = ''
      return { ok: true, selfId: this.selfId, nickname: this.nickname }
    } catch (error) {
      this.online = false
      this.lastError = error?.message ?? String(error)
      return { ok: false, error: this.lastError }
    }
  }

  /** 连上收事件的 WS。DSH 的运行时够新才有全局 WebSocket，没有就明说。 */
  start() {
    if (!this.wsUrl) return
    if (typeof WebSocket === 'undefined') {
      this.log('这个运行时没有全局 WebSocket，' + this.id + ' 改用 HTTP 上报模式')
      return
    }
    this.wsStopped = false
    this.openWs()
  }

  openWs() {
    if (this.wsStopped) return
    let ws
    try {
      // 令牌只能走 query，不能塞 header：Node 自带的 WebSocket 第二个参数是子协议，
      // 传 { headers } 会被当成协议名，鉴权过不去，表现就是连上立刻 1006。
      const url = this.wsToken
        ? this.wsUrl + (this.wsUrl.includes('?') ? '&' : '?') + 'access_token=' + encodeURIComponent(this.wsToken)
        : this.wsUrl
      ws = new WebSocket(url)
    } catch (error) {
      this.log(this.id + ' 建 WS 失败：' + (error?.message ?? error))
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.log(this.id + ' WS 已连上 ' + this.wsUrl)
      const back = this.wasDown
      this.wasDown = false
      this.wsRetryMs = 3000
      // 恢复也要说一声：断线时投了一条，接上了得让人知道风平浪静了。
      if (back) this.onSystem('连接恢复了')
    })
    ws.addEventListener('message', (ev) => {
      let payload
      try { payload = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) } catch { return }
      this.handlePayload(payload)
    })
    ws.addEventListener('close', (ev) => {
      this.log(this.id + ' WS 断开 code=' + (ev?.code ?? '?') + ' reason=' + String(ev?.reason ?? '') + '，' + Math.round(this.wsRetryMs / 1000) + ' 秒后重连')
      // 主动 stop 的（插件重载、改配置、关插件）不是故障，别往会话里推告警。
      // 2026-11-15：设一次保存踢了两次重载，会话里连刷五条「后端连接断了」，
      // 全是自己断的，看着像出事。真断（对面挂了）才说。
      if (!this.wsStopped && !this.wasDown) {
        this.wasDown = true
        this.onSystem('后端连接断了，正在重连 ' + this.wsUrl + '。这期间收不到新消息')
      }
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      // close 会跟着来，这里不重复挂重连
    })
  }

  scheduleReconnect() {
    if (this.wsStopped) return
    const wait = this.wsRetryMs
    this.wsRetryMs = Math.min(Math.round(this.wsRetryMs * 1.7), 60000)
    this.ws = null
    const t = setTimeout(() => this.openWs(), wait)
    if (typeof t.unref === 'function') t.unref()
  }

  stop() {
    this.wsStopped = true
    try { this.ws?.close() } catch {}
    this.ws = null
  }

  /** OneBot 的 WS 会同时推事件和接口回声，只把事件往外给。 */
  handlePayload(payload) {
    if (!payload || typeof payload !== 'object') return
    if (payload.post_type) {
      if (payload.self_id) this.selfId = Number(payload.self_id) || this.selfId
      this.onEvent(payload, this)
      return
    }
    if (payload.echo !== undefined) return
  }

  /** HTTP 上报模式：外部把事件 POST 进来时调这个。 */
  ingest(payload) {
    this.handlePayload(payload)
  }
}

/** 把 OneBot 的 message 段或者字符串压成纯文本。图、表情、语音留标记，别当成字。 */
export function segmentsToText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  const out = []
  for (const seg of message) {
    const type = seg?.type
    const data = seg?.data ?? {}
    if (type === 'text') out.push(String(data.text ?? ''))
    else if (type === 'at') out.push('@' + (data.name || data.qq || ''))
    else if (type === 'face') out.push('[表情]')
    else if (type === 'image') {
      // 图片给个能取到的地址：只写「[图片]」的话，模型看不见也拿不到，等于把这一格吞了。
      const addr = String(data.url || data.file || '')
      out.push(addr ? '[图片 ' + addr + ']' : '[图片]')
    }
    else if (type === 'record') out.push('[语音]')
    else if (type === 'video') out.push('[视频]')
    else if (type === 'forward') out.push('[转发消息]')
    else if (type === 'reply') continue
    else if (type) out.push('[' + type + ']')
  }
  return out.join('')
}
