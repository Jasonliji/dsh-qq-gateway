// 收进来的 QQ 消息该进哪个会话，这里决定。
//
// ⚠ followup 必须收消息对象，不能塞字符串。塞字符串照样进 inbox，但 DSH 把原值写进
// agent/inbox/spliced，重启后读日志校验不过（SessionFormatError: requires message
// objects），整个会话都打不开。这是 dsh-selfwake 踩出来的，照抄。

import { randomUUID } from 'node:crypto'
import { segmentsToText, segmentsToMedia } from './onebot.js'
import { resolveIncoming, defaultMediaDir } from './media.js'

// 攒批：群里热闹时不能来一条投一条，那会让回合数等于消息条数，钱和吵都跟着涨。
// 有人说话就重置计时，安静够久才投一次；但一直热闹也得有个上限，否则永远投不出去。
const MERGE_MAX = 12
const DEFAULT_BATCH_QUIET_MS = 15000
const DEFAULT_CRITICAL_QUIET_MS = 1200
const DEFAULT_BATCH_MAX_WAIT_MS = 600000

// 两处期限，覆盖「入队 → ack」整条链，不只包住 followup：
// · FOLLOWUP_TIMEOUT_MS：等别人回合的上限。它不返回就判这条没投进去。
// · MAX_QUEUE_AGE_MS：从消息进队到真正投递的上限。前面的回合卡住时，后面排队的不能一直等
//   下去，等过期就丢——投一条五分钟前的消息比不投更糟。
// 这两个都别写死，Router 构造参能改，设置页也露出来了。量级照 <工作区> 那套的兜底定。
const FOLLOWUP_TIMEOUT_MS = 300000
const MAX_QUEUE_AGE_MS = 300000

function stripSessionPrefix(id) {
  return String(id || '').trim().replace(/^session-/, '')
}

