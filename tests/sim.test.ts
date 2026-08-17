import { describe, expect, it } from 'vitest'
import { CELL, INTERACT_R, PLAYER_R, TICK_DT } from '../src/shared/constants'
import type { RunConfig } from '../src/shared/config'
import { ITEMS, ItemId, hasItem, moveSpeedFor } from '../src/shared/items'
import { cellToWorld } from '../src/shared/maze'
import {
  LOBBY_ENTRANCE_CELL,
  LOBBY_SHOP_CELL,
  STARTING_GOLD,
  addPlayer,
  buyItem,
  createRunState,
  enterDungeon,
  removePlayer,
  stepGame,
  type GameState,
  type PlayerInput,
} from '../src/shared/sim'

const CONFIG: RunConfig = {
  levels: [
    { width: 15, height: 15, roomCount: 2, keyCount: 1 },
    { width: 19, height: 19, roomCount: 3, keyCount: 2 },
  ],
}

function input(dx: number, dz: number, tick = 1, interact = false): PlayerInput {
  return { tick, dx, dz, yaw: 0, interact }
}

/** 로비를 건너뛰고 던전 1층에서 시작하는 상태를 만든다. */
function dungeonState(config = CONFIG, seed = 2024): GameState {
  const lobby = createRunState(config, seed)
  addPlayer(lobby, 1, 'A')
  return enterDungeon(lobby)
}

describe('로비', () => {
  it('시작하면 로비에 있고 열쇠도 탈출구도 없다', () => {
    const state = createRunState(CONFIG, 1)
    expect(state.zone).toBe('lobby')
    expect(state.levelIndex).toBe(-1)
    expect(state.keys).toHaveLength(0)
    expect(state.shopCell).not.toBeNull()
    expect(state.entranceCell).not.toBeNull()
  })

  it('로비에는 벽이 없어 어디로든 걸어갈 수 있다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const start = { x: player.x, z: player.z }

    const inputs = new Map([[1, input(1, 0)]])
    for (let i = 0; i < 40; i++) stepGame(state, inputs)

    // 벽에 막히지 않고 실제로 이동해야 한다.
    expect(player.x - start.x).toBeGreaterThan(3)
  })

  it('던전 구멍 앞에서 F 를 누르면 1층으로 들어간다', () => {
    const state = createRunState(CONFIG, 7)
    const player = addPlayer(state, 1, 'A')
    const entrance = cellToWorld(LOBBY_ENTRANCE_CELL)
    player.x = entrance.x
    player.z = entrance.z

    expect(stepGame(state, new Map([[1, input(0, 0, 1, false)]]))).toBeNull()
    const next = stepGame(state, new Map([[1, input(0, 0, 2, true)]]))

    expect(next).not.toBeNull()
    expect(next!.zone).toBe('dungeon')
    expect(next!.levelIndex).toBe(0)
    expect(next!.maze.w).toBe(15)
  })

  it('구멍에서 멀면 F 를 눌러도 들어가지지 않는다', () => {
    const state = createRunState(CONFIG, 7)
    const player = addPlayer(state, 1, 'A')
    const entrance = cellToWorld(LOBBY_ENTRANCE_CELL)
    player.x = entrance.x + INTERACT_R + CELL
    player.z = entrance.z + INTERACT_R + CELL

    expect(stepGame(state, new Map([[1, input(0, 0, 1, true)]]))).toBeNull()
  })

  it('F 를 누르고 있어도 존 전환은 한 번만 발동한다', () => {
    // 누르고 있는 동안 매 틱 발동하면 다음 존에서 바로 또 넘어가버린다.
    const state = createRunState(CONFIG, 7)
    const player = addPlayer(state, 1, 'A')
    const entrance = cellToWorld(LOBBY_ENTRANCE_CELL)
    player.x = entrance.x
    player.z = entrance.z

    const dungeon = stepGame(state, new Map([[1, input(0, 0, 1, true)]]))!
    expect(dungeon.zone).toBe('dungeon')

    // 계속 누르고 있는 상태로 몇 틱 더 진행해도 레벨이 넘어가면 안 된다.
    for (let i = 0; i < 5; i++) {
      expect(stepGame(dungeon, new Map([[1, input(0, 0, 2 + i, true)]]))).toBeNull()
    }
    expect(dungeon.levelIndex).toBe(0)
  })
})

