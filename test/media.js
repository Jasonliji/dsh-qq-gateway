// 媒体这几条路的自测：真的 OneBotClient、真的 Router，只把 DSH 和 QQ 换成假的。
// 跑法：node test/media.js
// 不写 profile，不连真后端，不调真模型。

import { mkdtempSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { OneBotClient, segmentsToMedia } from '../src/onebot.js'
import { Store } from '../src/store.js'
import { Router } from '../src/router.js'
import { registerTools } from '../src/tools.js'
import { sniffMediaType, resolveIncoming, saveVoice, expandForward, listFaces } from '../src/media.js'
import { startMockOneBot } from './mock-onebot.js'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail) {
  if (cond) { pass += 1; console.log('  ok  ' + name) }
  else { fail += 1; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// 1x1 的 PNG，字节头对得上 sniffMediaType，DSH 那边也认。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function makeTools() {
  const defs = new Map()
  const register = (d) => { defs.set(d.name, d); return () => { defs.delete(d.name) } }
  return { register, defs }
}

async function main() {
  const tmp = mkdtempSync(join(tmpdir(), 'qqgw-media-'))
  const mediaDir = join(tmp, 'media')

  // 一个小图床：只回那张 PNG，别的路径 404。顺手记下有没有被请求过。
  const imageHits = []
  const images = createServer((req, res) => {
    imageHits.push(String(req.url || ''))
    if (String(req.url || '').includes('ok')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(PNG)
    } else {
      res.writeHead(404)
      res.end('nope')
    }
  })
  const imageUrl = await new Promise((resolve) => {
    images.listen(0, '127.0.0.1', () => resolve('http://127.0.0.1:' + images.address().port))
  })

  const backend = await startMockOneBot({ uin: 3000000001, nickname: '测试号' })
  const client = new OneBotClient({ id: 'test', httpUrl: backend.url })
  const account = {
    id: 'test',
    session: 'session-abc',
    owner: '111111',
    allow: { private: ['111111'], groups: ['555000111'] },
    client
  }
  const store = new Store(join(tmp, 'state.json'), {})

  console.log('\n[1] 从消息段里挑出要另作的媒体')
  {
    const media = segmentsToMedia([
      { type: 'text', data: { text: '看这个' } },
      { type: 'image', data: { url: imageUrl + '/ok.png', file: 'a.image', sub_type: 0 } },
      { type: 'image', data: { url: 'http://x/y', sub_type: 1, summary: '[表情]' } },
      { type: 'record', data: { file: 'v.amr', url: 'http://x/v', second: 4 } },
      { type: 'forward', data: { id: 'fw-1' } },
      { type: 'mface', data: { summary: '[开心]', emoji_id: 'e1' } }
    ])
    check('文本不进媒体', media.every((m) => m.kind !== 'text'), JSON.stringify(media.map((m) => m.kind)))
    check('认出图片', media.filter((m) => m.kind === 'image').length === 2)
    check('收藏表情标成 asFace', media.filter((m) => m.kind === 'image' && m.asFace).length === 1)
    check('认出语音', media.some((m) => m.kind === 'record'))
    check('认出合并转发', media.some((m) => m.kind === 'forward'))
    check('认出表情包', media.some((m) => m.kind === 'mface'))
    check('纯文本没有媒体', segmentsToMedia([{ type: 'text', data: { text: 'hi' } }]).length === 0)
  }

  console.log('\n[2] 按文件头认类型')
  {
    check('认出 png', sniffMediaType(PNG) === 'image/png', sniffMediaType(PNG))
    check('认出 jpeg', sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0x00])) === 'image/jpeg')
    check('认不出就空着', sniffMediaType(Buffer.from([1, 2, 3, 4])) === '')
    check('声明说得清就用声明', sniffMediaType(Buffer.from([1, 2, 3, 4]), 'image/webp') === 'image/webp')
  }

  console.log('\n[3] 图片进会话')
  {
    const got = []
    const ctx = {
      attachments: {
        admitPromptContent: async (parts) => {
          got.push(parts)
          return parts.map((p) => (p.type === 'image' ? { type: 'image', attachment: { attachmentId: 'att-1', mediaType: p.mediaType } } : p))
        }
      }
    }
    const r = await resolveIncoming(account, ctx, {
      media: [{ kind: 'image', url: imageUrl + '/ok.png', asFace: false }],
      dir: mediaDir
    })
    check('调了 admit', got.length === 1)
    check('传上去的类型对', got[0]?.[0]?.mediaType === 'image/png', String(got[0]?.[0]?.mediaType))
    check('回了一个图片块', r.parts.length === 1 && r.parts[0].type === 'image')
    check('没多余说明', r.lines.length === 0, r.lines.join('|'))
  }

  console.log('\n[4] 宿主没有附件服务时降级')
  {
    const r = await resolveIncoming(account, {}, { media: [{ kind: 'image', url: imageUrl + '/ok.png' }], dir: mediaDir })
    check('不抛，给说明', r.lines.length === 1, r.lines.join('|'))
    check('落盘给了路径', /已存本地/.test(r.lines[0] || ''), r.lines[0])
    const m = String(r.lines[0] || '').match(/已存本地 ([^，]+)/)
    check('文件真写出来了', !!m && existsSync(m[1]), m?.[1])
  }

  console.log('\n[5] 图下不来也得说清')
  {
    const r = await resolveIncoming(account, {}, { media: [{ kind: 'image', url: imageUrl + '/missing.png' }], dir: mediaDir })
    check('没抛', Array.isArray(r.lines))
    check('写了原因', /没下来/.test(r.lines[0] || ''), r.lines[0])
  }

  console.log('\n[6] 收藏表情不占上下文')
  {
    const r = await resolveIncoming(account, {}, { media: [{ kind: 'image', url: 'http://x/y', asFace: true, summary: '[开心]' }], dir: mediaDir })
    check('不拉图', imageHits.every((h) => !h.includes('/y')), imageHits.join(','))
    check('只给个名字', r.parts.length === 0 && /表情包/.test(r.lines[0] || ''), r.lines[0])
  }

  console.log('\n[7] 语音落地')
  {
    const r = await saveVoice(account, { kind: 'record', file: 'v.amr' }, { dir: mediaDir })
    check('走通了', r.ok === true, JSON.stringify(r))
    check('存成文件', !!r.path && existsSync(r.path), String(r.path))
    check('拿到了时长', r.seconds === 3, String(r.seconds))
    check('内容是后端给的', r.path ? readFileSync(r.path).toString() === 'fake-mp3-bytes-for-test' : false)
    const lines = await resolveIncoming(account, {}, { media: [{ kind: 'record', file: 'v.amr' }], dir: mediaDir })
    check('消息里给出路径和转写入口', /audio_transcribe/.test(lines.lines[0] || ''), lines.lines[0])
  }

  console.log('\n[8] 合并转发展开')
  {
    const r = await expandForward(account, { kind: 'forward', id: 'fw-1' })
    check('展开了', r.ok === true && r.count === 2, JSON.stringify(r).slice(0, 120))
    check('带发言人', /甲：转发的第一句/.test(r.text || ''), String(r.text).slice(0, 80))
    check('里面那张图给了标记', /\[图片\]/.test(r.text || ''), String(r.text).slice(0, 120))
    const bad = await expandForward(account, { kind: 'forward' })
    check('没 id 就说没 id', !!bad.error, JSON.stringify(bad))
  }

  console.log('\n[9] 收藏表情列表')
  {
    const ids = await listFaces(account, { count: 10 })
    check('拿到三个', ids.length === 3, JSON.stringify(ids))
  }

  console.log('\n[10] 发语音、发表情')
  {
    const { register, defs } = makeTools()
    registerTools({ register, hub: { accounts: [account], store, router: null }, log: () => {} })
    backend.calls.length = 0
    const out = await defs.get('qq_send').execute({
      kind: 'private', target: '111111',
      voice: 'D:\\tmp\\a.mp3',
      face: 'e1:p1'
    })
    const segs = backend.calls.map((c) => c.params?.message).filter(Boolean)
    const flat = JSON.stringify(segs)
    check('发了语音段', flat.includes('"type":"record"'), flat.slice(0, 160))
    check('路径转成了 file://', flat.includes('file://D:/tmp/a.mp3'), flat.match(/file:\/\/[^"]+/)?.[0] ?? '')
    check('发了表情段', flat.includes('"type":"mface"'), flat.slice(0, 200))
    check('表情带 emoji_id', flat.includes('"emoji_id":"e1"'))
    check('表情带包 id', flat.includes('"emoji_package_id":"p1"'))
    check('结果里报了语音', /语音 1 条/.test(out), out)
    check('结果里报了表情', /表情包 1 条/.test(out), out)
  }

  console.log('\n[11] 一个都没给要拦下来')
  {
    const { register, defs } = makeTools()
    registerTools({ register, hub: { accounts: [account], store, router: null }, log: () => {} })
    let threw = ''
    try {
      await defs.get('qq_send').execute({ kind: 'private', target: '111111' })
    } catch (error) { threw = error?.message ?? String(error) }
    check('抛了说清原因', /都空着/.test(threw), threw)
  }

  console.log('\n[12] 投递时图真的进了会话')
  {
    const got = []
    const ctx = {
      agents: { get: () => ({ followup: async (m) => { got.push(m) } }) },
      attachments: {
        admitPromptContent: async (parts) => parts.map((p) => (p.type === 'image' ? { type: 'image', attachment: { attachmentId: 'att-9', mediaType: p.mediaType } } : p))
      }
    }
    const r = new Router({ ctx, store, accounts: [account], log: () => {}, batchQuietMs: 200, criticalQuietMs: 200, groupWakeMode: 'all', mediaDir })
    const ev = backend.privateEvent('看这张', { messageId: 'img-1' })
    ev.message = [
      { type: 'text', data: { text: '看这张' } },
      { type: 'image', data: { url: imageUrl + '/ok.png', sub_type: 0 } }
    ]
    r.handleEvent(account, ev)
    await new Promise((res) => setTimeout(res, 900))
    check('投出去了', got.length === 1, 'inbox=' + got.length)
    const msg = got[0]
    check('内容里有两块', Array.isArray(msg?.content) && msg.content.length === 2, JSON.stringify(msg?.content?.map?.((c) => c.type)))
    check('第二块是图', msg?.content?.[1]?.type === 'image')
    check('文字里留着原话', String(msg?.content?.[0]?.text || '').includes('看这张'))
    r.dispose?.()
  }

  console.log('\n[13] 媒体整条关掉就只留标记')
  {
    const got = []
    const ctx = { agents: { get: () => ({ followup: async (m) => { got.push(m) } }) } }
    const r = new Router({ ctx, store, accounts: [account], log: () => {}, batchQuietMs: 200, criticalQuietMs: 200, groupWakeMode: 'all', mediaEnabled: false, mediaDir })
    const ev = backend.privateEvent('关掉试试', { messageId: 'img-2' })
    ev.message = [
      { type: 'text', data: { text: '关掉试试' } },
      { type: 'image', data: { url: imageUrl + '/ok.png' } }
    ]
    r.handleEvent(account, ev)
    await new Promise((res) => setTimeout(res, 900))
    check('还是投了', got.length === 1, 'inbox=' + got.length)
    check('没有图块', (got[0]?.content?.length ?? 0) === 1, JSON.stringify(got[0]?.content?.map?.((c) => c.type)))
    // 关掉媒体处理后，地址还是要留在正文里：模型至少能自己决定去不去取。
    check('文字里留着图片标记和地址', /\[图片/.test(String(got[0]?.content?.[0]?.text || '')), String(got[0]?.content?.[0]?.text || '').slice(-80))
    r.dispose?.()
  }

  console.log('\n[14] 媒体出错不拖垮投递')
  {
    const got = []
    const ctx = {
      agents: { get: () => ({ followup: async (m) => { got.push(m) } }) },
      attachments: { admitPromptContent: async () => { throw new Error('故意炸一下') } }
    }
    const r = new Router({ ctx, store, accounts: [account], log: () => {}, batchQuietMs: 200, criticalQuietMs: 200, groupWakeMode: 'all', mediaDir })
    const ev = backend.privateEvent('还是会到', { messageId: 'img-3' })
    ev.message = [{ type: 'text', data: { text: '还是会到' } }, { type: 'image', data: { url: imageUrl + '/ok.png' } }]
    r.handleEvent(account, ev)
    await new Promise((res) => setTimeout(res, 900))
    check('消息照投', got.length === 1, 'inbox=' + got.length)
    check('降级成说明', /存本地|没下来|没处理成/.test(String(got[0]?.content?.[0]?.text || '')), String(got[0]?.content?.[0]?.text || '').slice(-120))
    r.dispose?.()
  }

  await backend.close()
  await new Promise((res) => images.close(res))
  rmSync(tmp, { recursive: true, force: true })

  console.log('\n=== ' + pass + ' 通过，' + fail + ' 失败 ===')
  if (failures.length) { console.log('失败项：'); for (const f of failures) console.log('  · ' + f) }
  process.exit(fail ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
