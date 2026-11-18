// 统一工具。几个 QQ 号共用这一套，靠 account 参数分开，不再每号镜像一份。
//
// 参数规则写在参数上，描述只讲行为；别在这里解释内部怎么连后端。

// QQ 单条正文的实际上限没那么宽。留在这个数以内，超了拆几条。
const MAX_TEXT = 3000

const TEXT_OUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }]
}

function pickAccount(hub, id) {
  const want = String(id || '').trim()
  if (!want) {
    if (hub.accounts.length === 1) return hub.accounts[0]
    throw new Error('有 ' + hub.accounts.length + ' 个账号，account 必须给：' + hub.accounts.map((a) => a.id).join(', '))
  }
  const hit = hub.accounts.find((a) => a.id === want)
  if (!hit) throw new Error('没有账号 ' + want + '。可用：' + hub.accounts.map((a) => a.id).join(', '))
  return hit
}

function targetKey(account, kind, target) {
  return account.id + '/' + kind + ':' + String(target)
}

/** OneBot 的 message 既收字符串也收段数组；这里统一成段，方便带 @ 和回复。 */
function buildMessage(text, { atUserId, replyToMessageId } = {}) {
  const segs = []
  const replyId = String(replyToMessageId ?? '').trim()
  if (replyId) segs.push({ type: 'reply', data: { id: replyId } })
  const at = String(atUserId ?? '').trim()
  if (at) segs.push({ type: 'at', data: { qq: at } })
  segs.push({ type: 'text', data: { text: String(text ?? '') } })
  return segs
}

/** 本地音频 → record 段。file:// 是 cqhttp 那一系的写法，SnowLuma 内部会自己转 silk。 */
function recordSegment(filePath) {
  const p = String(filePath).replace(/\\/g, '/')
  return { type: 'record', data: { file: p.startsWith('file://') ? p : 'file://' + p } }
}

/** 语音消息也要能带 @ 和引用，不然回话时句子和语音对不上。 */
function buildVoiceMessage(filePath, { atUserId, replyToMessageId } = {}) {
  const segs = []
  const replyId = String(replyToMessageId ?? '').trim()
  if (replyId) segs.push({ type: 'reply', data: { id: replyId } })
  const at = String(atUserId ?? '').trim()
  if (at) segs.push({ type: 'at', data: { qq: at } })
  segs.push(recordSegment(filePath))
  return segs
}