describe('설정 기반 레벨', () => {
  it('설정한 크기 · 방 개수 · 열쇠 개수가 그대로 반영된다', () => {
    const config: RunConfig = {
      levels: [{ width: 21, height: 13, roomCount: 3, keyCount: 4 }],
    }
    const state = dungeonState(config, 99)
    expect(state.maze.w).toBe(21)
    expect(state.maze.h).toBe(13)
    expect(state.maze.rooms).toHaveLength(3)
    expect(state.keys).toHaveLength(4)
  })

  it('마지막 레벨을 깨면 로비로 돌아온다', () => {
    const config: RunConfig = { levels: [{ width: 15, height: 15, roomCount: 1, keyCount: 1 }] }
    const state = dungeonState(config, 5)
    const player = state.players.get(1)!

    player.x = state.keys[0].x
    player.z = state.keys[0].z
    stepGame(state, new Map())
    const exit = cellToWorld(state.maze.exit)
    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())
    expect(state.phase).toBe('cleared')

    let next: GameState | null = null
    while (!next) next = stepGame(state, new Map())
    expect(next.zone).toBe('lobby')
  })

  it('레벨이 여러 개면 다음 층으로 이어진다', () => {
    const state = dungeonState(CONFIG, 5)
    const player = state.players.get(1)!

    for (const key of state.keys) {
      player.x = key.x
      player.z = key.z
      stepGame(state, new Map())
    }
    const exit = cellToWorld(state.maze.exit)
    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())

    let next: GameState | null = null
    while (!next) next = stepGame(state, new Map())
    expect(next.zone).toBe('dungeon')
    expect(next.levelIndex).toBe(1)
    expect(next.maze.w).toBe(19)
    expect(next.keys).toHaveLength(2)
  })
})

describe('시뮬레이션', () => {
  it('플레이어는 벽을 통과하지 못한다', () => {
    const state = dungeonState(CONFIG, 1234)
    const player = state.players.get(1)!
    // 스폰 셀 (0,0) 의 북쪽과 서쪽은 항상 바깥 경계라 반드시 막혀 있다.
    const inputs = new Map([[1, input(-1, -1)]])
    for (let i = 0; i < 200; i++) stepGame(state, inputs)

    expect(player.z).toBeGreaterThan(PLAYER_R * 0.5)
    expect(player.x).toBeGreaterThan(PLAYER_R * 0.5)
  })

  it('아무리 움직여도 미로 밖으로 나가지 않는다', () => {
    const state = dungeonState(CONFIG, 55)
    const player = state.players.get(1)!
    const bound = state.maze.w * CELL

    for (let i = 0; i < 400; i++) {
      const angle = (i / 400) * Math.PI * 8
      stepGame(state, new Map([[1, input(Math.cos(angle), Math.sin(angle), i + 1)]]))
      expect(player.x).toBeGreaterThan(0)
      expect(player.z).toBeGreaterThan(0)
      expect(player.x).toBeLessThan(bound)
      expect(player.z).toBeLessThan(bound)
    }
  })

  it('열쇠를 다 모아야 탈출구가 열린다', () => {
    const config: RunConfig = { levels: [{ width: 19, height: 19, roomCount: 2, keyCount: 3 }] }
    const state = dungeonState(config, 2024)
    const player = state.players.get(1)!
    expect(state.keys).toHaveLength(3)

    for (let i = 0; i < state.keys.length; i++) {
      expect(state.exitOpen).toBe(false)
      player.x = state.keys[i].x
      player.z = state.keys[i].z
      stepGame(state, new Map())
    }
    expect(state.exitOpen).toBe(true)
  })

  it('열쇠 없이 탈출구에 가도 탈출할 수 없다', () => {
    const state = dungeonState(CONFIG, 2024)
    const player = state.players.get(1)!
    const exit = cellToWorld(state.maze.exit)

    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())

    expect(player.escaped).toBe(false)
    expect(state.phase).toBe('playing')
  })

  it('전원이 탈출해야 클리어된다', () => {
    const state = dungeonState(CONFIG, 2024)
    const a = state.players.get(1)!
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
    expect(state.phase).toBe('playing')

    b.x = exit.x
    b.z = exit.z
    stepGame(state, new Map())
    expect(b.escaped).toBe(true)
    expect(state.phase).toBe('cleared')
  })

  it('열쇠를 든 플레이어가 나가면 그 자리에 떨어뜨린다', () => {
    const state = dungeonState(CONFIG, 909)
    const player = state.players.get(1)!
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
    const state = dungeonState(CONFIG, 11)
    removePlayer(state, 1)
    state.exitOpen = true
    stepGame(state, new Map())
    expect(state.phase).toBe('playing')
  })
})

