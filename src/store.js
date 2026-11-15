// 每个「账号 + 会话」的状态：消息序号、回话令牌、已读水位、最近几条、去重。
//
// 只存派生数据，不是真相。真相在 QQ 那边和 DSH 的会话日志里；这里坏了顶多丢一次回话
// 令牌，重建即可。

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

const RECENT_MAX = 200
const SEEN_MAX = 400
const UNREAD_MAX = 500

export class Store {
  /** @param {string} file 落盘路径 */
  constructor(file, { log } = {}) {
    this.file = file
    this.log = log ?? (() => {})
    this.data = { version: 1, conversations: {} }
    this.dirty = false
    this.saveTimer = null
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.file)) return
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object') {
        this.data = { version: 1, conversations: {}, ...raw }
        if (!this.data.conversations || typeof this.data.conversations !== 'object') {
          this.data.conversations = {}
        }
      }
    } catch (error) {
      this.log('状态文件读不动，从空开始：' + (error?.message ?? error))
    }
  }

  /**
   * 攒一下再写。群里热闹时每秒可能来几十条，一条一写会把磁盘磨穿，
   * 而这份状态是派生的，丢了顶多重记一次，等一下子完全不亏。
   */
  save() {
    this.dirty = true
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flushNow()
    }, 800)
    if (typeof this.saveTimer.unref === 'function') this.saveTimer.unref()
  }

  /** 真写盘。卸载、退出前必须调一次，否则最后那批改动留在内存里。 */
  flushNow() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (!this.dirty) return
    this.dirty = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      this.log('状态写不进去：' + (error?.message ?? error))
    }
  }

  /** 会话键：private:<号> / group:<群号>。加账号前缀避免两个号同群时串。 */
  static key(account, kind, target) {
    return account + '/' + kind + ':' + String(target)
  }

  ensure(key) {
    const map = this.data.conversations
    if (!map[key]) {
      // 不再生成 agentToken：工具在宿主进程里跑，没有要走外部令牌的入口，留着只是让状态文件白涨。
      map[key] = {
        seq: 0,
        readThroughSeq: 0,
        // 已经投递（唤醒）到哪一条。和 readThroughSeq 不是一回事：
        // 那个是「模型看过了」，这个是「已经推给会话了」。
        lastWakeSeq: 0,
        recent: [],
        pending: [],
        seen: []
      }
    }
    const c = map[key]
    // 老状态文件里可能还带着 agentToken，读进来时直接抹掉。
    if ('agentToken' in c) delete c.agentToken
    if (typeof c.seq !== 'number') c.seq = 0
    if (typeof c.readThroughSeq !== 'number') c.readThroughSeq = 0
    if (typeof c.lastWakeSeq !== 'number') {
      // 老状态文件没有这个字段。当成「现有的都已经投过」：
      // 归零的话，一升级就把 recent 里几十条全当新消息推一遍。
      c.lastWakeSeq = typeof c.seq === 'number' ? c.seq : 0
    }
    if (!Array.isArray(c.recent)) c.recent = []
    if (!Array.isArray(c.pending)) c.pending = []
    if (!Array.isArray(c.seen)) c.seen = []
    return c
  }

  get(key) {
    return this.data.conversations[key]
  }

  /** 记住一条进来的消息。返回 null 表示重复，别往会话里投第二遍。 */
  push(key, msg) {
    const c = this.ensure(key)
    const id = String(msg.messageId ?? '')
    if (id && c.seen.includes(id)) return null
    c.seq += 1
    const row = {
      seq: c.seq,
      messageId: id,
      userId: String(msg.userId ?? ''),
      nickname: String(msg.nickname ?? ''),
      text: String(msg.text ?? ''),
      at: String(msg.at ?? ''),
      isSelf: !!msg.isSelf,
      // 说话人是谁这件事得带到上层去：主人说的和外人说的处置不一样。
      identity: String(msg.identity ?? ''),
      note: String(msg.note ?? ''),
      media: Array.isArray(msg.media) ? msg.media : []
    }
    c.recent.push(row)
    if (c.recent.length > RECENT_MAX) c.recent = c.recent.slice(-RECENT_MAX)
    // 未读单独存一份，不从 recent 里筛：积压一多，recent 一滚动，前头的就无声没了。
    c.pending.push(row)
    if (c.pending.length > UNREAD_MAX) c.pending = c.pending.slice(-UNREAD_MAX)
    if (id) {
      c.seen.push(id)
      if (c.seen.length > SEEN_MAX) c.seen = c.seen.slice(-SEEN_MAX)
    }
    this.save()
    return row
  }

  /** 记下自己发出去的，模型下次读上下文能看见自己说过什么。留 id 是为了认出别人引用的是哪条。 */
  pushSelf(key, text, at, messageId) {
    const c = this.ensure(key)
    c.seq += 1
    c.recent.push({
      seq: c.seq,
      messageId: String(messageId ?? ''),
      userId: 'self',
      nickname: '我',
      text: String(text ?? ''),
      at: String(at ?? ''),
      isSelf: true,
      identity: 'self',
      note: '',
      media: []
    })
    if (c.recent.length > RECENT_MAX) c.recent = c.recent.slice(-RECENT_MAX)
    this.save()
    return c.seq
  }

  /** 已读水位只准往前，不许被旧请求拽回去。 */
  markRead(key, throughSeq) {
    const c = this.ensure(key)
    const want = Math.max(0, Math.min(Number(throughSeq) || 0, c.seq))
    if (want <= c.readThroughSeq) {
      return { changed: 0, readThroughSeq: c.readThroughSeq, seq: c.seq }
    }
    const before = c.readThroughSeq
    c.readThroughSeq = want
    c.pending = c.pending.filter((m) => m.seq > want)
    this.save()
    return { changed: want - before, readThroughSeq: c.readThroughSeq, seq: c.seq }
  }

  /**
   * 从上次投递到现在攒下的消息，包括自己说的——被叫起来时要看得到前因。
   *
   * 必须双卡：条数和字符都要有上限。群里热闹一天没人点我，晚上一次把几百条全投进去，
   * 那一下比每条都投还贵。超了丢老的、留最近的——接着聊靠的是近处那几句。
   */
  pendingAll(key, { maxCount = 3, maxChars = 6000 } = {}) {
    const c = this.get(key)
    if (!c) return []
    // 老状态文件里没有这个字段，这儿也补一手：pendingAll 走的是 get，不过 ensure。
    if (typeof c.lastWakeSeq !== 'number') c.lastWakeSeq = typeof c.seq === 'number' ? c.seq : 0
    const since = Number(c.lastWakeSeq) || 0
    const all = c.recent.filter((m) => m.seq > since)
    if (!all.length) return []

    const out = []
    let chars = 0
    for (let i = all.length - 1; i >= 0; i -= 1) {
      if (out.length >= maxCount) break
      const len = String(all[i].text ?? '').length
      // 至少带一条：全空或者第一条就超预算时不能什么都不给。
      if (out.length > 0 && chars + len > maxChars) break
      out.unshift(all[i])
      chars += len
    }
    return out
  }

  /**
   * 上一次「试着投了但不确定投成没成」的范围。超时的时候记一笔，
   * 重投时用它标出哪几行是上次已经带过的——重复投的范围往往比上次大，
   * 光看批次号相等判不出来，得看谁盖住谁。
   */
  markAttempt(key, first, last) {
    const c = this.ensure(key)
    c.lastAttempt = { first: Number(first) || 0, last: Number(last) || 0 }
    this.save()
  }

  getAttempt(key) {
    const c = this.get(key)
    return c?.lastAttempt && typeof c.lastAttempt.last === 'number' ? c.lastAttempt : null
  }

  clearAttempt(key) {
    const c = this.get(key)
    if (!c || !c.lastAttempt) return
    delete c.lastAttempt
    this.save()
  }

  /** 记下已经投到哪一条。只往前，不往回退。 */
  markWaked(key, throughSeq) {
    const c = this.ensure(key)
    const want = Number(throughSeq) || 0
    if (want > (c.lastWakeSeq || 0)) {
      c.lastWakeSeq = want
      this.save()
    }
    return c.lastWakeSeq
  }

  recent(key, limit = 20) {
    const c = this.get(key)
    if (!c) return []
    const n = Math.max(1, Math.min(Number(limit) || 20, RECENT_MAX))
    return c.recent.slice(-n)
  }

  unread(key) {
    const c = this.get(key)
    if (!c) return { unreadCount: 0, seq: 0, readThroughSeq: 0, messages: [] }
    const rest = c.pending.filter((m) => !m.isSelf && m.seq > c.readThroughSeq)
    return { unreadCount: rest.length, seq: c.seq, readThroughSeq: c.readThroughSeq, messages: rest }
  }

}