function clockOf(ts) {
  const d = ts ? new Date(Number(ts) * 1000) : new Date()
  if (Number.isNaN(d.getTime())) return ''
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

/** 一个账号在配置里的白名单：空数组 = 谁都不理，别用「空就是全放」那种要命的默认。 */
function allowed(account, kind, target) {
  const allow = account.allow ?? {}
  if (kind === 'group') {
    const list = Array.isArray(allow.groups) ? allow.groups.map(String) : []
    return list.includes(String(target))
  }
  const list = Array.isArray(allow.private) ? allow.private.map(String) : []
  return list.includes(String(target))
}

/** 群里 @ 到自己的消息算要紧，别跟闲聊一样丢掉。 */
function mentionsSelf(ev, selfId) {
  const segs = ev?.message
  if (!Array.isArray(segs) || !selfId) return false
  return segs.some((s) => s?.type === 'at' && String(s?.data?.qq) === String(selfId))
}

/** @全体成员不点我名，但那是冲整群来的，跟闲聊不是一回事。 */
function mentionsAll(ev) {
  const segs = ev?.message
  if (!Array.isArray(segs)) return false
  return segs.some((s) => s?.type === 'at' && (s?.data?.qq === 'all' || String(s?.data?.qq) === '0'))
}

/**
 * 说话人是谁。上层要靠这个分开处置：主人说的和外人说的不是一回事。
 * owner 是配置里指明的那个号；其余一律 other，别自作聪明猜「好友就算自己人」。
 */
function identityOf(account, userId) {
  const owner = String(account.owner ?? '').trim()
  if (owner && String(userId) === owner) return 'owner'
  return 'other'
}

/** 这条消息引用了哪一条。引用你那条回你的，不 @ 也是冲你来。 */
function replyToId(ev) {
  const segs = ev?.message
  if (!Array.isArray(segs)) return ''
  const seg = segs.find((s) => s?.type === 'reply')
  return String(seg?.data?.id ?? '')
}

/** 私聊里点开群成员头像发的临时会话，对方多半不在好友列表，处置上要单独看。 */
function isTempSession(kind, ev) {
  return kind === 'private' && ev?.sub_type && ev.sub_type !== 'friend'
}

export class Router {
  constructor({ ctx, store, accounts, log, followupTimeoutMs, maxQueueAgeMs, label, batchQuietMs, criticalQuietMs, batchMaxWaitMs, groupWakeMode, groupWakeRandom, groupWakeProbability, contextMaxCount, contextMaxChars, wakeGuidance, systemNotice, mediaDir, mediaEnabled }) {
    this.ctx = ctx
    this.store = store
    this.accounts = accounts
    this.log = log ?? (() => {})
    // 等合并的槽 / 正在投的槽 / 投递时又积压下来的槽。同一个会话同一时刻只有一个在投，
    // 后面的排着，不许并发堆上去——并发堆起来就是「消息全堵在门口」的另一种样子。
    this.pending = new Map()
    this.inFlight = new Map()
    this.deferred = new Map()
    // 系统事件按账号节流：断线重连会反复触发，别把会话刷成日志。
    this.systemAt = new Map()
    this.systemThrottleMs = 60000
    // 断线、恢复默认不投。投了就是把会话叫醒一次，而收到的人除了「又断了」什么也做不了，
    // 偏偏重连还会再来一条「恢复了」。这两条纯噪音，只留在 gateway.log 里。
    this.systemNotice = systemNotice === true
    // 媒体那条路可以整条关掉：出问题时先关它，收消息这颗子不能跟着塌。
    this.mediaEnabled = mediaEnabled !== false
    this.mediaDir = String(mediaDir || '') || defaultMediaDir()
    // 没在跑的会话：唤醒成功过的 handle，和最近失败的时刻（冷却用，不然每批都撞一次同样的错）。
    this.resumedAgents = new Map()
    this.resumeFailedAt = new Map()
    this.resumeCooldownMs = 60000
    // 申请类按账号限流，防止有人拿好友申请刷屏。
    this.requestAt = new Map()
    this.label = String(label ?? '').trim()
    // 自测要把这些调小才跑得动；正常用默认值。
    this.followupTimeoutMs = Number(followupTimeoutMs) > 0 ? Number(followupTimeoutMs) : FOLLOWUP_TIMEOUT_MS
    this.maxQueueAgeMs = Number(maxQueueAgeMs) > 0 ? Number(maxQueueAgeMs) : MAX_QUEUE_AGE_MS
    // 群里静默多久才投；点名和私聊不等这么久，那是问话，慢了就答非所问。
    this.batchQuietMs = Number(batchQuietMs) > 0 ? Number(batchQuietMs) : DEFAULT_BATCH_QUIET_MS
    this.criticalQuietMs = Number(criticalQuietMs) > 0 ? Number(criticalQuietMs) : DEFAULT_CRITICAL_QUIET_MS
    this.batchMaxWaitMs = Number(batchMaxWaitMs) > 0 ? Number(batchMaxWaitMs) : DEFAULT_BATCH_MAX_WAIT_MS
    // 群里默认只在被叫的时候投。闲聊只记账，等被点名/被拍/被引用时一起带过去。
    // 设成 all 就恢复「来一条投一条」那种老行为。
    this.groupWakeMode = String(groupWakeMode ?? 'mention').trim() === 'all' ? 'all' : 'mention'
    // 没被点名时的唤醒概率。0 = 从不（默认），0.1 = 十个百分点。
    // 按条掷骰子，不按批：一批里攒了十条也只掷一次，免得热闹时概率被放大。
    this.groupWakeProbability = Number(groupWakeProbability) > 0 ? Math.min(1, Number(groupWakeProbability)) : 0
    // 概率唤醒的总闸。关掉就一条都不掷，群里只有被叫才醒——想彻底关掉这套的人不用去改概率。
    this.groupWakeRandom = groupWakeRandom !== false
    // 被叫起来时带多少前因：条数和字符都卡，超了丢老的。
    this.contextMaxCount = Number(contextMaxCount) > 0 ? Number(contextMaxCount) : 3
    this.contextMaxChars = Number(contextMaxChars) > 0 ? Number(contextMaxChars) : 6000
    // 醒来之后该怎么做事。由设定页填，拼在唤醒头的下面——模型第一眼就看见，
    // 不然「可以沉默」「接一句就好」这类话没人说给它听，它就会长篇回。
    this.wakeGuidance = String(wakeGuidance ?? '').trim()
  }

  /**
   * 一条消息的每一段都留一行：进来、投递、搁置、拦下、丢弃、失败。
   * 只记投递的话，验收看到零行分不清是「攒批生效了」还是「消息全丢了」——账对不上。
   */
  logEvent(account, kind, target, seq, what, extra) {
    try {
      this.log(what + ' ' + account.id + ' ' + kind + ':' + target + (seq ? ' 第' + seq + '条' : '') + (extra ? ' ' + extra : ''))
    } catch {}
  }

  /** 卸载时把还没投的定时器清掉。不清的话，插件卸载了它们还会醒过来朝旧 ctx 投。 */
  dispose() {
    for (const slot of this.pending.values()) {
      if (slot.timer) {
        try { clearTimeout(slot.timer) } catch {}
      }
    }
    this.pending.clear()
    this.deferred.clear()
    this.inFlight.clear()
    // 唤醒出来的会话不在这里关：那是持久化会话，关掉等于把主人开着的窗口也弄没了。
    this.resumedAgents.clear()
    this.resumeFailedAt.clear()
  }

  findAgent(sessionId) {
    const want = String(sessionId || '').trim()
    if (!want) return null
    const key = stripSessionPrefix(want)
    // agents.get 单查，别用 list 筛：list 只给当前活跃的那几间，开着的会话也筛不着。
    for (const candidate of [want, key, 'session-' + key]) {
      try {
        const a = this.ctx?.agents?.get?.(candidate)
        if (a && typeof a.followup === 'function') return a
      } catch {}
    }
    return null
  }

  /**
   * 会话不在了也得能叫醒——@ 到你却因为「那个窗口没开」而投不进去，等于没 @。
   * agents.get 只认活跃会话，没开的会话拿它捞不到，得走 resume 把持久化的会话读回来。
   * 成功一次就记着，后面直接复用；失败按分钟冷却，别每批都撞同一堵墙。
   */
  async resumeAgent(sessionId) {
    const want = String(sessionId || '').trim()
    if (!want) return null
    const key = stripSessionPrefix(want)
    const cached = this.resumedAgents.get(key)
    if (cached) {
      const agent = cached?.agent
      if (agent && typeof agent.followup === 'function') return agent
      this.resumedAgents.delete(key)
    }
    const svc = this.ctx?.agents
    if (typeof svc?.resume !== 'function') return null
    const lastFail = this.resumeFailedAt.get(key) ?? 0
    if (Date.now() - lastFail < this.resumeCooldownMs) return null
    try {
      const handle = await svc.resume({ resumeSessionId: want })
      const agent = handle?.agent
      if (agent && typeof agent.followup === 'function') {
        this.resumedAgents.set(key, handle)
        return agent
      }
      this.log('唤醒会话 ' + want + ' 回来但拿不到 followup，先不用它')
      this.resumeFailedAt.set(key, Date.now())
      return null
    } catch (error) {
      this.resumeFailedAt.set(key, Date.now())
      this.log('唤醒会话失败 ' + want + '：' + (error?.message ?? error))
      return null
    }
  }

  /** 好友申请和群邀请：不算聊天消息，但没人看就永远错过去。 */
  handleRequest(account, ev) {
    const isGroup = ev.request_type === 'group'
    const target = String(isGroup ? (ev.group_id ?? '') : (ev.user_id ?? ''))
    if (!target) return
    const kind = isGroup ? 'group' : 'private'
    const comment = String(ev.comment ?? ev.flag ?? '').trim()
    const text = isGroup
      ? '群邀请：有人想让你进群 ' + target + (comment ? '，附言：' + comment : '')
      : '好友申请：' + target + (comment ? '，附言：' + comment : '')
    const key = account.id + '/' + kind + ':' + target
    const row = this.store.push(key, {
      messageId: 'req-' + target + '-' + String(ev.time ?? ''),
      userId: target,
      nickname: '',
      text,
      at: clockOf(ev.time),
      isSelf: false,
      identity: identityOf(account, String(ev.user_id ?? '')),
      note: 'request'
    })
    if (!row) return
    // 申请类不走白名单：陌生人本来就在名单外，不投就等于永远看不到。
    // 但也不能谁都能拿它敲门：同账号一分钟内最多投三条，多的只记账不吵。
    const now = Date.now()
    const bucket = this.requestAt.get(account.id) ?? { windowStart: 0, count: 0 }
    if (now - bucket.windowStart > 60000) {
      bucket.windowStart = now
      bucket.count = 0
    }
    bucket.count += 1
    this.requestAt.set(account.id, bucket)
    if (bucket.count > 3) {
      this.log('账号 ' + account.id + ' 一分钟内的申请超过三条，这条只记账不投')
      return
    }
    this.queue(account, kind, target, key, true)
  }

  /** 通知事件。拍一拍就是在叫你，别当没看见。 */
  handleNotice(account, ev) {
    if (ev?.notice_type !== 'notify' || ev?.sub_type !== 'poke') return
    const selfId = String(ev?.self_id ?? account.client?.selfId ?? '')
    if (!selfId || String(ev.target_id) !== selfId) return
    const kind = ev.group_id ? 'group' : 'private'
    const target = String(ev.group_id || ev.user_id || '')
    if (!target) return
    // 拍一拍也走白名单：不然随便谁都能拿它敲门。
    if (!allowed(account, kind, target)) return
    const userId = String(ev.user_id ?? '')
    const key = account.id + '/' + kind + ':' + target
    const row = this.store.push(key, {
      messageId: 'poke-' + userId + '-' + String(ev.time ?? ''),
      userId,
      nickname: '',
      text: '拍了拍你',
      at: clockOf(ev.time),
      isSelf: false,
      identity: identityOf(account, userId),
      note: '拍一拍'
    })
    if (!row) return
    this.queue(account, kind, target, key, true)
  }

  /**
   * 系统自己的事件：断线、连不上。没人发这条，但卡住了得有人知道，
   * 否则会话那边一直以为风平浪静。
   *
   * 走同一道排队，不直接 followup：直投会跟普通消息并着进同一个会话，
   * 而那条会话的回合可能正在跑。系统事件不着急，排一下反而稳。
   * 按账号节流，重连不刷屏。
   */
  handleSystem(account, text) {
    if (!this.systemNotice) return
    const now = Date.now()
    const last = this.systemAt.get(account.id) ?? 0
    if (now - last < this.systemThrottleMs) return
    this.systemAt.set(account.id, now)
    if (!account.session) return

    const key = account.id + '/system'
    const row = this.store.push(key, {
      messageId: 'sys-' + now,
      userId: 'system',
      nickname: '系统',
      text,
      at: clockOf(),
      isSelf: false,
      identity: 'system',
      note: ''
    })
    if (row) this.queue(account, 'private', account.id, key, true)
  }

  /** OneBot 事件进来。message_sent（自己发的）只记账，不唤醒。 */
  handleEvent(account, ev) {
    try {
      if (ev?.post_type === 'request') {
        this.handleRequest(account, ev)
        return
      }
      if (ev?.post_type === 'notice') {
        this.handleNotice(account, ev)
        return
      }
      if (ev?.post_type === 'meta_event') return

      // 事件自带 self_id，先用它：WS 连上后消息可能比 probe 先到，
      // 那会儿 client.selfId 还是 0，@ 我的消息会被当成闲聊吞掉。
      const selfId = String(ev.self_id ?? account.client?.selfId ?? '')
      const userId = String(ev.user_id ?? '')
      const isSelf = ev.post_type === 'message_sent' || (selfId && userId === selfId)
      const kind = ev.message_type === 'group' ? 'group' : 'private'
      // 自己发出去的私聊：user_id 是发送方，也就是自己；对方在 target_id。
      // 拿 user_id 当收件人，这条会记到自己名下。
      const target = kind === 'group'
        ? String(ev.group_id ?? '')
        : (isSelf ? String(ev.target_id ?? userId) : userId)
      if (!target) return

      const text = segmentsToText(ev.message ?? ev.raw_message ?? '')
      const key = account.id + '/' + kind + ':' + target

      if (isSelf) {
        // messageId 必须带：不带的话自己那条的 id 是空串，别人引用它时永远匹配不上，
        // 于是「引用我那条」判成闲聊，群里直接被丢掉。
        this.store.pushSelf(key, text, clockOf(ev.time), ev.message_id)
        return
      }

      if (!allowed(account, kind, target)) {
        // 白名单外的不吵，但要记账：不然验收时零投递，分不清是拦住了还是丢了。
        this.logEvent(account, kind, target, 0, '拦下', '原因=白名单外')
        return
      }

      const sender = ev.sender ?? {}
      const notes = []
      if (isTempSession(kind, ev)) notes.push('临时会话，对方可能不在好友列表')
      if (kind === 'group' && mentionsAll(ev)) notes.push('@全体成员')

      // 引用你那条回你的：就算没 @，也是冲你说的。
      const quoted = replyToId(ev)
      let quotesSelf = false
      if (quoted) {
        const mine = this.store.recent(key, 40).find((r) => r.isSelf && r.messageId && r.messageId === quoted)
        if (mine) {
          quotesSelf = true
          notes.push('引用了我那条')
        } else {
          notes.push('引用回复')
        }
      }

      const row = this.store.push(key, {
        messageId: ev.message_id,
        userId,
        nickname: String(sender.card || sender.nickname || ''),
        text,
        at: clockOf(ev.time),
        isSelf: false,
        identity: identityOf(account, userId),
        note: notes.join('；'),
        // 图、语音、转发、表情包先记着原始段，等真要投的时候再下载——
        // 群里九成消息不会被投，提前下载就是白烧流量。
        media: segmentsToMedia(ev.message ?? ev.raw_message ?? '')
      })
      if (!row) return

      // 私聊会等着回话，@我、@全体、引用我那条也都是冲我来的；拍一拍同见 handleNotice。
      const critical = kind === 'private' || mentionsSelf(ev, selfId) || mentionsAll(ev) || quotesSelf

      // 群里平时不投：闲聊只记账，等被叫的时候连前因一起带过去。
      // 这一条能吃掉八成噪音——群热闹时回合数不再跟消息条数走。
      if (kind === 'group' && !critical && this.groupWakeMode === 'mention') {
        // 总闸关着就一条都不掷：这是「只认被叫」那档，连计入攒批都不进。
        if (!this.groupWakeRandom) {
          this.logEvent(account, kind, target, row.seq, '搁置', '原因=概率唤醒已关，只记账')
          return
        }
        // 概率唤醒：没被点名也偶尔醒一次。醒来看见什么说什么，也可以只是看一眼——那由人格定。
        // 掷不中就还是只记账，攒着等真被叫时一起带过去。
        if (!(this.groupWakeProbability > 0 && Math.random() < this.groupWakeProbability)) {
          this.logEvent(account, kind, target, row.seq, '搁置', '原因=群里没点名，只记账')
          return
        }
        this.logEvent(account, kind, target, row.seq, '唤起', '原因=概率唤醒')
      }

      this.queue(account, kind, target, key, critical)
    } catch (error) {
      this.log('处理事件出错：' + (error?.message ?? error))
    }
  }

  /**
   * 攒批。来一条就重置计时，安静够久才投一次：
   *   群里热闹时，十条消息也只起一个回合，不是十个；
   *   一直有人说话也不会饿死，到了最长等待照投。
   * 点名、私聊这类问话不等，用短的静默窗口快投。
   */
  queue(account, kind, target, key, critical) {
    let slot = this.pending.get(key)
    if (!slot) {
      slot = {
        key,
        account,
        kind,
        target,
        timer: null,
        firstAt: Date.now(),
        enqueuedAt: Date.now(),
        critical: false
      }
      this.pending.set(key, slot)
    }
    // 一个槽里只要有一条要紧的，整槽都不能按过期丢掉。
    if (critical) slot.critical = true
    slot.enqueuedAt = Date.now()

    // 重置静默计时。不等满就直接返回的那种写法会让第一批永远等不到人。
    if (slot.timer) clearTimeout(slot.timer)
    const waited = Date.now() - slot.firstAt
    const quiet = slot.critical ? this.criticalQuietMs : this.batchQuietMs
    const wait = Math.max(0, Math.min(quiet, this.batchMaxWaitMs - waited))
    slot.timer = setTimeout(() => {
      this.pending.delete(key)
      slot.flushRequestedAt = Date.now()
      this.flush(slot).catch((error) => this.log('投递失败：' + (error?.message ?? error)))
    }, wait)
    if (typeof slot.timer.unref === 'function') slot.timer.unref()
  }

  composeText(account, kind, target, rows, overlapNote = '', mediaBySeq = null) {
    const selfName = account.client?.nickname || account.id
    // 系统事件只报状态，不给「回话」那行：这类消息不该拿 qq_send 去回。
    if (rows.every((r) => r.identity === 'system')) {
      return '【系统】' + selfName + '（账号 ' + account.id + '）\n' + rows.map((r) => r.text).join('\n')
    }
    const where = kind === 'group' ? '群聊 ' + target : '私聊'
    const lines = []
    const head = '【' + where + '】' + selfName + '（账号 ' + account.id + '）'
    // 批次号用「这批消息的序号范围」：同一批重复投时号必然一样，
    // 一眼就认得出「这条我刚答过」，不会当成新话再回一遍。超时不推水位会重复。
    const first = rows[0]?.seq ?? 0
    const last = rows[rows.length - 1]?.seq ?? 0
    const batch = first && last ? '［批 ' + first + '-' + last + overlapNote + '］' : ''
    lines.push((this.label ? '[' + this.label + '] ' : '') + batch + head)
    lines.push('回话：qq_send(account="' + account.id + '", kind="' + kind + '", target="' + target + '")')
    if (this.wakeGuidance) lines.push('准则：' + this.wakeGuidance)
    for (const row of rows) {
      const who = row.nickname ? row.nickname + '(' + row.userId + ')' : row.userId
      // 身份写在这里，上层才分得开：主人说的、自己说的、外人说的是三套处置。
      // 自己说的那些是当上下文带过来的，标成［外人］会让人以为别人替自己说了话。
      const tag = row.identity === 'owner' ? '［主人］' : row.identity === 'self' ? '［自己说的］' : '［外人］'
      const note = row.note ? '（' + row.note + '）' : ''
      // 每行都得带消息 id，不然 replyToMessageId 就是个够不着的参数，引用回复整条链是哑的。
      const mid = row.messageId ? '［id:' + row.messageId + '］' : ''
      // 媒体那条说明接在这条消息自己下面，不另起一段：谁发的图，得跟谁的话绑在一起看。
      const extra = mediaBySeq?.get(row.seq)
      const body = extra ? row.text + '\n    ' + extra : row.text
      lines.push((row.at ? '[' + row.at + '] ' : '') + who + tag + mid + note + '：' + body)
    }
    return lines.join('\n')
  }

  /**
   * 投一次。整条链都有期限：
   *   同会话前一条还在投 → 这条先压着，不并发堆上去；
   *   从进队到现在超过 maxQueueAgeMs → 直接丢，不投隔了太久的旧消息；
   *   followup 本身再套一层超时，它不返回也要收尾。
   */
  async flush(slot) {
    const { key, account, kind, target } = slot

    // 前一条还在投：留着，等那边 finally 再投，别并发。
    if (this.inFlight.has(key)) {
      this.deferred.set(key, slot)
      return
    }

    // 从「决定要投」算起，不是从最后一条到达算起：
    // 每次入队都重置时间的话，这个年龄永远是几毫秒，过期那道闸成了摆设。
    const anchor = slot.flushRequestedAt ?? slot.enqueuedAt ?? Date.now()
    const age = Date.now() - anchor
    if (age > this.maxQueueAgeMs) {
      if (!slot.critical) {
        account.lastDelivery = {
          ok: false,
          at: new Date().toISOString(),
          error: '在队里等了 ' + Math.round(age / 1000) + ' 秒还没轮到，过期丢弃'
        }
        this.logEvent(account, kind, target, 0, '丢弃', '原因=排队 ' + Math.round(age / 1000) + ' 秒没轮到')
        return
      }
      // 私聊和 @ 到自己的不外抛：晚到比不投强，投了才有人回。
      this.log('账号 ' + account.id + ' 有要紧消息等了 ' + Math.round(age / 1000) + ' 秒，照投不丢')
    }

    // 要投的是「自上次投递以来攒下的全部」，不只是触发这次唤醒的那一条：
    // 群里没被叫的那些闲聊就存在这儿，被点名时一起带过去当上下文。
    const rows = this.store.pendingAll(key, {
      maxCount: this.contextMaxCount,
      maxChars: this.contextMaxChars
    })
    if (!rows.length) return

    const sessionId = account.session
    if (!sessionId) {
      this.logEvent(account, kind, target, 0, '搁置', '原因=没配 session')
      return
    }
    // 先看活跃的；会话没开着就把它读回来再投——不然 @ 到了也只是一行「拿不到 agent」。
    let agent = this.findAgent(sessionId)
    if (!agent) {
      agent = await this.resumeAgent(sessionId)
      if (agent) {
        this.logEvent(account, kind, target, 0, '唤醒会话', '原因=会话没在跑，拉起来再投')
      } else {
        this.logEvent(account, kind, target, 0, '搁置', '原因=会话 ' + sessionId + ' 拿不到 agent')
        return
      }
    }

    // 上次试着投过的范围：本次如果盖住它，头里标出来，模型才知道哪几行不用重答。
    const firstSeq = rows[0]?.seq ?? 0
    const lastSeq = rows[rows.length - 1]?.seq ?? 0
    const attempt = this.store.getAttempt(key)
    let overlapNote = ''
    if (attempt && firstSeq && firstSeq <= attempt.last) {
      const lo = Math.max(firstSeq, attempt.first)
      const hi = Math.min(lastSeq, attempt.last)
      if (lo <= hi) overlapNote = '，其中 ' + lo + '-' + hi + ' 上次可能已投'
    }

    // 媒体到这一步才落地：前面只记原始段，真要投了才去下载、转码、展开。
    // 群里九成消息不会被投，提前下载全是白烧。
    const mediaBySeq = new Map()
    const imageParts = []
    if (this.mediaEnabled) {
      for (const row of rows) {
        if (!Array.isArray(row.media) || !row.media.length) continue
        try {
          const got = await resolveIncoming(account, this.ctx, { media: row.media, log: this.log, dir: this.mediaDir })
          if (got.parts.length) imageParts.push(...got.parts)
          if (got.lines.length) mediaBySeq.set(row.seq, got.lines.join('\n    '))
        } catch (error) {
          // 媒体坏了不能拖垮投递：这条消息本身还是要送到，降级成一句说明。
          mediaBySeq.set(row.seq, '[媒体没处理成：' + (error?.message ?? error) + ']')
          this.log('媒体处理失败：' + (error?.message ?? error))
        }
      }
    }

    const message = {
      id: randomUUID(),
      role: 'user',
      content: [
        { type: 'text', text: this.composeText(account, kind, target, rows, overlapNote, mediaBySeq) },
        ...imageParts
      ],
      source: { kind: 'qq-gateway', account: account.id }
    }

    this.inFlight.set(key, Date.now())
    const started = Date.now()
    try {
      await Promise.race([
        agent.followup(message),
        new Promise((_, reject) => {
          const t = setTimeout(
            () => reject(new Error('followup 超时：' + Math.round(this.followupTimeoutMs / 1000) + ' 秒没返回')),
            this.followupTimeoutMs
          )
          if (typeof t.unref === 'function') t.unref()
        })
      ])
      // 推两个水位，但都只推到「这次真投出去的那几条」：
      //   lastWakeSeq —— 唤醒水位，下次别重复带；
      //   readThroughSeq —— 已读水位，不然模型收到推送后再 qq_read，还是同一批，
      //   看着像没处理过。投递期间新来的（seq 更大）不动。
      const lastSent = rows[rows.length - 1].seq
      this.store.markWaked(key, lastSent)
      this.store.markRead(key, lastSent)
      this.store.clearAttempt(key)
      account.lastDelivery = { ok: true, at: new Date().toISOString(), ms: Date.now() - started }
      // 每次真投都留一行：验收时要数「调了几次」，看会话里有没有消息是数不准的——
      // 消息可能只是最后一轮带进来的。十几条闲聊该是零行，点我一次才一行。
      this.logEvent(account, kind, target, 0, '投递', '批' + firstSeq + '-' + lastSeq + ' 共 ' + rows.length + ' 条')
    } catch (error) {
      const reason = error?.message ?? String(error)
      account.lastDelivery = { ok: false, at: new Date().toISOString(), ms: Date.now() - started, error: reason }
      this.logEvent(account, kind, target, 0, '失败', '批' + firstSeq + '-' + lastSeq + ' 原因=' + reason)
      // 超时**不推水位**，原来推过，结果是把后面排队的那批一起标成已投，直接吞掉。
      // 代价是下次可能重复带同一批——重复回答烦，但比丢消息轻。
      // 所以记一笔「这次试到哪」，下次重投时在头里标出重叠段。
      try { this.store.markAttempt(key, firstSeq, lastSeq) } catch {}
      // 不往外抛：这一条失败了，后面压着的还得接着投。
    } finally {
      this.inFlight.delete(key)
      const next = this.deferred.get(key)
      if (next) {
        this.deferred.delete(key)
        this.flush(next).catch((error) => this.log('补投失败：' + (error?.message ?? error)))
      }
    }
  }
}
