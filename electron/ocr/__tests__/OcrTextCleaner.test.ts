/**
 * OcrTextCleaner 单元测试
 *
 * 覆盖：中文菜单栏去除、英文 UI 去除、碎片行合并、URL 残片去除、噪声评分、空文本处理。
 *
 * 运行方式：node --import tsx electron/ocr/__tests__/OcrTextCleaner.test.ts
 * （项目未配置测试运行器，使用 Node 内置 node:test；tsx 需单独安装）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { OcrTextCleaner } from '../OcrTextCleaner'

const cleaner = new OcrTextCleaner()

test('中文菜单栏去除：含"文件 编辑 视图 收藏 工具 帮助"的行被移除', () => {
  const raw = '文件 编辑 视图 收藏 工具 帮助\n订单退款流程优化方案讨论'
  const { cleanedText, noiseScore } = cleaner.clean(raw)
  assert.ok(!cleanedText.includes('文件'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(!cleanedText.includes('编辑'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(!cleanedText.includes('视图'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(!cleanedText.includes('收藏'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(!cleanedText.includes('工具'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(!cleanedText.includes('帮助'), `cleanedText 不应包含菜单栏文字: ${cleanedText}`)
  assert.ok(cleanedText.includes('订单退款流程优化方案讨论'))
  assert.ok(noiseScore > 0, `noiseScore 应大于 0: ${noiseScore}`)
})

test('英文 UI 去除：含"File Edit View Tools Help"的行被移除', () => {
  const raw = 'File Edit View Tools Help\nDiscuss the order refund process'
  const { cleanedText, noiseScore } = cleaner.clean(raw)
  assert.ok(!/\bFile\b/i.test(cleanedText), `cleanedText 不应包含英文菜单栏: ${cleanedText}`)
  assert.ok(!/\bEdit\b/i.test(cleanedText), `cleanedText 不应包含英文菜单栏: ${cleanedText}`)
  assert.ok(!/\bView\b/i.test(cleanedText), `cleanedText 不应包含英文菜单栏: ${cleanedText}`)
  assert.ok(!/\bTools\b/i.test(cleanedText), `cleanedText 不应包含英文菜单栏: ${cleanedText}`)
  assert.ok(!/\bHelp\b/i.test(cleanedText), `cleanedText 不应包含英文菜单栏: ${cleanedText}`)
  assert.ok(cleanedText.includes('Discuss the order refund process'))
  assert.ok(noiseScore > 0, `noiseScore 应大于 0: ${noiseScore}`)
})

test('碎片行合并：连续短行合并为一行', () => {
  const raw = '订单退款\n流程优化\n方案讨论'
  const { cleanedText } = cleaner.clean(raw)
  const lines = cleanedText.split('\n').filter((l) => l.trim() !== '')
  assert.equal(lines.length, 1, `合并后应为 1 行，实际: ${lines.length} 行: ${cleanedText}`)
  assert.ok(cleanedText.includes('订单退款'), `cleanedText 应包含"订单退款": ${cleanedText}`)
  assert.ok(cleanedText.includes('流程优化'), `cleanedText 应包含"流程优化": ${cleanedText}`)
  assert.ok(cleanedText.includes('方案讨论'), `cleanedText 应包含"方案讨论": ${cleanedText}`)
})

test('URL 残片去除：含 https://example.com/path 的行被移除', () => {
  const raw = 'https://example.com/path\n订单退款流程优化方案讨论'
  const { cleanedText, noiseScore } = cleaner.clean(raw)
  assert.ok(!cleanedText.includes('https://example.com'), `cleanedText 不应包含 URL: ${cleanedText}`)
  assert.ok(!cleanedText.includes('example.com'), `cleanedText 不应包含 URL 域名: ${cleanedText}`)
  assert.ok(cleanedText.includes('订单退款流程优化方案讨论'))
  assert.ok(noiseScore > 0, `noiseScore 应大于 0: ${noiseScore}`)
})

test('噪声评分：高噪声输入应返回高 noiseScore', () => {
  const raw = '文件 编辑 视图\nFile Edit View\nhttps://example.com\n12:30\n100%\n确定 取消'
  const { noiseScore } = cleaner.clean(raw)
  assert.ok(
    noiseScore >= 0.7,
    `高噪声输入 noiseScore 应 >= 0.7，实际: ${noiseScore}`
  )
})

test('空文本处理：input "" → cleanedText="", noiseScore=1', () => {
  const { cleanedText, noiseScore } = cleaner.clean('')
  assert.equal(cleanedText, '')
  assert.equal(noiseScore, 1)
})

test('纯空白文本处理：input "   " → cleanedText="", noiseScore=1', () => {
  const { cleanedText, noiseScore } = cleaner.clean('   ')
  assert.equal(cleanedText, '')
  assert.equal(noiseScore, 1)
})

test('单行文本处理：保留单行内容', () => {
  const raw = '订单退款流程优化方案讨论'
  const { cleanedText, noiseScore } = cleaner.clean(raw)
  assert.equal(cleanedText, '订单退款流程优化方案讨论')
  assert.equal(noiseScore, 0)
})

test('行级去重：完全相同的行只保留首次出现', () => {
  const raw = '订单退款流程优化方案讨论\n订单退款流程优化方案讨论'
  const { cleanedText } = cleaner.clean(raw)
  const lines = cleanedText.split('\n').filter((l) => l.trim() !== '')
  assert.equal(lines.length, 1, `去重后应为 1 行: ${cleanedText}`)
})

test('英文噪声词大小写不敏感', () => {
  const raw = 'file edit view\n订单退款流程优化'
  const { cleanedText } = cleaner.clean(raw)
  assert.ok(!/\bfile\b/i.test(cleanedText), `小写英文菜单栏应被移除: ${cleanedText}`)
  assert.ok(cleanedText.includes('订单退款流程优化'))
})

test('连续空行折叠至最多 1 行', () => {
  const raw = '第一段内容\n\n\n\n第二段内容'
  const { cleanedText } = cleaner.clean(raw)
  assert.ok(
    !/\n{3,}/.test(cleanedText),
    `cleanedText 不应包含 3 个及以上连续换行: ${JSON.stringify(cleanedText)}`
  )
})

test('cleanedText 已 trim（无首尾空行）', () => {
  const raw = '\n\n订单退款流程优化\n\n'
  const { cleanedText } = cleaner.clean(raw)
  assert.equal(cleanedText, '订单退款流程优化')
})

test('混合噪声与内容：仅移除噪声行，保留有效内容', () => {
  const raw = [
    '文件 编辑 视图',
    '订单退款流程优化方案讨论',
    'https://example.com/path',
    '确定 取消',
    '这是一个很长的句子，超过了十五个字。'
  ].join('\n')
  const { cleanedText, noiseScore } = cleaner.clean(raw)
  assert.ok(cleanedText.includes('订单退款流程优化方案讨论'))
  assert.ok(cleanedText.includes('这是一个很长的句子，超过了十五个字。'))
  assert.ok(!cleanedText.includes('example.com'))
  assert.ok(!cleanedText.includes('文件'))
  assert.ok(noiseScore > 0 && noiseScore < 1, `noiseScore 应在 (0,1): ${noiseScore}`)
})
