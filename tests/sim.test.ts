import { describe, expect, it } from 'vitest'
import { CELL, PLAYER_R, TICK_DT, mazeSizeForLevel } from '../src/shared/constants'
import { cellToWorld } from '../src/shared/maze'
import {
  addPlayer,
  createGameState,
  removePlayer,
  stepGame,
  type PlayerInput,
} from '../src/shared/sim'

function input(dx: number, dz: number, tick = 1): PlayerInput {
  return { tick, dx, dz, yaw: 0 }
}

function run(state: ReturnType<typeof createGameState>, inputs: Map<number, PlayerInput>, ticks: number) {
  let current = state
  for (let i = 0; i < ticks; i++) {
    const replaced = stepGame(current, inputs)
    if (replaced) current = replaced
  }
  return current
}

describe('시뮬레이션', () => {
  it('레벨이 오를수록 미로가 커지고 상한에서 멈춘다', () => {
    expect(mazeSizeForLevel(1)).toBe(15)
    expect(mazeSizeForLevel(2)).toBe(19)
    expect(mazeSizeForLevel(100)).toBe(41)
  })

  it('플레이어는 벽을 통과하지 못한다', () => {
    const state = createGameState(1, 1234)
    const player = addPlayer(state, 1, 'A')
    // 스폰 셀 (0,0) 의 북쪽과 서쪽은 항상 바깥 경계라 반드시 막혀 있다.
    const inputs = new Map([[1, input(-1, -1)]])
    run(state, inputs, 200)

    expect(player.z).toBeGreaterThan(PLAYER_R * 0.5)
    expect(player.x).toBeGreaterThan(PLAYER_R * 0.5)
  })

  it('아무리 움직여도 미로 밖으로 나가지 않는다', () => {
    const state = createGameState(1, 55)
    const player = addPlayer(state, 1, 'A')
    const bound = state.maze.w * CELL

    // 방향을 계속 바꿔가며 구석구석 밀어붙인다.
    for (let i = 0; i < 400; i++) {
      const angle = (i / 400) * Math.PI * 8
      const inputs = new Map([[1, input(Math.cos(angle), Math.sin(angle), i + 1)]])
      stepGame(state, inputs)
      expect(player.x).toBeGreaterThan(0)
      expect(player.z).toBeGreaterThan(0)
      expect(player.x).toBeLessThan(bound)
      expect(player.z).toBeLessThan(bound)
    }
  })

  it('열쇠를 주우면 탈출구가 열린다', () => {
    const state = createGameState(1, 2024)
    const player = addPlayer(state, 1, 'A')

    expect(state.exitOpen).toBe(false)

    // 열쇠 위로 직접 옮겨놓고 한 틱 진행한다.
    player.x = state.keys[0].x
    player.z = state.keys[0].z
    stepGame(state, new Map())

    expect(state.keys[0].collected).toBe(true)
    expect(state.keys[0].carrier).toBe(1)
    expect(state.exitOpen).toBe(true)
  })

  it('열쇠 없이 탈출구에 가도 탈출할 수 없다', () => {
    const state = createGameState(1, 2024)
    const player = addPlayer(state, 1, 'A')
    const exit = cellToWorld(state.maze.exit)

    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())

    expect(player.escaped).toBe(false)
    expect(state.phase).toBe('playing')
  })

  it('전원이 탈출해야 클리어된다', () => {
    const state = createGameState(1, 2024)
    const a = addPlayer(state, 1, 'A')
    const b = addPlayer(state, 2, 'B')
    const exit = cellToWorld(state.maze.exit)

    a.x = state.keys[0].x
    a.z = state.keys[0].z
    stepGame(state, new Map())
    expect(state.exitOpen).toBe(true)

    a.x = exit.x
    a.z = exit.z
    stepGame(state, new Map())
    expect(a.escaped).toBe(true)
    // 아직 B 가 남아 있다.
    expect(state.phase).toBe('playing')

    b.x = exit.x
    b.z = exit.z
    stepGame(state, new Map())
    expect(b.escaped).toBe(true)
    expect(state.phase).toBe('cleared')
  })

  it('클리어 후 다음 레벨로 넘어가면서 미로가 커진다', () => {
    const state = createGameState(1, 2024)
    const player = addPlayer(state, 1, 'A')
    const exit = cellToWorld(state.maze.exit)

    player.x = state.keys[0].x
    player.z = state.keys[0].z
    stepGame(state, new Map())
    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())
    expect(state.phase).toBe('cleared')

    // CLEAR_HOLD_SEC 만큼 흐르면 새 상태가 반환된다.
    let next: ReturnType<typeof stepGame> = null
    for (let i = 0; i < Math.ceil(3 / TICK_DT) + 2 && !next; i++) {
      next = stepGame(state, new Map())
    }

    expect(next).not.toBeNull()
    expect(next!.level).toBe(2)
    expect(next!.maze.w).toBe(mazeSizeForLevel(2))
    expect(next!.players.get(1)?.escaped).toBe(false)
    expect(next!.seed).not.toBe(state.seed)
  })

  it('같은 시드에서 파생되는 다음 레벨 시드는 결정론적이다', () => {
    // 늦게 들어온 사람도 같은 미로를 만들 수 있어야 한다.
    const makeCleared = () => {
      const state = createGameState(1, 4242)
      const player = addPlayer(state, 1, 'A')
      const exit = cellToWorld(state.maze.exit)
      player.x = state.keys[0].x
      player.z = state.keys[0].z
      stepGame(state, new Map())
      player.x = exit.x
      player.z = exit.z
      stepGame(state, new Map())
      let next: ReturnType<typeof stepGame> = null
      while (!next) next = stepGame(state, new Map())
      return next
    }

    expect(makeCleared().seed).toBe(makeCleared().seed)
  })

  it('열쇠를 든 플레이어가 나가면 그 자리에 열쇠가 떨어진다', () => {
    // 안 그러면 열쇠가 사라져 아무도 탈출할 수 없게 된다.
    const state = createGameState(1, 909)
    const player = addPlayer(state, 1, 'A')
    addPlayer(state, 2, 'B')

    player.x = state.keys[0].x
    player.z = state.keys[0].z
    stepGame(state, new Map())
    expect(state.exitOpen).toBe(true)

    const dropX = player.x
    removePlayer(state, 1)
    stepGame(state, new Map())

    expect(state.keys[0].collected).toBe(false)
    expect(state.keys[0].carrier).toBe(-1)
    expect(state.keys[0].x).toBeCloseTo(dropX, 5)
    expect(state.exitOpen).toBe(false)
  })

  it('아무도 없는 방은 클리어되지 않는다', () => {
    const state = createGameState(1, 11)
    state.exitOpen = true
    stepGame(state, new Map())
    expect(state.phase).toBe('playing')
  })
})
