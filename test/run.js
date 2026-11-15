// 虚拟环境里的自测：真的 Store、真的 Router、真的 OneBotClient，只把 DSH 和 QQ 两头换成假的。
// 跑法：node test/run.js
// 不写 DSH 的 profile，不连任何真后端。

import { mkdtempSync, rmSync, readFileSync as readFileSyncSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OneBotClient, segmentsToText } from '../src/onebot.js'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { registerTools } from '../src/tools.js'
import { createHub, parseAccounts, statePath, logPath, createFileLogger } from '../src/hub.js'
import { startMockOneBot } from './mock-onebot.js'

let pass = 0
let fail = 0
const failures = []

function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok  ' + name) }
  else { fail += 1; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

function makeTools() {
  const defs = new Map()
  const register = (d) => { defs.set(d.name, d); return () => { defs.delete(d.name) } }
  return { register, defs }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'qqgw-'))
  const stateFile = join(tmp, 'state.json')
  const backend = await startMockOneBot({ uin: 3000000001, nickname: '测试号' })
  const sinks = []

  const client = new OneBotClient({
    id: 'test',
    httpUrl: backend.url,
    onEvent: (ev) => { sinks.push(ev) }
  })

  const account = {
    id: 'test',
    session: 'session-abc',
    owner: '111111',
    allow: { private: ['111111', '333333'], groups: ['555000111'] },
    client
  }
  const accounts = [account]
  const store = new Store(stateFile, {})
  const log = () => {}

  // 假的 agents：只认一个会话，把投进来的消息收着。
  const inbox = []
  const fakeAgent = { followup: async (msg) => { inbox.push(msg) } }
  const ctx = {
    agents: {
      get: (id) => (String(id).replace(/^session-/, '') === 'abc' ? fakeAgent : undefined)
    }
  }

  const router = new Router({ ctx, store, accounts, log, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all', batchMaxWaitMs: 60000 })
  const hub = { accounts, store, router }
  const { register, defs } = makeTools()
  registerTools({ register, hub, log: () => {} })

  console.log('\n[1] 协议与工具面')
  {
    const r = await client.probe()
    check('探活拿到登录号', r.ok && r.selfId === 3000000001, JSON.stringify(r))
    check('六个工具都挂上了', ['qq_status', 'qq_send', 'qq_read', 'qq_mark_read', 'qq_profile', 'qq_lookup'].every((n) => defs.has(n)), [...defs.keys()].join(','))
    check('段转文字认表情和@', segmentsToText([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: {} },
      { type: 'at', data: { name: '甲' } }
    ]) === '看这个[图片]@甲')
  }

  console.log('\n[2] 私聊进会话')
  {
    router.handleEvent(account, backend.privateEvent('你好'))
    await new Promise((r) => setTimeout(r, 1700))
    check('投了一条', inbox.length === 1, 'inbox=' + inbox.length)
    const msg = inbox[0]
    check('是消息对象不是字符串', msg && typeof msg === 'object' && Array.isArray(msg.content), typeof msg)
    check('带 id 和 role=user', !!msg?.id && msg?.role === 'user')
    check('source 标明来源', msg?.source?.kind === 'qq-gateway' && msg?.source?.account === 'test', JSON.stringify(msg?.source))
    const text = msg?.content?.[0]?.text ?? ''
    check('唤醒头带账号与回话参数', text.includes('账号 test') && text.includes('qq_send(account=\"test\"'), text.slice(0, 80))
    check('正文在里面', text.includes('你好'))
  }

  console.log('\n[3] 去重与合并')
  {
    inbox.length = 0
    const ev = backend.privateEvent('重复的一条', { messageId: 'dup-1' })
    router.handleEvent(account, ev)
    router.handleEvent(account, ev)
    await new Promise((r) => setTimeout(r, 1700))
    const joined = inbox.map((m) => m.content?.[0]?.text).join('')
    check('同一条只投一次', (joined.match(/重复的一条/g) || []).length === 1, '出现 ' + (joined.match(/重复的一条/g) || []).length + ' 次')
  }
  {
    inbox.length = 0
    router.handleEvent(account, backend.privateEvent('第一句', { messageId: 'mg-1' }))
    router.handleEvent(account, backend.privateEvent('第二句', { messageId: 'mg-2' }))
    await new Promise((r) => setTimeout(r, 1700))
    check('两条并成一次唤醒', inbox.length === 1, 'inbox=' + inbox.length)
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('两句都在同一条里', t.includes('第一句') && t.includes('第二句'), t.slice(0, 120))
  }

  console.log('\n[4] 白名单')
  {
    inbox.length = 0
    router.handleEvent(account, backend.privateEvent('陌生人', { userId: 999999, nickname: '路人', messageId: 'x-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    check('白名单外的私聊不投也不记', inbox.length === 0 && store.unread('test/private:999999').unreadCount === 0)
    router.handleEvent(account, backend.groupEvent('群里的', { groupId: 777888999, messageId: 'x-2' }))
    await new Promise((r) => setTimeout(r, 1700))
    check('白名单外的群也一样', inbox.length === 0)
  }

  console.log('\n[5] 群聊与 @')
  {
    inbox.length = 0
    router.handleEvent(account, backend.groupEvent('问一句', { messageId: 'grp-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('群消息投进去了', inbox.length === 1)
    check('唤醒头写明群号', t.includes('群聊 555000111'), t.slice(0, 60))
    check('回话参数带 kind=group', t.includes('kind=\"group\"'))
  }

  console.log('\n[6] 发送与引用')
  {
    backend.calls.length = 0
    const out = await defs.get('qq_send').execute({ kind: 'private', target: '111111', messages: '回一句' })
    const call = backend.calls.find((c) => c.action === 'send_private_msg')
    check('真的发了 send_private_msg', !!call, JSON.stringify(backend.calls.map((c) => c.action)))
    check('收件人对', String(call?.params?.user_id) === '111111')
    check('正文是段数组', Array.isArray(call?.params?.message) && call.params.message.some((s) => s.type === 'text' && s.data.text === '回一句'))
    check('返回里报了成功', out.includes('发出去 1 条'), out)
  }
  {
    backend.calls.length = 0
    await defs.get('qq_send').execute({ kind: 'group', target: '555000111', messages: '点名', atUserId: '222222', replyToMessageId: '12345' })
    const call = backend.calls.find((c) => c.action === 'send_group_msg')
    const types = (call?.params?.message ?? []).map((s) => s.type)
    check('群发送带 reply 和 at', types.includes('reply') && types.includes('at'), types.join(','))
    check('@ 的是那个号', (call?.params?.message ?? []).find((s) => s.type === 'at')?.data?.qq === '222222')
  }

  console.log('\n[7] 已读水位')
  {
    const key = 'test/private:111111'
    // 投递会把已读水位推走，这里先造一条新的未读再测
    store.push(key, { messageId: 'rd-1', userId: '111111', text: '刚到的', at: '12:00' })
    const u1 = store.unread(key)
    check('有未读', u1.unreadCount >= 1, 'unread=' + u1.unreadCount)
    const r1 = store.markRead(key, u1.readThroughSeq + 1)
    check('水位能往前', r1.changed > 0)
    const r2 = store.markRead(key, 0)
    check('水位不会被拽回去', r2.changed === 0 && r2.readThroughSeq === r1.readThroughSeq, JSON.stringify(r2))
    const big = store.markRead(key, 99999)
    check('水位不超过 seq', big.readThroughSeq === store.get(key).seq, JSON.stringify(big))
  }

  console.log('\n[8] 资料与查询')
  {
    await defs.get('qq_profile').execute({ nickname: '新昵称', signature: '新签名' })
    check('昵称改到后端了', backend.profile.nickname === '新昵称', backend.profile.nickname)
    check('签名改到后端了', backend.profile.personal_note === '新签名')
    const groups = await defs.get('qq_lookup').execute({ what: 'groups' })
    check('群列表读得到', groups.includes('555000111'), groups)
    const members = await defs.get('qq_lookup').execute({ what: 'members', groupId: '555000111' })
    check('群成员读得到', members.includes('222222'))
  }

  console.log('\n[9] 会话拿不到时不硬投')
  {
    inbox.length = 0
    const other = { ...account, id: 'test2', session: 'session-zzz' }
    router.handleEvent(other, backend.privateEvent('没这个会话', { messageId: 'nk-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    check('会话不存在就不投', inbox.length === 0)
    const other2 = { ...account, id: 'test3', session: '' }
    router.handleEvent(other2, backend.privateEvent('没配会话', { messageId: 'nk-2' }))
    await new Promise((r) => setTimeout(r, 1700))
    check('没配会话也不投', inbox.length === 0)
  }

  console.log('\n[10] 状态工具')
  {
    const out = await defs.get('qq_status').execute({})
    check('状态里报在线号', out.includes('在线') && out.includes('3000000001'), out.slice(0, 120))
    check('状态里报会话', out.includes('session-abc'))
  }

  console.log('\n[11] followup 不返回时不拖死')
  {
    const hangAgent = { followup: () => new Promise(() => {}) }
    const ctx2 = { agents: { get: () => hangAgent } }
    const router2 = new Router({ ctx: ctx2, store, accounts, log: () => {}, followupTimeoutMs: 300, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all' })
    const acc2 = { id: 'slow', session: 'session-abc', allow: { private: ['111111'], groups: [] }, client }
    router2.handleEvent(acc2, backend.privateEvent('这条不会回', { messageId: 'slow-1' }))
    await new Promise((r) => setTimeout(r, 2600))
    check('超时后记成失败', acc2.lastDelivery && acc2.lastDelivery.ok === false, JSON.stringify(acc2.lastDelivery))
    check('失败原因写清了', String(acc2.lastDelivery?.error ?? '').includes('超时'), String(acc2.lastDelivery?.error ?? ''))
  }

  console.log('\n[12] 同会话不并发，排队久了就丢')
  {
    let concurrent = 0
    let maxConcurrent = 0
    const slowAgent = {
      followup: async () => {
        concurrent += 1
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await new Promise((r) => setTimeout(r, 2000))
        concurrent -= 1
      }
    }
    const ctx3 = { agents: { get: () => slowAgent } }
    const router3 = new Router({ ctx: ctx3, store, accounts, log: () => {}, followupTimeoutMs: 8000, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all' })
    const acc3 = { id: 'serial', session: 'session-abc', allow: { private: ['111111'], groups: [] }, client }
    router3.handleEvent(acc3, backend.privateEvent('一', { messageId: 's-1' }))
    await new Promise((r) => setTimeout(r, 1600))
    router3.handleEvent(acc3, backend.privateEvent('二', { messageId: 's-2' }))
    await new Promise((r) => setTimeout(r, 4200))
    check('同一会话没并发投递', maxConcurrent === 1, 'maxConcurrent=' + maxConcurrent)
    check('第二条最后还是投了', concurrent === 0 && maxConcurrent === 1)
  }
  {
    let delivered = 0
    const countingAgent = { followup: async () => { delivered += 1 } }
    const ctx4 = { agents: { get: () => countingAgent } }
    const router4 = new Router({ ctx: ctx4, store, accounts, log: () => {}, followupTimeoutMs: 5000, maxQueueAgeMs: 100, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all' })
    const acc4 = { id: 'stale', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }

    // 私聊：有人专门来找你，丢了这一条对方当你已读不回，所以过期也照投。
    router4.handleEvent(acc4, backend.privateEvent('过期的一条', { messageId: 'st-1' }))
    await new Promise((r) => setTimeout(r, 2200))
    check('私聊过期也照投', delivered === 1, 'delivered=' + delivered)

    // 群聊闲聊：丢了没什么，别把旧话翻出来。
    delivered = 0
    router4.handleEvent(acc4, backend.groupEvent('群里的一句闲聊', { messageId: 'st-2' }))
    await new Promise((r) => setTimeout(r, 2200))
    // 没有阻塞的时候不该丢：过期那道闸拦的是「排队排太久」，不是「来了就丢」。
    check('没阻塞时群聊也照投', delivered >= 1, 'delivered=' + delivered)
  }

  console.log('\n[13] 身份与三类通道')
  {
    inbox.length = 0
    router.handleEvent(account, backend.privateEvent('主人说的话', { userId: 111111, nickname: '甲', messageId: 'id-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t1 = inbox[0]?.content?.[0]?.text ?? ''
    check('主人私聊标［主人］', t1.includes('［主人］'), t1.slice(0, 100))

    inbox.length = 0
    router.handleEvent(account, backend.privateEvent('外人的话', { userId: 333333, nickname: '丙', messageId: 'id-2' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t2 = inbox[0]?.content?.[0]?.text ?? ''
    check('外人私聊标［外人］', t2.includes('［外人］') && !t2.includes('［主人］'), t2.slice(0, 100))
  }
  {
    inbox.length = 0
    const atAll = backend.groupEvent('全体注意', { messageId: 'all-1' })
    atAll.message = [{ type: 'at', data: { qq: 'all' } }, { type: 'text', data: { text: '全体注意' } }]
    router.handleEvent(account, atAll)
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('@全体标出备注', t.includes('@全体成员'), t.slice(0, 120))
  }
  {
    inbox.length = 0
    const temp = backend.privateEvent('点开我头像找我', { userId: 333333, nickname: '丙', messageId: 'tmp-1' })
    temp.sub_type = 'other'
    router.handleEvent(account, temp)
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('临时会话标出备注', t.includes('临时会话'), t.slice(0, 120))
  }
  {
    inbox.length = 0
    router.handleEvent(account, {
      post_type: 'request', request_type: 'friend', user_id: 444444,
      comment: '想加个好友', time: Math.floor(Date.now() / 1000)
    })
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('好友申请也投', inbox.length === 1 && t.includes('好友申请'), t.slice(0, 120))
    check('申请类不走白名单', t.includes('444444'), t.slice(0, 120))
  }

  console.log('\n[14] 拍一拍、引用、系统事件')
  {
    inbox.length = 0
    router.handleEvent(account, {
      post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
      user_id: 111111, target_id: 3000000001, group_id: 555000111,
      time: Math.floor(Date.now() / 1000)
    })
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('被拍会投', inbox.length === 1 && t.includes('拍了拍你'), t.slice(0, 120))
    check('拍一拍标出来源', t.includes('拍一拍'), t.slice(0, 120))
  }
  {
    inbox.length = 0
    await defs.get('qq_send').execute({ kind: 'group', target: '555000111', messages: '我说的那句' })
    const mine = store.recent('test/group:555000111', 10).filter((r) => r.isSelf).pop()
    check('自己发的那条带 id', !!mine && !!mine.messageId, String(mine?.messageId))
    const ev = backend.groupEvent('回你刚才那句', { messageId: 'q-1' })
    ev.message = [{ type: 'reply', data: { id: String(mine.messageId) } }, { type: 'text', data: { text: '回你刚才那句' } }]
    router.handleEvent(account, ev)
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('引用我那条会标出来', t.includes('引用了我那条'), t.slice(0, 140))
  }
  {
    inbox.length = 0
    router.handleSystem(account, '断线了，正在重连')
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('系统事件也能投', inbox.length === 1, 'inbox=' + inbox.length)
    check('系统事件标【系统】', t.includes('【系统】') && t.includes('断线了'), t.slice(0, 120))
  }

  console.log('\n[15] 复审那几条对上了')
  {
    inbox.length = 0
    router.handleEvent(account, backend.privateEvent('带id的一条', { userId: 111111, messageId: 'idchk-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('唤醒头行带 id', t.includes('［id:'), t.slice(0, 160))
    const readOut = await defs.get('qq_read').execute({ kind: 'private', target: '111111', unreadOnly: false, limit: 5 })
    check('qq_read 也带 id', readOut.includes('［id:'), readOut.slice(0, 160))
  }
  {
    const s = segmentsToText([{ type: 'image', data: { url: 'https://example.invalid/a.png' } }])
    check('图片带出地址', s === '[图片 https://example.invalid/a.png]', s)
  }
  {
    let threw = ''
    try { await defs.get('qq_send').execute({ kind: 'private', target: '111111', messages: 'x'.repeat(3001) }) }
    catch (e) { threw = e?.message ?? String(e) }
    check('超长被拦下并说清原因', threw.includes('超过上限'), threw)
  }
  {
    backend.calls.length = 0
    await defs.get('qq_poke').execute({ kind: 'group', target: '555000111', userId: '222222' })
    const call = backend.calls.find((c) => c.action === 'send_poke')
    check('拍一拍会调后端', !!call, JSON.stringify(backend.calls.map((c) => c.action)))
    check('拍的是那个号', String(call?.params?.user_id) === '222222')
    check('群里带上群号', String(call?.params?.group_id) === '555000111')
  }
  {
    const k2 = 'test/private:111111'
    for (let i = 0; i < 60; i++) {
      router.handleEvent(account, backend.privateEvent('堆一条 ' + i, { userId: 111111, messageId: 'bulk-' + i }))
    }
    const u2 = store.unread(k2)
    check('积压 60 条不会只留 40', u2.unreadCount >= 60, 'unread=' + u2.unreadCount)
    store.markRead(k2, u2.seq)
    check('标完就没未读', store.unread(k2).unreadCount === 0)
    await new Promise((r) => setTimeout(r, 1700))
  }

  console.log('\n[16] messages 三种写法')
  {
    backend.calls.length = 0
    await defs.get('qq_send').execute({ kind: 'private', target: '111111', messages: ['一', '二'], intervalMs: 800 })
    let n = backend.calls.filter((c) => c.action === 'send_private_msg').length
    check('数组发两条就是两条', n === 2, 'n=' + n)

    backend.calls.length = 0
    await defs.get('qq_send').execute({ kind: 'private', target: '111111', messages: '["甲","乙"]', intervalMs: 800 })
    n = backend.calls.filter((c) => c.action === 'send_private_msg').length
    check('JSON 字符串数组也拆开', n === 2, 'n=' + n)
    const texts = backend.calls.filter((c) => c.action === 'send_private_msg')
      .map((c) => (c.params.message ?? []).filter((s) => s.type === 'text').map((s) => s.data.text).join(''))
    check('拆出来的正文对', texts.includes('甲') && texts.includes('乙'), JSON.stringify(texts))

    backend.calls.length = 0
    await defs.get('qq_send').execute({ kind: 'private', target: '111111', messages: '[这不是 JSON]' })
    n = backend.calls.filter((c) => c.action === 'send_private_msg').length
    check('解不开就整条当正文', n === 1, 'n=' + n)
  }

  console.log('\n[17] 装配层（装上真正会跑的那段）')
  {
    const logs = []
    const parsed = parseAccounts([
      { id: 'ok1', httpUrl: 'http://127.0.0.1:1', wsUrl: 'ws://127.0.0.1:2', session: 'session-abc', owner: '111111', allow: { private: ['111111'] } },
      { httpUrl: 'http://127.0.0.1:9' },
      { id: '坏 名字', httpUrl: 'http://127.0.0.1:3' },
      { id: 'noh', httpUrl: '' },
      { id: 'ok1', httpUrl: 'http://127.0.0.1:4' }
    ], (m) => logs.push(m))
    check('只留下填对的那一项', parsed.length === 1 && parsed[0].id === 'ok1', JSON.stringify(parsed.map((a) => a.id)))
    check('四项被挡下并说了原因', logs.length === 4, JSON.stringify(logs))
    check('白名单与主人带进来', parsed[0].owner === '111111' && parsed[0].allow.private[0] === '111111')
  }
  {
    check('状态路径默认落在 DSH 家目录', statePath('').replace(/\\/g, '/').endsWith('.dsh/qq-gateway/state.json'), statePath(''))
    check('给了路径就用给的', statePath('X:/a/b.json') === 'X:/a/b.json')
  }
  {
    const toolDefs = new Map()
    const fakeCtx = {
      tools: { register: (d) => { toolDefs.set(d.name, d); return () => { toolDefs.delete(d.name) } } },
      agents: { get: () => undefined },
      logger: { info: () => {} }
    }
    const built = createHub(fakeCtx, {
      accounts: [{ id: 'asm', httpUrl: backend.url, session: 'session-abc', allow: { private: ['111111'], groups: [] } }],
      stateFile: join(tmp, 'asm-state.json'),
      probeIntervalSec: 0
    }, () => {})
    check('装上后工具都在', ['qq_status', 'qq_send', 'qq_read', 'qq_mark_read', 'qq_profile', 'qq_lookup', 'qq_poke'].every((n) => toolDefs.has(n)), [...toolDefs.keys()].join(','))
    check('账号被装配出来', built.accounts.length === 1 && !!built.accounts[0].client)
    built.start()
    await new Promise((r) => setTimeout(r, 400))
    const st = await toolDefs.get('qq_status').execute({})
    check('装配后能问到状态', st.includes('asm'), st.slice(0, 100))
    built.dispose()
    check('收尾把工具摘干净', toolDefs.size === 0, '剩 ' + toolDefs.size)
  }

  console.log('\n[18] 标记能分辨来源')
  {
    const lab = new Router({ ctx, store, accounts, log: () => {}, label: '新', batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all' })
    inbox.length = 0
    lab.handleEvent(account, backend.privateEvent('带标记的', { messageId: 'lab-1' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('配了标记就挂在头前', t.startsWith('[新] ') && t.includes('【私聊】'), t.slice(0, 50))
    const plain = new Router({ ctx, store, accounts, log: () => {}, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all' })
    inbox.length = 0
    plain.handleEvent(account, backend.privateEvent('不带的', { messageId: 'lab-2' }))
    await new Promise((r) => setTimeout(r, 1700))
    const t2 = inbox[0]?.content?.[0]?.text ?? ''
    check('没配标记就不挂', !t2.startsWith('[新]') && t2.includes('【私聊】'), t2.slice(0, 50))
  }

  console.log('\n[19] 攒批：热闹时只起一个回合')
  {
    const slow = new Router({ ctx, store, accounts, log: () => {}, batchQuietMs: 1500, criticalQuietMs: 1500, groupWakeMode: 'all', batchMaxWaitMs: 60000 })
    inbox.length = 0
    slow.handleEvent(account, backend.groupEvent('一句', { messageId: 'b1' }))
    await new Promise((r) => setTimeout(r, 900))
    slow.handleEvent(account, backend.groupEvent('两句', { messageId: 'b2' }))
    await new Promise((r) => setTimeout(r, 900))
    check('有人接着说就不投', inbox.length === 0, 'inbox=' + inbox.length)
    await new Promise((r) => setTimeout(r, 1300))
    check('安静够了才投一次', inbox.length === 1, 'inbox=' + inbox.length)
    const t = inbox[0]?.content?.[0]?.text ?? ''
    check('两条合在同一条里', t.includes('一句') && t.includes('两句'), t.slice(0, 120))
  }
  {
    // 一直有人说话：到了最长等待也必须投，不能永远攒着
    const capped = new Router({ ctx, store, accounts, log: () => {}, batchQuietMs: 5000, criticalQuietMs: 5000, groupWakeMode: 'all', batchMaxWaitMs: 2000 })
    inbox.length = 0
    for (let i = 0; i < 5; i++) {
      capped.handleEvent(account, backend.groupEvent('连着说 ' + i, { messageId: 'cap-' + i }))
      await new Promise((r) => setTimeout(r, 600))
    }
    check('攒到上限会先投出去', inbox.length >= 1, 'inbox=' + inbox.length)
  }

  console.log('\n[20] 群里平时不投，被叫才投')
  {
    // 用自己的一份收件箱：别的 router 的定时器还在跑，共用会被串味。
    const box = []
    const ownAgent = { followup: async (msg) => { box.push(msg) } }
    const ownCtx = { agents: { get: () => ownAgent } }
    // 连状态也独立：别的 router 的延迟 flush 会把共享那份的投递水位推过去，
    // 一推，这儿的闲聊就被当成「已经投过了」，上下文测试永远过不了。
    const ownStore = new Store(join(tmp, 'store20.json'), {})
    const quiet = new Router({ ctx: ownCtx, store: ownStore, accounts, log: () => {}, batchQuietMs: 1200, criticalQuietMs: 1200, groupWakeMode: 'mention' })

    quiet.handleEvent(account, backend.groupEvent('闲聊一', { messageId: 'q1' }))
    await new Promise((r) => setTimeout(r, 600))
    quiet.handleEvent(account, backend.groupEvent('闲聊二', { messageId: 'q2' }))
    await new Promise((r) => setTimeout(r, 600))
    quiet.handleEvent(account, backend.groupEvent('闲聊三', { messageId: 'q3' }))
    await new Promise((r) => setTimeout(r, 1600))
    check('闲聊一条都不投', box.length === 0, 'box=' + box.length)

    const atEv = backend.groupEvent('点你名', { messageId: 'q4' })
    atEv.message = [{ type: 'at', data: { qq: '3000000001' } }, { type: 'text', data: { text: '点你名' } }]
    quiet.handleEvent(account, atEv)
    await new Promise((r) => setTimeout(r, 1600))
    check('被点名才投', box.length === 1, 'box=' + box.length)
    const t = box[0]?.content?.[0]?.text ?? ''
    check('闲聊被当上下文一起带上', t.includes('闲聊二') && t.includes('闲聊三'), t.slice(0, 200))
    check('点名那条也在里面', t.includes('点你名'), t.slice(0, 200))
    // 默认只带最近三条：四条前因时最早那条要被挤掉，不然「攒着的上限」等于没设
    check('超出三条的老前因被挤掉', !t.includes('闲聊一'), t.slice(0, 200))
  }

  console.log('\n[21] 攒太多时只带近处那几条')
  {
    const ownStore = new Store(join(tmp, 'store21.json'), {})
    ownStore.ensure('k')
    for (let i = 0; i < 30; i++) {
      ownStore.push('k', { messageId: 'z' + i, userId: '111111', text: '第' + i + '条', at: '12:00' })
    }
    const rows = ownStore.pendingAll('k')
    check('默认最多三条', rows.length === 3, 'rows=' + rows.length)
    check('留的是最近那几条', rows[rows.length - 1].text === '第29条', rows[rows.length - 1].text)
    check('老的被丢掉了', !rows.some((r) => r.text === '第0条'))

    const few = ownStore.pendingAll('k', { maxCount: 5, maxChars: 100000 })
    check('条数上限生效', few.length === 5, 'few=' + few.length)

    const tight = ownStore.pendingAll('k', { maxCount: 20, maxChars: 20 })
    check('字符上限也生效', tight.length <= 20 && tight.length >= 1, 'tight=' + tight.length)
    check('字符卡住时还是带了最新那条', tight[tight.length - 1].text === '第29条')
  }

  console.log('\n[22] 自审修的那几处')
  {
    // self_id 来自事件本身：probe 还没跑完时，@ 我的消息不能被当成闲聊
    const box = []
    const ownAgent = { followup: async (msg) => { box.push(msg) } }
    const ownStore = new Store(join(tmp, 'store22.json'), {})
    const ownCtx = { agents: { get: () => ownAgent } }
    const blind = new Router({ ctx: ownCtx, store: ownStore, accounts, log: () => {}, batchQuietMs: 1200, criticalQuietMs: 1200, groupWakeMode: 'mention' })
    // 一个从没 probe 过的客户端：selfId 还是 0，模拟「消息比探测先到」
    const rawClient = new OneBotClient({ id: 'raw', httpUrl: backend.url })
    const fresh = { id: 'fresh', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client: rawClient }
    check('这个客户端还没探到 selfId', !rawClient.selfId, String(rawClient.selfId))
    const atEv = backend.groupEvent('点你名', { messageId: 's1' })
    atEv.message = [{ type: 'at', data: { qq: '3000000001' } }, { type: 'text', data: { text: '点你名' } }]
    blind.handleEvent(fresh, atEv)
    await new Promise((r) => setTimeout(r, 1500))
    check('靠事件里的 self_id 也认得出是点我', box.length === 1, 'box=' + box.length)
  }
  {
    // 两个账号填同一个后端要被拦下
    const logs = []
    const parsed = parseAccounts([
      { id: 'a', httpUrl: 'http://127.0.0.1:3010' },
      { id: 'b', httpUrl: 'http://127.0.0.1:3010/' }
    ], (m) => logs.push(m))
    check('同一个后端不能挂两个别名', parsed.length === 1 && parsed[0].id === 'a', JSON.stringify(parsed.map((x) => x.id)))
    check('拦下时说了原因', logs.some((m) => m.includes('同一个')), JSON.stringify(logs))
  }
  {
    // 卸载前要落盘：攒着不写的话，最后那批改动会丢
    const f2 = join(tmp, 'store23.json')
    const s2 = new Store(f2, {})
    s2.push('k', { messageId: 'x1', userId: '1', text: '要留下的', at: '12:00' })
    // 此刻还在攒着，文件应该还没写
    const { existsSync } = await import('node:fs')
    check('攒着时还没落盘', !existsSync(f2))
    s2.flushNow()
    check('flushNow 之后落盘了', existsSync(f2))
    const back = JSON.parse(readFileSyncSync(f2, 'utf8'))
    check('内容写对了', !!back.conversations.k, Object.keys(back.conversations).join(','))
  }
  {
    // dispose 要把排队的定时器清掉，不能让它们朝拆掉的 ctx 投
    const box = []
    const ownAgent = { followup: async (msg) => { box.push(msg) } }
    const ownStore = new Store(join(tmp, 'store24.json'), {})
    const r5 = new Router({ ctx: { agents: { get: () => ownAgent } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 1200, criticalQuietMs: 1200, groupWakeMode: 'all' })
    r5.handleEvent(account, backend.groupEvent('卸载前排队的', { messageId: 'd1' }))
    r5.dispose()
    await new Promise((r) => setTimeout(r, 1600))
    check('卸载后不再投', box.length === 0, 'box=' + box.length)
  }

  console.log('\n[23] 超时与刷屏')
  {
    // 投递超时也推进水位：不推的话下次被叫会把同一批再带一遍
    const box = []
    const hangAgent = { followup: () => new Promise(() => {}) }
    const ownStore = new Store(join(tmp, 'store25.json'), {})
    const r6 = new Router({ ctx: { agents: { get: () => hangAgent } }, store: ownStore, accounts, log: () => {}, followupTimeoutMs: 300, batchQuietMs: 800, criticalQuietMs: 800, groupWakeMode: 'all' })
    const acc6 = { id: 't6', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r6.handleEvent(acc6, backend.groupEvent('会超时的一条', { messageId: 'to1' }))
    await new Promise((r) => setTimeout(r, 2200))
    const key6 = 't6/group:555000111'
    check('超时记成失败', acc6.lastDelivery && acc6.lastDelivery.ok === false, JSON.stringify(acc6.lastDelivery?.error ?? ''))
    check('超时不推水位（推了会吞掉排队那批）', ownStore.get(key6).lastWakeSeq < ownStore.get(key6).seq, 'lastWake=' + ownStore.get(key6).lastWakeSeq + ' seq=' + ownStore.get(key6).seq)
    check('消息还留着，下次会再带', ownStore.pendingAll(key6).length > 0, 'left=' + ownStore.pendingAll(key6).length)
  }
  {
    // 好友申请刷屏：一分钟最多三条
    const box = []
    const ownAgent = { followup: async (m) => { box.push(m) } }
    const ownStore = new Store(join(tmp, 'store26.json'), {})
    const r7 = new Router({ ctx: { agents: { get: () => ownAgent } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 800, criticalQuietMs: 800, groupWakeMode: 'all' })
    const acc7 = { id: 't7', session: 'session-abc', allow: { private: [], groups: [] }, client }
    for (let i = 0; i < 6; i++) {
      r7.handleEvent(acc7, { post_type: 'request', request_type: 'friend', user_id: 500000 + i, comment: '加一下', time: Math.floor(Date.now() / 1000) + i })
    }
    await new Promise((r) => setTimeout(r, 1200))
    check('申请刷屏被限住', box.length <= 3, 'box=' + box.length)
    check('限住的还是记了账', ownStore.get('t7/private:500005') !== undefined)
  }

  console.log('\n[24] 她挖的那四条')
  {
    // 自己发的私聊记到对方名下，不是记到自己名下
    const ownStore = new Store(join(tmp, 'store27.json'), {})
    const r8 = new Router({ ctx: { agents: { get: () => ownAgent } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 800, criticalQuietMs: 800, groupWakeMode: 'all' })
    const acc8 = { id: 't8', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r8.handleEvent(acc8, {
      post_type: 'message_sent', message_type: 'private', sub_type: 'friend',
      message_id: 777001, user_id: 3000000001, target_id: 111111, self_id: 3000000001,
      message: [{ type: 'text', data: { text: '我主动发的' } }], time: Math.floor(Date.now() / 1000)
    })
    check('记在对方名下', ownStore.get('t8/private:111111') !== undefined, Object.keys(ownStore.data.conversations).join(','))
    check('没记到自己名下', ownStore.get('t8/private:3000000001') === undefined)
    const mine = ownStore.recent('t8/private:111111', 5).find((m) => m.isSelf)
    check('自己发那条也带 messageId', !!mine && String(mine.messageId) === '777001', String(mine?.messageId))
  }
  {
    // 引用我那条：现在能认出来了
    const ownStore = new Store(join(tmp, 'store28.json'), {})
    const box = []
    const ownAgent2 = { followup: async (m) => { box.push(m) } }
    const r9 = new Router({ ctx: { agents: { get: () => ownAgent2 } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 800, criticalQuietMs: 800, groupWakeMode: 'mention' })
    const acc9 = { id: 't9', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r9.handleEvent(acc9, {
      post_type: 'message_sent', message_type: 'group', group_id: 555000111,
      message_id: 888001, user_id: 3000000001, self_id: 3000000001,
      message: [{ type: 'text', data: { text: '我说的话' } }], time: Math.floor(Date.now() / 1000)
    })
    const replyEv = backend.groupEvent('回你那条', { messageId: 'rq1' })
    replyEv.message = [{ type: 'reply', data: { id: '888001' } }, { type: 'text', data: { text: '回你那条' } }]
    r9.handleEvent(acc9, replyEv)
    await new Promise((r) => setTimeout(r, 1200))
    check('引用我那条会被投出来（不再当闲聊丢）', box.length === 1, 'box=' + box.length)
    const t = box[0]?.content?.[0]?.text ?? ''
    check('标出了引用我那条', t.includes('引用了我那条'), t.slice(0, 160))
  }
  {
    // 过期那道闸真的能触发：在队里等到超时
    let delivered = 0
    const slowAgent = { followup: async () => { delivered += 1 } }
    // 用一个卡住的 agent 让第一条占住 inFlight，第二条排队等，等到超过 maxQueueAge
    let releaseFirst
    const gate = new Promise((r) => { releaseFirst = r })
    const holdAgent = { followup: async () => { await gate } }
    const ownStore = new Store(join(tmp, 'store29.json'), {})
    const r10 = new Router({ ctx: { agents: { get: () => holdAgent } }, store: ownStore, accounts, log: () => {}, followupTimeoutMs: 8000, maxQueueAgeMs: 300, batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'all' })
    const acc10 = { id: 't10', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r10.handleEvent(acc10, backend.groupEvent('第一条占住', { messageId: 'g1' }))
    await new Promise((r) => setTimeout(r, 700))
    r10.handleEvent(acc10, backend.groupEvent('第二条排队', { messageId: 'g2' }))
    await new Promise((r) => setTimeout(r, 1100))
    releaseFirst()
    await new Promise((r) => setTimeout(r, 600))
    const err = String(acc10.lastDelivery?.error ?? '')
    check('排队排太久时群聊被丢了', err.includes('过期'), err.slice(0, 80))

    // 同样排队的私聊不能丢：那是有人专门来找你，丢了对方当你已读不回
    const box2 = []
    const holdAgent2 = { followup: async () => { await new Promise(() => {}) } }
    const ownStore2 = new Store(join(tmp, 'store30.json'), {})
    const r11 = new Router({ ctx: { agents: { get: () => holdAgent2 } }, store: ownStore2, accounts, log: () => {}, followupTimeoutMs: 800, maxQueueAgeMs: 300, batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'all' })
    const acc11 = { id: 't11', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r11.handleEvent(acc11, backend.privateEvent('先占住', { messageId: 'p1' }))
    await new Promise((r) => setTimeout(r, 700))
    r11.handleEvent(acc11, backend.privateEvent('后排队的私聊', { messageId: 'p2' }))
    await new Promise((r) => setTimeout(r, 1500))
    check('排队的私聊不会被过期丢掉', ownStore2.pendingAll('t11/private:111111').length > 0, 'left=' + ownStore2.pendingAll('t11/private:111111').length)
  }
  {
    // 两个号配同一个会话要拦
    const logs = []
    const parsed = parseAccounts([
      { id: 'x', httpUrl: 'http://127.0.0.1:3101', session: 'session-abc' },
      { id: 'y', httpUrl: 'http://127.0.0.1:3102', session: 'abc' }
    ], (m) => logs.push(m))
    check('同会话两个号被拦下', parsed.length === 1, JSON.stringify(parsed.map((a) => a.id)))
    check('拦下时说了串号', logs.some((m) => m.includes('同一个会话')), JSON.stringify(logs))
  }

  console.log('\n[25] 批次号与老状态文件')
  {
    // 同一批消息重复投，批次号必须一样，模型才认得出不用重答
    const ownStore = new Store(join(tmp, 'store31.json'), {})
    const box = []
    const ag = { followup: async (m) => { box.push(m) } }
    const r12 = new Router({ ctx: { agents: { get: () => ag } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 500, criticalQuietMs: 500, groupWakeMode: 'all' })
    const acc12 = { id: 't12', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r12.handleEvent(acc12, backend.groupEvent('第一条', { messageId: 'bn1' }))
    await new Promise((r) => setTimeout(r, 900))
    const t1 = box[0]?.content?.[0]?.text ?? ''
    const m1 = /［批 (\d+)-(\d+)］/.exec(t1)
    check('唤醒头带了批次号', !!m1, t1.slice(0, 60))

    // 把水位退回去，模拟「超时没推、下次重投同一批」
    const key12 = 't12/group:555000111'
    // 直接改内部值：markWaked 只往前不往回，用它模拟不出「重投同一批」
    ownStore.data.conversations[key12].lastWakeSeq = 0
    r12.handleEvent(acc12, backend.groupEvent('第二条', { messageId: 'bn2' }))
    await new Promise((r) => setTimeout(r, 900))
    const t2 = box[1]?.content?.[0]?.text ?? ''
    const m2 = /［批 (\d+)-(\d+)］/.exec(t2)
    check('重投时批次号从同一条起算', !!m1 && !!m2 && m2[1] <= m1[1], 'm1=' + JSON.stringify(m1) + ' m2=' + JSON.stringify(m2))
    check('第二条也在里面', t2.includes('第二条'))
  }
  {
    // 老状态文件没有 lastWakeSeq：不能把 recent 里那批全当新消息
    const f = join(tmp, 'old-state.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(f, JSON.stringify({
      version: 1,
      conversations: {
        'legacy/group:1': {
          seq: 5,
          readThroughSeq: 5,
          recent: [
            { seq: 1, text: '老1', isSelf: false, identity: 'other' },
            { seq: 2, text: '老2', isSelf: false, identity: 'other' },
            { seq: 5, text: '老5', isSelf: false, identity: 'other' }
          ],
          pending: [],
          seen: []
        }
      }
    }), 'utf8')
    const legacy = new Store(f, {})
    legacy.ensure('legacy/group:1') // ensure 负责补字段
    const c = legacy.get('legacy/group:1')
    check('缺 lastWakeSeq 时当成都投过了', c.lastWakeSeq === 5, 'lastWake=' + c.lastWakeSeq)
    check('不会把老的当新消息推', legacy.pendingAll('legacy/group:1').length === 0, 'left=' + legacy.pendingAll('legacy/group:1').length)
  }

  console.log('\n[26] 重投时标出重叠段')
  {
    const ownStore = new Store(join(tmp, 'store32.json'), {})
    const box = []
    // 第一次：卡住，超时，记下「试到哪」
    let release
    const gate = new Promise((r) => { release = r })
    const holdAgent = { followup: async () => { await gate } }
    const r13 = new Router({ ctx: { agents: { get: () => holdAgent } }, store: ownStore, accounts, log: () => {}, followupTimeoutMs: 400, batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'all' })
    const acc13 = { id: 't13', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r13.handleEvent(acc13, backend.groupEvent('第一波', { messageId: 'ov1' }))
    await new Promise((r) => setTimeout(r, 1600))
    const key13 = 't13/group:555000111'
    const att = ownStore.getAttempt(key13)
    check('超时后记下试过的范围', !!att && att.first > 0, JSON.stringify(att))

    // 第二次：又有人说话，新的一批盖住上次那段
    release()
    const okAgent = { followup: async (m) => { box.push(m) } }
    const r14 = new Router({ ctx: { agents: { get: () => okAgent } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'all' })
    r14.handleEvent(acc13, backend.groupEvent('第二波', { messageId: 'ov2' }))
    await new Promise((r) => setTimeout(r, 1000))
    const t = box[0]?.content?.[0]?.text ?? ''
    check('重投时标出了重叠段', t.includes('上次可能已投'), t.slice(0, 120))
    check('两波内容都在', t.includes('第一波') && t.includes('第二波'), t.slice(0, 160))
    check('投成之后把标记清了', !ownStore.getAttempt(key13), JSON.stringify(ownStore.getAttempt(key13)))
  }

  console.log('\n[27] 每次真投都留一行日志')
  {
    const lines = []
    const ownStore = new Store(join(tmp, 'store33.json'), {})
    const ag = { followup: async () => {} }
    const r15 = new Router({ ctx: { agents: { get: () => ag } }, store: ownStore, accounts, log: (m) => lines.push(m), batchQuietMs: 500, criticalQuietMs: 500, groupWakeMode: 'mention' })
    const acc15 = { id: 't15', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    // 三条闲聊：一条日志都不该有
    r15.handleEvent(acc15, backend.groupEvent('闲一', { messageId: 'lg1' }))
    r15.handleEvent(acc15, backend.groupEvent('闲二', { messageId: 'lg2' }))
    await new Promise((r) => setTimeout(r, 900))
    check('闲聊一条投递日志都没有', lines.filter((l) => l.startsWith('投递')).length === 0, lines.join(' / '))

    // 点我一次：正好一行，而且条数是三条
    const atEv = backend.groupEvent('点你', { messageId: 'lg3' })
    atEv.message = [{ type: 'at', data: { qq: '3000000001' } }, { type: 'text', data: { text: '点你' } }]
    r15.handleEvent(acc15, atEv)
    await new Promise((r) => setTimeout(r, 900))
    const dels = lines.filter((l) => l.startsWith('投递'))
    check('点我之后正好一行', dels.length === 1, dels.join(' / '))
    check('那行带了批号和条数', /批\d+-\d+ 共 3 条/.test(dels[0] ?? ''), dels[0] ?? '')
  }

  console.log('\n[28] 一进一出，账要对得上')
  {
    const lines = []
    const ownStore = new Store(join(tmp, 'store34.json'), {})
    const ag = { followup: async () => {} }
    const r16 = new Router({ ctx: { agents: { get: () => ag } }, store: ownStore, accounts, log: (m) => lines.push(m), batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'mention' })
    const acc16 = { id: 't16', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }

    // 一条闲聊 → 搁置
    r16.handleEvent(acc16, backend.groupEvent('闲聊', { messageId: 'a1' }))
    // 一条白名单外 → 拦下
    r16.handleEvent(acc16, backend.privateEvent('陌生人', { userId: 999999, messageId: 'a2' }))
    // 一条点名 → 投递
    const atEv = backend.groupEvent('点你', { messageId: 'a3' })
    atEv.message = [{ type: 'at', data: { qq: '3000000001' } }, { type: 'text', data: { text: '点你' } }]
    r16.handleEvent(acc16, atEv)
    await new Promise((r) => setTimeout(r, 1000))

    const kinds = (w) => lines.filter((l) => l.startsWith(w + ' ')).length
    check('闲聊留了搁置一行', kinds('搁置') >= 1, lines.join(' / ').slice(0, 200))
    check('白名单外留了拦下一行', kinds('拦下') >= 1, lines.join(' / ').slice(0, 200))
    check('点名留了投递一行', kinds('投递') === 1, lines.join(' / ').slice(0, 200))
    check('每条进来的都有去向', kinds('搁置') + kinds('拦下') + kinds('投递') >= 3, JSON.stringify({ 搁置: kinds('搁置'), 拦下: kinds('拦下'), 投递: kinds('投递') }))
  }

  console.log('\n[29] 投递后不该再显示同一批没读过')
  {
    const ownStore = new Store(join(tmp, 'store35.json'), {})
    const ag = { followup: async () => {} }
    const r17 = new Router({ ctx: { agents: { get: () => ag } }, store: ownStore, accounts, log: () => {}, batchQuietMs: 400, criticalQuietMs: 400, groupWakeMode: 'mention' })
    const acc17 = { id: 't17', session: 'session-abc', allow: { private: ['111111'], groups: ['555000111'] }, client }
    r17.handleEvent(acc17, backend.groupEvent('投出去的一条', { messageId: 'w1' }))
    const atEv = backend.groupEvent('点你', { messageId: 'w2' })
    atEv.message = [{ type: 'at', data: { qq: '3000000001' } }, { type: 'text', data: { text: '点你' } }]
    r17.handleEvent(acc17, atEv)
    await new Promise((r) => setTimeout(r, 1000))
    const key17 = 't17/group:555000111'
    const u = ownStore.unread(key17)
    check('投完之后未读清零（再读不会又是同一批）', u.unreadCount === 0, 'unread=' + u.unreadCount)
    check('已读水位推到了投出去那条', ownStore.get(key17).readThroughSeq >= 2, 'read=' + ownStore.get(key17).readThroughSeq)
  }
  {
    // mark_read 不给 throughSeq 就不动
    const ownStore = new Store(join(tmp, 'store36.json'), {})
    const defs = makeTools()
    registerTools({ register: defs.register, hub: { accounts, store: ownStore, router }, log: () => {} })
    // 用 hub 里已经注册的那个账号（id=test），不然 pickAccount 找不到
    ownStore.push('test/private:111111', { messageId: 'mr1', userId: '111111', text: '未读的一条', at: '12:00' })
    const before = ownStore.get('test/private:111111').readThroughSeq
    const out = await defs.defs.get('qq_mark_read').execute({ kind: 'private', target: '111111' })
    check('省略 throughSeq 时不动', ownStore.get('test/private:111111').readThroughSeq === before, 'before=' + before + ' after=' + ownStore.get('test/private:111111').readThroughSeq)
    check('说清了要用 qq_read 的数', out.includes('没动') && out.includes('readThroughSeq'), out.slice(0, 100))
  }

  console.log('\n[30] 关键事件落到文件')
  {
    const lf = join(tmp, 'gateway.log')
    const sink = createFileLogger(lf)
    check('给了路径就有 logger', typeof sink === 'function')
    sink('投递 t19 group:1 批 1-3 共 3 条')
    sink('搁置 t19 group:1 第4条 原因=群里没点名，只记账')
    const back = readFileSyncSync(lf, 'utf8')
    check('两行都写进去了', back.split(/\r?\n/).filter(Boolean).length === 2, JSON.stringify(back.slice(0, 120)))
    check('每行带时间', /^\d{2}:\d{2}:\d{2} /.test(back), back.slice(0, 20))
    check('内容对得上', back.includes('投递') && back.includes('搁置'))
    const none = createFileLogger('')
    check('没给路径就不写', none === null)
    check('默认日志路径在 DSH 家目录', logPath('').replace(/\\/g, '/').endsWith('.dsh/qq-gateway/gateway.log'), logPath(''))
  }

  await backend.close()
  rmSync(tmp, { recursive: true, force: true })

  console.log('\n=== ' + pass + ' 通过，' + fail + ' 失败 ===')
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log('  · ' + f)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('自测炸了：', error)
  process.exitCode = 1
})