describe('재화와 상점', () => {
  it('접속하면 시작 골드를 받는다', () => {
    const state = createRunState(CONFIG, 1)
    expect(addPlayer(state, 1, 'A').gold).toBe(STARTING_GOLD)
  })

  it('상점 앞에서 아이템을 사면 골드가 줄고 인벤토리에 들어간다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const shop = cellToWorld(LOBBY_SHOP_CELL)
    player.x = shop.x
    player.z = shop.z

    const boots = ITEMS.find((i) => i.id === ItemId.SwiftBoots)!
    expect(buyItem(state, 1, ItemId.SwiftBoots)).toBe(true)
    expect(player.gold).toBe(STARTING_GOLD - boots.price)
    expect(hasItem(player.inventory, ItemId.SwiftBoots)).toBe(true)
  })

  it('상점에서 멀면 살 수 없다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const shop = cellToWorld(LOBBY_SHOP_CELL)
    player.x = shop.x + INTERACT_R + CELL
    player.z = shop.z + INTERACT_R + CELL

    expect(buyItem(state, 1, ItemId.SwiftBoots)).toBe(false)
    expect(player.gold).toBe(STARTING_GOLD)
  })

  it('골드가 모자라면 살 수 없다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const shop = cellToWorld(LOBBY_SHOP_CELL)
    player.x = shop.x
    player.z = shop.z
    player.gold = 0

    expect(buyItem(state, 1, ItemId.Compass)).toBe(false)
    expect(hasItem(player.inventory, ItemId.Compass)).toBe(false)
  })

  it('같은 아이템을 두 번 사지 못한다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const shop = cellToWorld(LOBBY_SHOP_CELL)
    player.x = shop.x
    player.z = shop.z

    expect(buyItem(state, 1, ItemId.KeySense)).toBe(true)
    const goldAfterFirst = player.gold
    expect(buyItem(state, 1, ItemId.KeySense)).toBe(false)
    expect(player.gold).toBe(goldAfterFirst)
  })

  it('던전 안에서는 살 수 없다', () => {
    const state = dungeonState(CONFIG, 1)
    expect(buyItem(state, 1, ItemId.KeySense)).toBe(false)
  })

  it('레벨을 깨면 골드를 받는다', () => {
    const state = dungeonState(CONFIG, 5)
    const player = state.players.get(1)!
    const before = player.gold

    player.x = state.keys[0].x
    player.z = state.keys[0].z
    stepGame(state, new Map())
    const exit = cellToWorld(state.maze.exit)
    player.x = exit.x
    player.z = exit.z
    stepGame(state, new Map())

    expect(state.phase).toBe('cleared')
    expect(player.gold).toBeGreaterThan(before)
  })

  it('존이 바뀌어도 골드와 아이템은 유지된다', () => {
    const state = createRunState(CONFIG, 1)
    const player = addPlayer(state, 1, 'A')
    const shop = cellToWorld(LOBBY_SHOP_CELL)
    player.x = shop.x
    player.z = shop.z
    buyItem(state, 1, ItemId.Lantern)
    const gold = player.gold
    const inventory = player.inventory

    const dungeon = enterDungeon(state)
    const moved = dungeon.players.get(1)!
    expect(moved.gold).toBe(gold)
    expect(moved.inventory).toBe(inventory)
  })

  it('신속의 장화를 신으면 실제로 더 빨리 움직인다', () => {
    // 효과가 상수로만 존재하고 시뮬레이션에 반영되지 않으면 의미가 없다.
    const withBoots = moveSpeedFor(1 << ItemId.SwiftBoots)
    const without = moveSpeedFor(0)
    expect(withBoots).toBeGreaterThan(without)

    const state = dungeonState(CONFIG, 77)
    const player = state.players.get(1)!
    player.inventory = 1 << ItemId.SwiftBoots
    const startX = player.x
    stepGame(state, new Map([[1, input(1, 0)]]), TICK_DT)
    const fast = player.x - startX

    const plain = dungeonState(CONFIG, 77)
    const plainPlayer = plain.players.get(1)!
    const plainStart = plainPlayer.x
    stepGame(plain, new Map([[1, input(1, 0)]]), TICK_DT)
    expect(fast).toBeGreaterThan(plainPlayer.x - plainStart)
  })
})
