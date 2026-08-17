/**
 * 헤드리스 스모크 테스트.
 *
 * 단위 테스트가 잡지 못하는 것을 본다: 번들이 실제 브라우저에서 뜨는지,
 * Babylon 트리셰이킹 과정에서 사이드이펙트 임포트를 빠뜨리지 않았는지,
 * WebGL 씬이 실제로 그려지는지, 키 입력이 캐릭터를 움직이는지.
 *
 *   npm run build && node scripts/smoke.mjs
 *
 * 결과 스크린샷은 screenshots/ 에 남는다.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { chromium } from 'playwright'

const DIST = new URL('../dist/', import.meta.url).pathname
const SHOTS = new URL('../screenshots/', import.meta.url).pathname
const PORT = 4173

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
}

function serveDist() {
  const server = createServer(async (req, res) => {
    const path = normalize(decodeURIComponent((req.url ?? '/').split('?')[0]))
    const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '')
    try {
      const body = await readFile(join(DIST, file))
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)))
}

const failures = []
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label} ${detail}`)
    failures.push(label)
  }
}

const server = await serveDist()
await mkdir(SHOTS, { recursive: true })

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: [
    '--no-sandbox',
    // 헤드리스 컨테이너에는 GPU 가 없다. SwiftShader 로 소프트웨어 렌더링한다.
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
  ],
})

try {
  console.log('\n[1] 단일 화면 부팅 + 조작')
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })

  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(String(error)))
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await page.goto(`http://localhost:${PORT}/?views=1`, { waitUntil: 'load' })

  await page.waitForFunction(() => window.__game?.views?.[0]?.state?.maze != null, null, { timeout: 20000 })
  check('페이지가 뜨고 미로가 생성됨', true)

  // 스냅샷이 몇 번 오갈 시간을 준다.
  await page.waitForFunction(
    () => (window.__game?.views?.[0]?.state?.renderPlayers()?.length ?? 0) > 0,
    null,
    { timeout: 20000 },
  )
  check('호스트로부터 스냅샷 수신', true)

  const rendered = await page.evaluate(() => {
    const engine = window.__game.views[0]
    return {
      playerId: engine.state.playerId,
      level: engine.state.level,
      mazeSize: engine.state.maze.w,
      players: engine.state.renderPlayers().length,
    }
  })
  check('playerId 배정', rendered.playerId === 1, `(got ${rendered.playerId})`)
  check('레벨 1 / 15x15 미로', rendered.level === 1 && rendered.mazeSize === 15, JSON.stringify(rendered))

  // WebGL 이 실제로 그리고 있는지 확인한다.
  //
  // gl.readPixels 는 preserveDrawingBuffer 가 꺼져 있으면 언제 읽느냐에 따라 빈
  // 버퍼가 나온다. 이 컨테이너는 GPU 가 없어 SwiftShader 로 몇 fps 밖에 안 나와서
  // 특히 불안정했다. 대신 시점을 바꿔 두 장을 찍고 결과가 달라지는지 본다.
  // 캔버스가 비어 있으면 두 PNG 가 동일하고 크기도 아주 작으므로, 디코딩 없이도
  // "실제로 장면이 그려지고 카메라에 반응한다"를 증명할 수 있다.
  const canvasLocator = page.locator('.view__scene')
  const shotBefore = await canvasLocator.screenshot()
  await page.evaluate(() => window.__game.views[0].camera.rotate(Math.PI / 2, 0))
  await page.waitForTimeout(600)
  const shotAfter = await canvasLocator.screenshot()
  check(
    'WebGL 씬이 그려지고 시점 변경에 반응함',
    shotBefore.length > 5000 && !shotBefore.equals(shotAfter),
    `(PNG ${shotBefore.length}B → ${shotAfter.length}B, 동일=${shotBefore.equals(shotAfter)})`,
  )

  // 키 입력 → 이동
  const before = await page.evaluate(() => ({ ...window.__game.views[0].state.predicted }))
  await page.keyboard.down('w')
  await page.waitForTimeout(700)
  const after = await page.evaluate(() => ({ ...window.__game.views[0].state.predicted }))
  const moved = Math.hypot(after.x - before.x, after.z - before.z)
  check('W 키로 캐릭터가 이동', moved > 0.5, `(이동 거리 ${moved.toFixed(2)})`)

  // 이동 중 예측 오차의 정상 상태를 측정한다.
  // 정지 후 한 번만 재면 "클라는 멈췄는데 호스트는 아직 마지막 입력을 적용 중"인
  // 과도 구간을 재게 되어 값이 들쭉날쭉하다.
  const driftSamples = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const samples = []
        const started = performance.now()
        const tick = () => {
          const view = window.__game.views[0]
          const authoritative = window.__game.host().state.players.get(view.state.playerId)
          samples.push(
            Math.hypot(
              view.state.predicted.x - authoritative.x,
              view.state.predicted.z - authoritative.z,
            ),
          )
          if (performance.now() - started > 1500) resolve(samples)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.keyboard.up('w')
  if (process.env.DRIFT_DEBUG) {
    console.log('    drift samples:', driftSamples.map((d) => d.toFixed(2)).join(' '))
  }
  const sorted = [...driftSamples].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const settled = driftSamples[driftSamples.length - 1]
  const maxDrift = Math.max(...driftSamples)
  // 예측은 호스트보다 (전송 지연 + 최대 한 틱) 만큼 앞서 있는 게 정상이다.
  // 지연 0 이면 한 틱(50ms) 이동거리 = 0.3 단위 수준.
  // 모퉁이에서 순간적으로 튀는 값이 섞이므로 중앙값과 수렴값을 본다.
  check(
    '예측이 호스트 권위 위치를 한 틱 이내로 따라감',
    median < 0.8 && settled < 1.2,
    `(중앙값 ${median.toFixed(2)} / 수렴 ${settled.toFixed(2)} / 최대 ${maxDrift.toFixed(2)})`,
  )

  // 시점 전환
  await page.evaluate(() => window.__game.views[0].setMode('first'))
  await page.waitForTimeout(400)
  check('1인칭 전환', await page.evaluate(() => window.__game.views[0].camera.mode === 'first'))
  await page.screenshot({ path: join(SHOTS, '01-first-person.png') })

  await page.evaluate(() => window.__game.views[0].setMode('third'))
  await page.waitForTimeout(400)
  check('3인칭 전환', await page.evaluate(() => window.__game.views[0].camera.mode === 'third'))
  await page.screenshot({ path: join(SHOTS, '02-third-person.png') })

  // 미니맵이 실제로 그려졌는지
  const minimapDrawn = await page.evaluate(() => {
    const canvas = document.querySelector('.hud__minimap canvas')
    const ctx = canvas.getContext('2d')
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data
    const unique = new Set()
    for (let i = 0; i < data.length; i += 4 * 131) unique.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
    return unique.size
  })
  check('미니맵이 그려짐', minimapDrawn > 2, `(색상 ${minimapDrawn}종)`)

  check('콘솔 에러 없음', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await page.close()

  console.log('\n[2] 4분할 멀티뷰')
  const quad = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const quadErrors = []
  quad.on('pageerror', (error) => quadErrors.push(String(error)))
  await quad.goto(`http://localhost:${PORT}/?views=4&lat=120&jitter=30&loss=0.03`, { waitUntil: 'load' })

  await quad.waitForFunction(() => window.__game?.host()?.playerCount() === 4, null, { timeout: 30000 })
  check('클라이언트 4명이 한 방에 접속', true)

  await quad.waitForFunction(
    () => window.__game.views.every((v) => v.state.maze != null && v.state.renderPlayers().length === 4),
    null,
    { timeout: 30000 },
  )
  check('모든 화면이 미로를 만들고 4명을 인식', true)

  const sameMaze = await quad.evaluate(() => {
    const seeds = window.__game.views.map((v) => v.state.seed)
    const cells = window.__game.views.map((v) => v.state.maze.cells.join(','))
    return seeds.every((s) => s === seeds[0]) && cells.every((c) => c === cells[0])
  })
  check('4명 모두 같은 시드에서 같은 미로 생성', sameMaze)

  // 120ms 지연 + 3% 손실 상태에서 조작해도 예측 보정이 결국 수렴하는지 본다.
  //
  // 이동 "중"의 오차 크기로 판정하지 않는 이유가 있다. 이 컨테이너에는 GPU 가 없어
  // 소프트웨어 WebGL 컨텍스트 4개를 동시에 돌리면 1~2fps 까지 떨어지고, 렌더 루프가
  // dt 를 0.1초로 잘라내기 때문에 클라이언트 예측이 실시간으로 도는 호스트를
  // 따라가지 못한다. 실제 기기(30fps 이상)에서는 이 클램프가 걸리지 않지만,
  // 여기서 그 값을 재면 게임이 아니라 컨테이너 성능을 재는 셈이 된다.
  //
  // 프레임레이트와 무관하게 성립해야 하는 진짜 속성은 "입력이 멈추면 예측과 권위
  // 위치가 한곳으로 모인다"는 것이다. 이건 보정 로직이 깨지면 바로 실패한다.
  await quad.keyboard.down('w')
  await quad.waitForTimeout(1200)
  await quad.keyboard.up('w')
  await quad.waitForTimeout(2500)

  const driftAfterStop = await quad.evaluate(() => {
    const view = window.__game.views[0]
    const authoritative = window.__game.host().state.players.get(view.state.playerId)
    return Math.hypot(view.state.predicted.x - authoritative.x, view.state.predicted.z - authoritative.z)
  })
  check(
    '지연 120ms/손실 3% 에서 입력이 멈추면 예측이 권위 위치로 수렴',
    driftAfterStop < 0.8,
    `(잔여 오차 ${driftAfterStop.toFixed(2)})`,
  )

  await quad.screenshot({ path: join(SHOTS, '03-quad-view.png') })
  check('4분할 콘솔 에러 없음', quadErrors.length === 0, quadErrors.slice(0, 3).join(' | '))
  await quad.close()
  console.log('\n[3] Gamepad API 가 막힌 환경 (Artifact 뷰어 재현)')
  // Artifact 뷰어처럼 샌드박스된 iframe 에서는 permissions policy 로 gamepad 가 막힌다.
  // Babylon 이 초기화 중 navigator.getGamepads() 를 부르다 예외를 맞으면
  // 엔진 생성이 실패하고 화면이 통째로 뜨지 않는다. 실제로 겪은 버그라 고정해 둔다.
  const blocked = await browser.newPage({ viewport: { width: 1024, height: 720 } })
  const blockedErrors = []
  blocked.on('pageerror', (error) => blockedErrors.push(String(error)))
  await blocked.addInitScript(() => {
    Object.defineProperty(navigator, 'getGamepads', {
      configurable: true,
      value: () => {
        throw new Error(
          `Failed to execute 'getGamepads' on 'Navigator': ` +
            `Access to the feature "gamepad" is disallowed by permissions policy.`,
        )
      },
    })
  })
  await blocked.goto(`http://localhost:${PORT}/?views=1`, { waitUntil: 'load' })

  let blockedBooted = true
  try {
    await blocked.waitForFunction(() => window.__game?.views?.[0]?.state?.maze != null, null, {
      timeout: 20000,
    })
  } catch {
    blockedBooted = false
  }
  const bootBanner = await blocked.evaluate(
    () => document.querySelector('.boot-banner--error')?.textContent ?? null,
  )
  check('gamepad 차단 환경에서도 정상 부팅', blockedBooted && bootBanner === null, bootBanner ?? '')
  check('gamepad 차단 환경에서 페이지 예외 없음', blockedErrors.length === 0, blockedErrors.slice(0, 2).join(' | '))
  await blocked.screenshot({ path: join(SHOTS, '05-gamepad-blocked.png') })
  await blocked.close()
  console.log('\n[4] Pointer Lock 이 막힌 환경 — 드래그로 시점 회전')
  // Artifact 뷰어처럼 샌드박스된 iframe 은 permissions policy 로 pointer-lock 도 막는다.
  // 그러면 requestPointerLock() 이 거부되고, movementX 기반 시점 회전이 통째로 죽는다.
  // 이때 클릭 드래그로 시점이 돌아가야 한다.
  const noLock = await browser.newPage({ viewport: { width: 1024, height: 720 } })
  const noLockErrors = []
  noLock.on('pageerror', (error) => noLockErrors.push(String(error)))
  await noLock.addInitScript(() => {
    // 실제 차단 환경과 같게: 호출은 거부되고 pointerLockElement 는 계속 null 이다.
    Object.defineProperty(HTMLCanvasElement.prototype, 'requestPointerLock', {
      configurable: true,
      value() {
        return Promise.reject(new Error('pointer lock is disallowed by permissions policy'))
      },
    })
  })
  await noLock.goto(`http://localhost:${PORT}/?views=1`, { waitUntil: 'load' })
  await noLock.waitForFunction(() => window.__game?.views?.[0]?.state?.maze != null, null, {
    timeout: 20000,
  })

  const box = await noLock.locator('.view__scene').boundingBox()
  const centerX = box.x + box.width / 2
  const centerY = box.y + box.height / 2

  const yawBefore = await noLock.evaluate(() => window.__game.views[0].camera.yaw)

  // 드래그하지 않고 마우스만 움직였을 때는 시점이 돌아가면 안 된다.
  await noLock.mouse.move(centerX, centerY)
  await noLock.mouse.move(centerX + 200, centerY)
  await noLock.waitForTimeout(300)
  const yawHover = await noLock.evaluate(() => window.__game.views[0].camera.yaw)
  check('버튼을 누르지 않은 이동은 시점을 돌리지 않음', Math.abs(yawHover - yawBefore) < 1e-6)

  // 누른 채 끌면 돌아가야 한다.
  await noLock.mouse.move(centerX, centerY)
  await noLock.mouse.down()
  for (let i = 1; i <= 8; i++) {
    await noLock.mouse.move(centerX + i * 25, centerY + i * 4)
  }
  await noLock.mouse.up()
  await noLock.waitForTimeout(300)

  const afterDrag = await noLock.evaluate(() => ({
    yaw: window.__game.views[0].camera.yaw,
    pitch: window.__game.views[0].camera.pitch,
    hint: document.querySelector('.hud__center')?.textContent ?? '',
  }))
  const yawDelta = Math.abs(afterDrag.yaw - yawHover)
  check('드래그로 좌우 시점이 회전함', yawDelta > 0.3, `(yaw 변화 ${yawDelta.toFixed(2)})`)
  check('드래그 안내 문구가 표시됨', afterDrag.hint.includes('드래그'), `(문구: "${afterDrag.hint}")`)

  // 키보드 대안(Q/E)도 동작해야 한다.
  const yawBeforeKey = afterDrag.yaw
  await noLock.keyboard.down('e')
  await noLock.waitForTimeout(500)
  await noLock.keyboard.up('e')
  const yawAfterKey = await noLock.evaluate(() => window.__game.views[0].camera.yaw)
  check('Q/E 키로도 시점이 회전함', Math.abs(yawAfterKey - yawBeforeKey) > 0.2,
    `(yaw 변화 ${Math.abs(yawAfterKey - yawBeforeKey).toFixed(2)})`)

  check('pointer lock 차단 환경에서 예외 없음', noLockErrors.length === 0, noLockErrors.slice(0, 2).join(' | '))
  await noLock.screenshot({ path: join(SHOTS, '06-drag-look.png') })
  await noLock.close()
} finally {
  await browser.close()
  server.close()
}

console.log('')
if (failures.length > 0) {
  console.error(`실패 ${failures.length}건: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`전부 통과. 스크린샷: ${SHOTS}`)
