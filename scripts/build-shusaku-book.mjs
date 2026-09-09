/**
 * 秀策开局库构建器。
 *
 * 读取 data/sgf/shusaku/*.sgf（棋谱文件名与内容需含秀策/安田荣斋），
 * 提取秀策执子的着法序列，构建「手顺路径 → 该局面下秀策的实际着法计数」
 * 的开局树，输出 src/data/shusaku-book.json 供引擎适配层查表。
 *
 * 路径键：SGF 坐标小写字母对（aa=左上）以分号连接，"" 为根节点。
 * 仅记录「轮到秀策」的节点候选——查表时 AI 所执颜色与该节点记录方一致才生效。
 *
 * 用法：node scripts/build-shusaku-book.mjs [深度，默认 24]
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const SGF_DIR = 'data/sgf/shusaku'
const OUT_FILE = 'src/data/shusaku-book.json'
const SHUSAKU_NAME = /(shusaku|yasuda\s*eisai|秀策|安田栄斎|安田荣斋)/i

const root = { moves: {} } // 节点：{ moves: { [sgfCoord]: count } }，叶子不再区分轮次

/** 极简 SGF 主线解析：返回 { size, black, white, moves: [{color, x, y}] } */
function parseSgf(text) {
  // 去掉注释与换行（属性值内的换行无关紧要；我们只取 B/W 属性）
  const compact = text.replace(/\r?\n/g, '')
  const sizeM = /\bSZ\[(\d+)\]/.exec(compact)
  const pbM = /\bPB\[([^\]]*)\]/.exec(compact)
  const pwM = /\bPW\[([^\]]*)\]/.exec(compact)
  const moves = []
  const re = /;([BW])\[([a-z]{0,2})\]/g
  let m
  while ((m = re.exec(compact)) !== null) {
    const coord = m[2]
    if (coord.length === 2) {
      moves.push({
        color: m[1],
        x: coord.charCodeAt(0) - 97,
        y: coord.charCodeAt(1) - 97,
      })
    } else if (coord.length === 0) {
      moves.push({ color: m[1], x: -1, y: -1 }) // pass
    }
  }
  return {
    size: sizeM ? parseInt(sizeM[1], 10) : 19,
    black: pbM ? pbM[1] : '',
    white: pwM ? pwM[1] : '',
    moves,
  }
}

function sgfCoord(x, y) {
  if (x < 0 || y < 0) return 'pass'
  return String.fromCharCode(97 + x) + String.fromCharCode(97 + y)
}

async function main() {
  const depth = parseInt(process.argv[2] ?? '24', 10)
  const files = (await readdir(SGF_DIR)).filter((f) => f.toLowerCase().endsWith('.sgf'))
  if (files.length === 0) {
    console.error(`未找到棋谱：请把秀策 SGF 放入 ${SGF_DIR}/`)
    process.exit(1)
  }

  let usedGames = 0
  let shusakuPlies = 0
  const root = { moves: {} }
  let nodeCount = 0

  for (const file of files) {
    const text = await readFile(join(SGF_DIR, file), 'utf8')
    let game
    try {
      game = parseSgf(text)
    } catch (err) {
      console.warn(`跳过（解析失败）${file}: ${err.message}`)
      continue
    }
    const shusakuColor =
      SHUSAKU_NAME.test(game.black) ? 'B' : SHUSAKU_NAME.test(game.white) ? 'W' : null
    if (!shusakuColor) {
      console.warn(`跳过（未识别秀策）${file}：黑=${game.black} 白=${game.white}`)
      continue
    }
    usedGames++
    let node = root
    const limit = Math.min(game.moves.length, depth)
    for (let i = 0; i < limit; i++) {
      const mv = game.moves[i]
      const key = sgfCoord(mv.x, mv.y)
      if (mv.color === shusakuColor) {
        node.moves[key] = (node.moves[key] ?? 0) + 1
        shusakuPlies++
      }
      // 双方着法都推进路径（含 pass，pass 不作为候选保留意义不大但仍占路径）
      const child = node[key]
      node = child ?? (node[key] = { moves: {} })
      nodeCount++
    }
  }

  await mkdir('src/data', { recursive: true })
  await writeFile(
    OUT_FILE,
    JSON.stringify(
      {
        generatedFrom: `${usedGames} games (${files.length} files scanned)`,
        depth,
        root,
      },
      null,
      1,
    ),
  )
  console.log(`开局库完成：${usedGames} 局，秀策着法 ${shusakuPlies} 手，节点 ${nodeCount} 个 → ${OUT_FILE}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
