/**
 * Artifact 배포본(단일 HTML) 검증.
 *
 * dist/artifact.html 을 그대로 띄워서, 인라인된 번들이 외부 요청 없이도
 * 부팅하고 조작까지 되는지 확인한다. CSP 로 외부 호스트가 막힌 환경에서
 * 실제로 동작할지를 미리 잡아내는 용도다.
 *
 *   npm run artifact && node scripts/verify-artifact.mjs
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { chromium } from 'playwright'
const html = await readFile('/home/user/git_test/dist/artifact.html')
const server = createServer((_req, res) => { res.writeHead(200, {'Content-Type':'text/html; charset=utf-8'}); res.end(html) })
await new Promise(r => server.listen(4175, r))
const browser = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
await page.goto('http://localhost:4175/', { waitUntil: 'load' })

// 이제 설정 화면이 먼저 뜬다. 기본값 그대로 시작한다.
await page.waitForSelector('.setup__panel', { timeout: 30000 })
await page.click('[data-action="start"]')

await page.waitForFunction(() => window.__game?.views?.[0]?.state?.maze != null, null, { timeout: 30000 })
await page.waitForFunction(() => (window.__game?.views?.[0]?.state?.renderPlayers()?.length ?? 0) > 0, null, { timeout: 30000 })
await page.keyboard.down('w'); await page.waitForTimeout(900); await page.keyboard.up('w')
const info = await page.evaluate(() => ({
  playerId: window.__game.views[0].state.playerId,
  zone: window.__game.views[0].state.zone,
  maze: window.__game.views[0].state.maze.w,
  players: window.__game.views[0].state.renderPlayers().length,
  gold: window.__game.views[0].state.gold,
}))
await page.screenshot({ path: '/home/user/git_test/screenshots/04-artifact.png' })
console.log('artifact 단일 파일 실행:', JSON.stringify(info))
console.log('콘솔 에러:', errors.length === 0 ? '없음' : errors.slice(0,3).join(' | '))
await browser.close(); server.close()