/** 表情包段。写法 "emojiId:packageId"；只给 summary 也认，那是碰运气。 */
function mfaceSegment(spec) {
  const s = String(spec ?? '').trim()
  const cut = s.indexOf(':')
  const emojiId = cut > 0 ? s.slice(0, cut) : s
  const packageId = cut > 0 ? s.slice(cut + 1) : ''
  const data = { summary: s, emoji_id: emojiId }
  if (packageId) data.emoji_package_id = packageId
  return { type: 'mface', data }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function registerTools({ register, hub, log }) {
  register({
    name: 'qq_status',
    description: [
      '看每个 QQ 账号现在连没连上、登录的是哪个号、消息路由到哪个会话。',
      '',
      '排查「消息没进来」或者「发不出去」时先看这个：它区分是后端连不上、没登录、还是账号没配会话。'
    ].join('\n'),
    parameters: {},
    output: TEXT_OUT,
    async execute() {
      const lines = []
      if (!hub.accounts.length) return '还没有配任何 QQ 账号。'
      for (const account of hub.accounts) {
        const c = account.client
        const probe = await c.probe()
        lines.push('账号 ' + account.id + '：' + (probe.ok ? '在线 ' + probe.nickname + '(' + probe.selfId + ')' : '掉线（' + probe.error + '）'))
        lines.push('  后端 ' + c.httpUrl + (c.wsUrl ? ' / ' + c.wsUrl : ' / 无 WS'))
        lines.push('  会话 ' + (account.session || '（未配，收到消息不投）'))
        lines.push('  主人 ' + (account.owner || '（未配，所有话都当外人）'))
        const allow = account.allow ?? {}
        const p = (allow.private ?? []).join(',') || '空'
        const g = (allow.groups ?? []).join(',') || '空'
        lines.push('  白名单 私聊 ' + p + '；群 ' + g)
        const d = account.lastDelivery
        if (d) {
          lines.push('  最近投递 ' + (d.ok ? '成功' : '失败：' + d.error) + '（' + d.at + (d.ms !== undefined ? '，' + d.ms + 'ms' : '') + '）')
        }
      }
      return lines.join('\n')
    }
  })

  register({
    name: 'qq_send',
    description: [
      '往一个 QQ 会话发一条或多条消息，多个账号共用这一个工具，用 account 选是谁的号在说。',
      '',
      '发多条时按 intervalMs 拉开间隔；真人不会一口气补完，需要连发才拆成多条，同一句话别拆开。',
      '群聊要人接话就带 atUserId，@ 了就是点名；只是接着聊不必 @。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名，见 qq_status。只有一个账号时可省略。' },
      kind: { type: 'string', required: true, description: 'private 或 group。' },
      target: { type: 'string', required: true, description: '私聊填对方 QQ 号，群聊填群号。' },
      messages: { type: 'string', description: '要发的话，一律按字符串传。发多条就传一个 JSON 数组字符串，例 ["第一句","第二句"]，会被拆成多条；单条直接给正文。别把一句完整的话拆成两条。' },
      atUserId: { type: 'string', description: '群聊里要 @ 的 QQ 号。只在不点名叫人接的时候省略。' },
      replyToMessageId: { type: 'string', description: '要引用回复的那条消息的 id。上下文唯一时不要引用。' },
      intervalMs: { type: 'number', description: '多条之间的间隔毫秒，默认按字数算，最少 800。' },
      face: { type: 'string', description: '要发的表情包，写“emojiId:packageId”，这两个值在别人发表情时带得出来。多条用 JSON 数组字符串。' },
      voice: { type: 'string', description: '要发的语音，给本机音频文件的绝对路径。mp3/wav 都行，后端会自己转成 QQ 的语音格式。多条用 JSON 数组字符串。给了它就发语音，文字和语音可以同时给。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const kind = String(args?.kind || '').trim()
      if (kind !== 'private' && kind !== 'group') throw new Error('kind 只能是 private 或 group')
      const target = String(args?.target || '').trim()
      if (!target) throw new Error('target 不能空')
      // messages 收三种写法，别让调用方猜：
      //   字符串 → 一条
      //   字符串数组 → 多条
      //   长得像 JSON 数组的字符串 → 先按 JSON 解，解不开就当一条正文发出去
      const raw = args?.messages
      let list
      if (Array.isArray(raw)) {
        list = raw
      } else if (typeof raw === 'string') {
        const trimmed = raw.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed)
            list = Array.isArray(parsed) ? parsed : [raw]
          } catch {
            list = [raw]
          }
        } else {
          list = [raw]
        }
      } else {
        list = [raw]
      }
      list = list.map((x) => String(x ?? '')).filter((x) => x.length > 0)
      // 语音：单条给路径，多条给 JSON 数组字符串。和文字可以同时给，先文字后语音。
      const voiceList = []
      const rawVoice = args?.voice
      if (rawVoice !== undefined && rawVoice !== null && String(rawVoice).trim()) {
        if (Array.isArray(rawVoice)) {
          for (const v of rawVoice) if (String(v ?? '').trim()) voiceList.push(String(v).trim())
        } else {
          const s = String(rawVoice).trim()
          if (s.startsWith('[') && s.endsWith(']')) {
            try {
              const parsed = JSON.parse(s)
              if (Array.isArray(parsed)) for (const v of parsed) if (String(v ?? '').trim()) voiceList.push(String(v).trim())
              else voiceList.push(s)
            } catch { voiceList.push(s) }
          } else {
            voiceList.push(s)
          }
        }
      }
      const faceList = []
      const rawFace = args?.face
      if (rawFace !== undefined && rawFace !== null && String(rawFace).trim()) {
        const s = String(rawFace).trim()
        if (s.startsWith('[') && s.endsWith(']')) {
          try {
            const parsed = JSON.parse(s)
            if (Array.isArray(parsed)) for (const v of parsed) if (String(v ?? '').trim()) faceList.push(String(v).trim())
            else faceList.push(s)
          } catch { faceList.push(s) }
        } else {
          faceList.push(s)
        }
      }
      if (!list.length && !voiceList.length && !faceList.length) throw new Error('messages、voice、face 都空着，没东西可发')
      // 后端对单条长度有上限，超了整条被拒。与其让它悄悄失败，不如在这里就拦下来说清楚。
      const tooLong = list.find((t) => t.length > MAX_TEXT)
      if (tooLong) {
        throw new Error('有一条 ' + tooLong.length + ' 字，超过上限 ' + MAX_TEXT + '，后端会拒。拆成几条发')
      }

      const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
      const idField = kind === 'group' ? 'group_id' : 'user_id'
      const gap = Math.max(800, Number(args?.intervalMs) || 0)
      const sent = []
      const failed = []
      for (let i = 0; i < list.length; i++) {
        const text = list[i]
        if (i > 0) await sleep(args?.intervalMs ? gap : Math.min(6000, 900 + text.length * 40))
        try {
          const data = await account.client.call(action, {
            [idField]: kind === 'group' ? Number(target) : Number(target),
            message: buildMessage(text, { atUserId: args?.atUserId, replyToMessageId: args?.replyToMessageId })
          })
          const mid = String(data?.message_id ?? '')
          sent.push({ text, messageId: mid })
          hub.store.pushSelf(targetKey(account, kind, target), text, '', mid)
        } catch (error) {
          failed.push({ text, error: error?.message ?? String(error) })
        }
      }
      // 语音排在文字后面发：先让人看见字，再听见声，跟人说话的顺序一样。
      const sentVoice = []
      const failedVoice = []
      for (let i = 0; i < voiceList.length; i++) {
        const file = voiceList[i]
        if (i > 0 || sent.length) await sleep(gap)
        try {
          const data = await account.client.call(action, {
            [idField]: Number(target),
            message: buildVoiceMessage(file, { atUserId: args?.atUserId, replyToMessageId: args?.replyToMessageId })
          })
          const mid = String(data?.message_id ?? '')
          sentVoice.push({ file, messageId: mid })
          hub.store.pushSelf(targetKey(account, kind, target), '[语音]', '', mid)
        } catch (error) {
          failedVoice.push({ file, error: error?.message ?? String(error) })
        }
      }

      // 表情包排在最后：它是收尾，不该抢在话前头。
      const sentFace = []
      const failedFace = []
      for (let i = 0; i < faceList.length; i++) {
        const spec = faceList[i]
        if (i > 0 || sent.length || sentVoice.length) await sleep(gap)
        try {
          const data = await account.client.call(action, {
            [idField]: Number(target),
            message: [mfaceSegment(spec)]
          })
          const mid = String(data?.message_id ?? '')
          sentFace.push({ spec, messageId: mid })
          hub.store.pushSelf(targetKey(account, kind, target), '[表情包 ' + spec + ']', '', mid)
        } catch (error) {
          failedFace.push({ spec, error: error?.message ?? String(error) })
        }
      }

      const lines = ['账号 ' + account.id + ' → ' + (kind === 'group' ? '群 ' : '私聊 ') + target]
      lines.push('发出去 ' + sent.length + ' 条' + (failed.length ? '，失败 ' + failed.length + ' 条' : ''))
      if (sentVoice.length || failedVoice.length) {
        lines.push('语音 ' + sentVoice.length + ' 条' + (failedVoice.length ? '，失败 ' + failedVoice.length + ' 条' : ''))
        for (const f of failedVoice) lines.push('  语音失败：' + f.error + ' | ' + f.file)
      }
      if (sentFace.length || failedFace.length) {
        lines.push('表情包 ' + sentFace.length + ' 条' + (failedFace.length ? '，失败 ' + failedFace.length + ' 条' : ''))
        for (const f of failedFace) lines.push('  表情失败：' + f.error + ' | ' + f.spec)
      }
      for (const f of failed) lines.push('  失败：' + f.error + ' | ' + f.text.slice(0, 40))
      return lines.join('\n')
    }
  })

  register({
    name: 'qq_read',
    description: [
      '读一个 QQ 会话的消息。默认只给没读过的，带 unreadOnly=false 时给最近的几条。',
      '',
      '看完要收尾就调 qq_mark_read 标到返回的 readThroughSeq，别用更大的数。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名。只有一个账号时可省略。' },
      kind: { type: 'string', required: true, description: 'private 或 group。' },
      target: { type: 'string', required: true, description: '私聊填对方 QQ 号，群聊填群号。' },
      unreadOnly: { type: 'boolean', description: '只给没读过的，默认 true。' },
      limit: { type: 'number', description: '最多几条，默认 20，上限 40。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const kind = String(args?.kind || '').trim()
      if (kind !== 'private' && kind !== 'group') throw new Error('kind 只能是 private 或 group')
      const target = String(args?.target || '').trim()
      const key = targetKey(account, kind, target)
      const unreadOnly = args?.unreadOnly !== false
      const limit = Math.max(1, Math.min(Number(args?.limit) || 20, 40))
      let rows
      let meta
      if (unreadOnly) {
        const u = hub.store.unread(key)
        rows = u.messages.slice(-limit)
        meta = '未读 ' + u.unreadCount + ' 条；readThroughSeq=' + u.readThroughSeq + '；seq=' + u.seq
      } else {
        rows = hub.store.recent(key, limit)
        const c = hub.store.get(key)
        meta = '最近 ' + rows.length + ' 条；readThroughSeq=' + (c?.readThroughSeq ?? 0) + '；seq=' + (c?.seq ?? 0)
      }
      if (!rows.length) return meta + '\n（这个会话没有消息）'
      const lines = [meta]
      for (const r of rows) {
        const mid = r.messageId ? '［id:' + r.messageId + '］' : ''
        lines.push('[' + (r.at || '') + '] ' + (r.isSelf ? '我' : (r.nickname || r.userId)) + mid + '：' + r.text)
      }
      return lines.join('\n')
    }
  })

  register({
    name: 'qq_mark_read',
    description: [
      '把一个 QQ 会话的已读水位推进到某个序号，水位置后就不再往前推。',
      '',
      'throughSeq 用 qq_read 返回的那个数，别自己编——编大了会把没看过的消息一起标掉。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名。只有一个账号时可省略。' },
      kind: { type: 'string', required: true, description: 'private 或 group。' },
      target: { type: 'string', required: true, description: '私聊填对方 QQ 号，群聊填群号。' },
      throughSeq: { type: 'number', required: true, description: '已经看到哪个序号，用 qq_read 返回的那个数。必须给——省略等于全标已读，那一步跨太大。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const kind = String(args?.kind || '').trim()
      if (kind !== 'private' && kind !== 'group') throw new Error('kind 只能是 private 或 group')
      const target = String(args?.target || '').trim()
      const key = targetKey(account, kind, target)
      const c = hub.store.ensure(key)
      // 省略 throughSeq 不许等于「全标已读」：一步跨太大，手滑就把没看过的全标掉。
      if (args?.throughSeq === undefined || args?.throughSeq === null || args?.throughSeq === '') {
        return '没动。throughSeq 必须给，用 qq_read 返回的那个数。现在 readThroughSeq=' + c.readThroughSeq + '；seq=' + c.seq
      }
      const r = hub.store.markRead(key, Number(args.throughSeq))
      return '标了 ' + r.changed + ' 条；readThroughSeq=' + r.readThroughSeq + '；seq=' + r.seq
    }
  })

  register({
    name: 'qq_profile',
    description: [
      '改一个 QQ 账号自己的昵称和个性签名。',
      '',
      '这是对外生效的改动，会立刻改到账号资料上；两个都没给就只查当前资料不改。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名。只有一个账号时可省略。' },
      nickname: { type: 'string', description: '新昵称。不给就不改。' },
      signature: { type: 'string', description: '新个性签名。不给就不改。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const nickname = String(args?.nickname ?? '').trim()
      const signature = String(args?.signature ?? '').trim()
      if (!nickname && !signature) {
        const info = await account.client.call('get_login_info')
        return '账号 ' + account.id + '：昵称 ' + (info?.nickname ?? '?') + '；号 ' + (info?.user_id ?? '?')
      }
      const params = {}
      if (nickname) params.nickname = nickname
      if (signature) params.personal_note = signature
      await account.client.call('set_qq_profile', params)
      const info = await account.client.call('get_login_info')
      return '改好了。现在昵称 ' + (info?.nickname ?? nickname) + (signature ? '，签名已设' : '')
    }
  })

  register({
    name: 'qq_poke',
    description: [
      '拍一拍某个 QQ 号。群里拍要指定拍谁，私聊就是拍对方。',
      '',
      '比发一句话轻，适合用来接一下、提醒一下，不必凑一句正文的时候。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名。只有一个账号时可省略。' },
      kind: { type: 'string', required: true, description: 'private 或 group。' },
      target: { type: 'string', required: true, description: '私聊填对方 QQ 号，群聊填群号。' },
      userId: { type: 'string', description: '群里要拍谁的 QQ 号。私聊可省略，默认拍对方。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const kind = String(args?.kind || '').trim()
      if (kind !== 'private' && kind !== 'group') throw new Error('kind 只能是 private 或 group')
      const target = String(args?.target || '').trim()
      if (!target) throw new Error('target 不能空')
      const who = String(args?.userId || (kind === 'private' ? target : '')).trim()
      if (!who) throw new Error('群里拍谁要给 userId')
      const params = kind === 'group'
        ? { user_id: Number(who), group_id: Number(target) }
        : { user_id: Number(who) }
      await account.client.call('send_poke', params)
      return '拍了 ' + who + ' 一下'
    }
  })

  register({
    name: 'qq_faces',
    description: [
      '列这个号收藏的 QQ 表情，拿到 id 就能用 qq_send 的 face 参数发出去。',
      '',
      '别人发表情时消息里会带 emojiId 和 packageId，那两个拼成 "emojiId:packageId" 也能直接喂给 face。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名，见 qq_status。只有一个账号时可省略。' },
      count: { type: 'number', description: '最多列几个，默认 30，上限 100。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const n = Math.max(1, Math.min(Number(args?.count) || 30, 100))
      const data = await account.client.call('fetch_custom_face', { count: n }, { timeout: 20000 })
      const ids = Array.isArray(data) ? data : Array.isArray(data?.faceIds) ? data.faceIds : []
      if (!ids.length) return '账号 ' + account.id + ' 没有收藏表情，或者后端没返回。'
      const lines = ['账号 ' + account.id + ' 收藏表情 ' + ids.length + ' 个：']
      for (const id of ids) lines.push('  ' + String(id))
      return lines.join('\n')
    }
  })

  register({
    name: 'qq_lookup',
    description: [
      '查一个 QQ 账号能看到的关系：自己加了哪些群、某个群的成员、好友列表。',
      '',
      '群里要 @ 谁、或者要确认对方是谁的时候用它拿号。'
    ].join('\n'),
    parameters: {
      account: { type: 'string', description: '账号别名。只有一个账号时可省略。' },
      what: { type: 'string', required: true, description: 'groups / members / friends。' },
      groupId: { type: 'string', description: 'what=members 时必填。' },
      limit: { type: 'number', description: '最多几条，默认 40。' }
    },
    output: TEXT_OUT,
    async execute(args) {
      const account = pickAccount(hub, args?.account)
      const what = String(args?.what || '').trim()
      const limit = Math.max(1, Math.min(Number(args?.limit) || 40, 200))
      if (what === 'groups') {
        const list = await account.client.call('get_group_list')
        const rows = (Array.isArray(list) ? list : []).slice(0, limit)
        if (!rows.length) return '这个号没在任何一个群里'
        return rows.map((g) => String(g.group_id) + '  ' + String(g.group_name ?? '')).join('\n')
      }
      if (what === 'members') {
        const gid = String(args?.groupId || '').trim()
        if (!gid) throw new Error('what=members 要给 groupId')
        const list = await account.client.call('get_group_member_list', { group_id: Number(gid) })
        const rows = (Array.isArray(list) ? list : []).slice(0, limit)
        if (!rows.length) return '查不到成员（可能没权限或者号不在这个群）'
        return rows.map((m) => String(m.user_id) + '  ' + String(m.card || m.nickname || '') + (m.role === 'owner' ? ' [群主]' : m.role === 'admin' ? ' [管理]' : '')).join('\n')
      }
      if (what === 'friends') {
        const list = await account.client.call('get_friend_list')
        const rows = (Array.isArray(list) ? list : []).slice(0, limit)
        if (!rows.length) return '好友列表是空的'
        return rows.map((f) => String(f.user_id) + '  ' + String(f.nickname ?? f.remark ?? '')).join('\n')
      }
      throw new Error('what 只能是 groups / members / friends')
    }
  })
}
