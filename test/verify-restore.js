// 验「备份能退回去」：在临时副本上模拟 install_bundle 的真实改动，再照回退步骤精确删掉，
// 最后跟备份逐字节比。
//
// 跑法：node test/verify-restore.js <备份目录>
//
// 模拟的是 DSH 源码里真会变的那几处（查过 dsh-plugin-manager 的 install_bundle）：
//   package.json 的 dependencies 加一条
//   package.json 的 dsh.profile.bundles 加一个名字
//   pnpm-lock.yaml 变
//   node_modules 多一个链接
// **不碰** profile 的 cordis.patch.yml 和 cordis.yml——DSH 是读插件包里自带那份 patch
// 直接应用，不落盘。早先这里模拟错了，改成对的。

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'

const bakDir = process.argv[2]
if (!bakDir) {
  console.error('要给备份目录')
  process.exit(2)
}

const work = mkdtempSync(join(process.cwd(), '.verify-'))
const read = (p) => readFileSync(p, 'utf8')
const PKG = '@local/dsh-qq-gateway'
let failed = 0
const check = (name, cond, detail) => {
  if (cond) console.log('  ok  ' + name)
  else { failed += 1; console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

try {
  mkdirSync(join(work, 'node_modules'), { recursive: true })
  for (const f of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml', 'cordis.yml']) {
    copyFileSync(join(bakDir, f), join(work, f))
  }

  // --- 模拟 install_bundle ---
  const pkg = JSON.parse(read(join(work, 'package.json')))
  pkg.dependencies[PKG] = 'link:qq-bridge-v2'
  pkg.dsh = pkg.dsh ?? {}
  pkg.dsh.profile = pkg.dsh.profile ?? {}
  pkg.dsh.profile.bundles = [...(pkg.dsh.profile.bundles ?? []), PKG]
  writeFileSync(join(work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n', 'utf8')

  // 锁文件会变：模拟加一段
  writeFileSync(join(work, 'pnpm-lock.yaml'), read(join(work, 'pnpm-lock.yaml')) + '\n  ' + PKG + ': link:qq-bridge-v2\n', 'utf8')

  mkdirSync(join(work, 'node_modules', 'dsh-qq-gateway'), { recursive: true })
  writeFileSync(join(work, 'node_modules', 'dsh-qq-gateway', 'package.json'), '{}', 'utf8')

  // patch 和 cordis.yml 不该被动，被动了要报出来
  check('模拟安装没碰 cordis.patch.yml', read(join(work, 'cordis.patch.yml')) === read(join(bakDir, 'cordis.patch.yml')))

  // --- 精确回退 ---
  const pkg2 = JSON.parse(read(join(work, 'package.json')))
  delete pkg2.dependencies[PKG]
  pkg2.dsh.profile.bundles = (pkg2.dsh.profile.bundles ?? []).filter((x) => x !== PKG)
  writeFileSync(join(work, 'package.json'), JSON.stringify(pkg2, null, 2) + '\n', 'utf8')

  writeFileSync(
    join(work, 'pnpm-lock.yaml'),
    read(join(work, 'pnpm-lock.yaml')).replace(new RegExp('\\n  ' + PKG.replace(/[/@.]/g, '\\$&') + ': link:[^\\n]*\\n$'), ''),
    'utf8'
  )
  rmSync(join(work, 'node_modules', 'dsh-qq-gateway'), { recursive: true, force: true })

  // --- 比对 ---
  check('package.json 两处都回到原样', read(join(work, 'package.json')) === read(join(bakDir, 'package.json')))
  check('pnpm-lock.yaml 回到原样', read(join(work, 'pnpm-lock.yaml')) === read(join(bakDir, 'pnpm-lock.yaml')))
  check('node_modules 里的链接清掉了', !existsSync(join(work, 'node_modules', 'dsh-qq-gateway')))
  check('cordis.patch.yml 没被碰过', read(join(work, 'cordis.patch.yml')) === read(join(bakDir, 'cordis.patch.yml')))
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? '\n=== ' + failed + ' 项没对上 ===' : '\n=== 回退步骤验过，能回到原样 ===')
process.exitCode = failed ? 1 : 0
