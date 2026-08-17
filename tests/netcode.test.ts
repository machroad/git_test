/**
 * 네트코드 통합 테스트.
 *
 * 브라우저 없이 실제 GameHost + GameClientState 를 InProcessHub 로 연결한다.
 * 렌더링만 빠졌을 뿐 클라이언트가 하는 일(참가, 예측, 보간, 보정)이 전부 돈다.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { TICK_DT } from '../src/shared/constants'
import type { RunConfig } from '../src/shared/config'
import { LOBBY_ENTRANCE_CELL } from '../src/shared/sim'
import { cellToWorld } from '../src/shared/maze'

const TEST_CONFIG: RunConfig = {
  levels: [{ width: 15, height: 15, roomCount: 2, keyCount: 2 }],
}
import { GameHost } from '../src/game/host'
import { GameClientState } from '../src/game/client-state'
import { InProcessHub } from '../src/net/in-process'

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let cleanup: (() => void)[] = []

afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

function makeRoom(clientCount: number, net = { latencyMs: 0, jitterMs: 0, loss: 0 }) {
  const hub = new InProcessHub(net)
  const host = new GameHost(hub.createHostTransport(), { seed: 777, config: TEST_CONFIG })
  host.start()

  const clients = Array.from({ length: clientCount }, () => new GameClientState(hub.createClientTransport()))

  cleanup.push(() => {
    host.stop()
    hub.close()
  })

  return { hub, host, clients }
}

/** 클라이언트가 ms 밀리초 동안 주어진 방향으로 이동하도록 입력을 흘려보낸다. */
async function drive(client: GameClientState, dx: number, dz: number, ms: number) {
  const stepMs = 25
  client.setInput(dx, dz, 0)
  for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
    client.update(stepMs / 1000)
    await wait(stepMs)
  }
  client.setInput(0, 0, 0)
}

describe('네트코드', () => {
  it('접속하면 playerId 와 미로를 받는다', async () => {
    const { clients } = makeRoom(1)
    await wait(150)

    expect(clients[0].connected).toBe(true)
    expect(clients[0].playerId).toBe(1)
    expect(clients[0].maze).not.toBeNull()
    // 처음에는 로비다.
    expect(clients[0].zone).toBe('lobby')
  })

  it('호스트의 런 설정을 그대로 받는다', async () => {
    const { clients } = makeRoom(1)
    await wait(150)
    expect(clients[0].config.levels[0]).toEqual(TEST_CONFIG.levels[0])
  })

  it('던전에 들어가면 설정대로 미로가 만들어지고 모두가 같은 것을 본다', async () => {
    const { host, clients } = makeRoom(2)
    await wait(200)

    // 호스트 쪽에서 플레이어를 입구로 옮기고 F 입력을 흘려보낸다.
    const entrance = cellToWorld(LOBBY_ENTRANCE_CELL)
    for (const player of host.state.players.values()) {
      player.x = entrance.x
      player.z = entrance.z
    }
    clients[0].setInput(0, 0, 0, true)
    for (let i = 0; i < 4; i++) {
      clients[0].update(TICK_DT)
      await wait(60)
    }
    clients[0].setInput(0, 0, 0, false)
    await wait(250)

    expect(host.state.zone).toBe('dungeon')
    for (const client of clients) {
      expect(client.zone).toBe('dungeon')
      expect(client.maze!.w).toBe(15)
      expect(client.maze!.keys).toHaveLength(2)
    }
    expect(Array.from(clients[0].maze!.cells)).toEqual(Array.from(clients[1].maze!.cells))
  })

  it('모든 클라이언트가 시드로부터 같은 미로를 만든다', async () => {
    // 미로를 네트워크로 보내지 않는다는 설계가 실제로 성립하는지 확인한다.
    const { clients } = makeRoom(3)
    await wait(200)

    const [a, b, c] = clients.map((client) => Array.from(client.maze!.cells))
    expect(a.length).toBeGreaterThan(0)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
  })

  it('한 클라이언트의 움직임이 다른 클라이언트에게 보인다', async () => {
    const { clients } = makeRoom(2)
    await wait(150)

    const observer = clients[1]
    const before = observer.renderPlayers().find((p) => p.id === 1)
    expect(before).toBeDefined()

    await drive(clients[0], 1, 0, 400)
    await wait(120)
    observer.update(0.016)

    const after = observer.renderPlayers().find((p) => p.id === 1)
    expect(after).toBeDefined()
    expect(Math.hypot(after!.x - before!.x, after!.z - before!.z)).toBeGreaterThan(0.5)
  })

  it('지연이 있어도 로컬 캐릭터는 즉시 움직인다', async () => {
    // 예측이 동작하지 않으면 입력 후 왕복 지연만큼 캐릭터가 멈춰 있다.
    const { clients } = makeRoom(1, { latencyMs: 150, jitterMs: 0, loss: 0 })
    await wait(400)

    const client = clients[0]
    const startX = client.predicted.x
    client.setInput(1, 0, 0)
    // 고정 스텝 한 번 분량. 호스트 응답을 기다리지 않고 그 자리에서 움직여야 한다.
    client.update(TICK_DT)

    expect(client.predicted.x).toBeGreaterThan(startX)
  })

  it('예측 위치가 호스트 권위 위치에서 크게 벗어나지 않는다', async () => {
    const { host, clients } = makeRoom(1, { latencyMs: 80, jitterMs: 20, loss: 0.05 })
    await wait(300)

    await drive(clients[0], 1, 0.35, 900)
    await wait(200)

    const authoritative = host.state.players.get(1)!
    const drift = Math.hypot(
      clients[0].predicted.x - authoritative.x,
      clients[0].predicted.z - authoritative.z,
    )
    // 예측이 호스트보다 앞서 있는 건 정상이지만, 그 차이는 전송 지연 + 한 틱 수준이어야 한다.
    expect(drift).toBeLessThan(1.0)
  })

  it('unreliable 패킷이 전부 유실돼도 참가 절차는 성립한다', async () => {
    // 스냅샷은 하나도 못 받지만 Welcome 은 reliable 이라 도착해야 한다.
    const { clients } = makeRoom(1, { latencyMs: 0, jitterMs: 0, loss: 1 })
    await wait(250)

    expect(clients[0].connected).toBe(true)
    expect(clients[0].maze).not.toBeNull()
    expect(clients[0].renderPlayers()).toHaveLength(0)
  })

  it('클라이언트가 나가면 호스트에서 플레이어가 제거된다', async () => {
    const { host, clients } = makeRoom(2)
    await wait(200)
    expect(host.playerCount()).toBe(2)

    clients[1].dispose()
    await wait(150)

    expect(host.playerCount()).toBe(1)
  })

  it('정원을 넘는 접속은 게임에 들어오지 못한다', async () => {
    const { host } = makeRoom(6)
    await wait(250)
    expect(host.playerCount()).toBe(4)
  })

  it('탐사한 칸이 팀 전체 위치로 채워진다', async () => {
    const { clients } = makeRoom(2)
    await wait(200)

    await drive(clients[1], 1, 0, 400)
    await wait(120)

    for (let i = 0; i < 5; i++) clients[0].update(0.016)
    // 자기 자신 + 팀원이 지나간 칸이 함께 열린다.
    expect(clients[0].explored.size).toBeGreaterThan(0)
  })
})
