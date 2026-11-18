// 假的 OneBot 后端：只实现被用到的那几个动作，把收到的调用记下来给断言看。
// 起在 0 端口，不碰任何真后端。

import { createServer } from 'node:http'

export function startMockOneBot({ uin = 3000000001, nickname = '测试号' } = {}) {
  const calls = []
  const groups = [{ group_id: 555000111, group_name: '测试群' }]
  const members = [
    { user_id: 111111, nickname: '甲', card: '', role: 'member' },
    { user_id: 222222, nickname: '乙', card: '乙的群名片', role: 'admin' }
  ]
  const friends = [{ user_id: 111111, nickname: '甲' }]
  let profile = { nickname, personal_note: '' }
  // 自增号，别用随机串：随机出来的数字可能撞，撞了会被网关的去重吞掉，测出来像插件的毛病。
  let seqNo = 1000
  // 同一个给定 id 永远映射到同一个数字：测去重时要能造「同一条来两次」。
  const idMap = new Map()
  const nextId = (given) => {
    if (given === undefined || given === null || given === '') return ++seqNo
    const k = String(given)
    if (!idMap.has(k)) idMap.set(k, ++seqNo)
    return idMap.get(k)
  }

  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      const action = String(req.url || '/').replace(/^\/+/, '')
      let params = {}
      try { params = body ? JSON.parse(body) : {} } catch {}
      calls.push({ action, params })
      const ok = (data) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data }))
      }
      const fail = (wording) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ status: 'failed', retcode: 100, data: null, wording }))
      }
      switch (action) {
        case 'get_login_info':
          return ok({ user_id: uin, nickname: profile.nickname })
        case 'send_private_msg':
        case 'send_group_msg':
          if (!params.message) return fail('message 不能空')
          return ok({ message_id: 9000 + calls.length })
        case 'send_poke':
          if (!params.user_id) return fail('user_id 不能空')
          return ok({})
        case 'set_qq_profile':
          if (params.nickname) profile.nickname = String(params.nickname)
          if (params.personal_note !== undefined) profile.personal_note = String(params.personal_note)
          return ok({})
        case 'get_group_list':
          return ok(groups)
        case 'get_group_member_list':
          return ok(members)
        case 'get_friend_list':
          return ok(friends)
        case 'get_status':
          return ok({ online: true, good: true })
        case 'get_record':
          // 真的 SnowLuma 带 out_format 会转码并回 base64，这里照那个形状造。
          return ok({
            file: String(params.file ?? ''),
            duration: 3,
            out_format: 'mp3',
            base64: Buffer.from('fake-mp3-bytes-for-test').toString('base64')
          })
        case 'get_forward_msg':
          return ok({
            messages: [
              { sender: { nickname: '甲' }, content: [{ type: 'text', data: { text: '转发的第一句' } }] },
              { sender: { nickname: '乙' }, content: [{ type: 'text', data: { text: '转发的第二句' } }, { type: 'image', data: { url: 'x' } }] }
            ]
          })
        case 'fetch_custom_face':
          return ok(['face-aaa', 'face-bbb', 'face-ccc'])
        default:
          return fail('未实现的动作：' + action)
      }
    })
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: 'http://127.0.0.1:' + port,
        calls,
        get profile() { return profile },
        close: () => new Promise((r) => server.close(() => r())),
        /** 造一条进来的私聊消息 */
        privateEvent(text, { userId = 111111, nickname = '甲', messageId } = {}) {
          return {
            post_type: 'message', message_type: 'private', sub_type: 'friend',
            message_id: nextId(messageId),
            user_id: userId, self_id: uin, time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text } }],
            raw_message: text, sender: { user_id: userId, nickname }
          }
        },
        /** 造一条进来的群聊消息 */
        groupEvent(text, { userId = 111111, nickname = '甲', groupId = 555000111, messageId } = {}) {
          return {
            post_type: 'message', message_type: 'group', sub_type: 'normal',
            message_id: nextId(messageId),
            user_id: userId, group_id: groupId, self_id: uin, time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text } }],
            raw_message: text, sender: { user_id: userId, nickname, card: '' }
          }
        }
      })
    })
  })
}
