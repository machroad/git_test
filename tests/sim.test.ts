import { describe, expect, it } from 'vitest'
import { CELL, INTERACT_R, PLAYER_R, TICK_DT } from '../src/shared/constants'
import type { RunConfig } from '../src/shared/config'
import { ITEMS, ItemId, hasItem, moveSpeedFor } from '../src/shared/items'
import {
  EXHAUST_STUN_SEC,
  ENEMY_DEFS,
  EnemyKind,
  PLAYER_MAX_HP,
  PLAYER_MAX_STAMINA,
  type EnemyKindValue,
} from '../src/shared/combat'
import { cellToWorld } from '../src/shared/maze'
import {
  LOBBY_ENTRANCE_CELL,
  LOBBY_SHOP_CELL,
  STARTING_GOLD,
  addPlayer,
  buyItem,
  createRunState,
  damagePlayer,
  enterDungeon,
  removePlayer,
  stepGame,
  type EnemyState,
  type GameState,
  type PlayerInput,
} from '../src/shared/sim'

/** 테스트용 적 하나. 배치 로직을 거치지 않고 원하는 자리에 바로 놓는다. */
function makeEnemy(kind: EnemyKindValue, x: number, z: number): EnemyState {
  return {
    id: 1,
    kind,
    x,
    z,
    yaw: 0,
    hp: ENEMY_DEFS[kind].maxHp,
    windup: 0,
    cooldown: 0,
    target: -1,
    hitFlash: 0,
  }
}

const CONFIG: RunConfig = {
  levels: [
    { width: 15, height: 15, roomCount: 2, keyCount: 1 },
    { width: 19, height: 19, roomCount: 3, keyCount: 2 },
  ],
}

function input(
  dx: number,
  dz: number,
  tick = 1,
  interact = false,
  extra: Partial<PlayerInput> = {},
): PlayerInput {
  return { tick, dx, dz, yaw: 0, interact, sprint: false, attack: false, ...extra }
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

describe('플레이어 스탯과 액션', () => {
  it('달리면 스태미나가 줄고 더 빨리 움직인다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    const startStamina = player.stamina
    const startX = player.x
    stepGame(state, new Map([[1, input(1, 0, 1, false, { sprint: true })]]))
    const sprintDistance = player.x - startX
    expect(player.stamina).toBeLessThan(startStamina)

    const plain = dungeonState(CONFIG, 31)
    const plainPlayer = plain.players.get(1)!
    const plainStart = plainPlayer.x
    stepGame(plain, new Map([[1, input(1, 0)]]))
    expect(sprintDistance).toBeGreaterThan(plainPlayer.x - plainStart)
    // 안 달리면 스태미나가 줄지 않는다.
    expect(plainPlayer.stamina).toBe(PLAYER_MAX_STAMINA)
  })

  it('제자리에서 Shift 만 눌러도 스태미나가 줄지 않는다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    for (let i = 0; i < 20; i++) {
      stepGame(state, new Map([[1, input(0, 0, i + 1, false, { sprint: true })]]))
    }
    expect(player.stamina).toBe(PLAYER_MAX_STAMINA)
  })

  it('스태미나가 바닥나면 경직에 걸리고 그동안 못 움직인다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!

    // 스태미나가 0이 될 때까지 계속 달린다.
    let tick = 1
    while (player.stunTimer <= 0 && tick < 400) {
      stepGame(state, new Map([[1, input(1, 0, tick++, false, { sprint: true })]]))
    }
    expect(player.stunTimer).toBeGreaterThan(0)
    expect(player.stamina).toBe(0)

    // 경직 중에는 입력을 줘도 제자리다.
    const stuckX = player.x
    const stuckZ = player.z
    stepGame(state, new Map([[1, input(1, 0, tick++)]]))
    expect(player.x).toBe(stuckX)
    expect(player.z).toBe(stuckZ)
  })

  it('경직이 끝나면 스태미나가 다시 찬다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    player.stamina = 0
    player.stunTimer = EXHAUST_STUN_SEC

    for (let i = 0; i < 200 && player.stunTimer > 0; i++) {
      stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    }
    expect(player.stunTimer).toBe(0)
    expect(player.stamina).toBeGreaterThan(0)
  })

  it('가만히 있으면 스태미나가 회복된다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    player.stamina = 20

    for (let i = 0; i < 60; i++) stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    expect(player.stamina).toBeGreaterThan(20)
  })

  it('공격하면 스태미나를 쓰고 앞쪽 적에게 피해를 준다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    state.enemies = [makeEnemy(EnemyKind.Biter, player.x, player.z + 2)]
    player.yaw = 0 // +Z 를 본다
    const hpBefore = state.enemies[0].hp

    stepGame(state, new Map([[1, input(0, 0, 1, false, { attack: true })]]))

    expect(state.enemies[0].hp).toBeLessThan(hpBefore)
    expect(player.stamina).toBeLessThan(PLAYER_MAX_STAMINA)
  })

  it('뒤에 있는 적은 공격에 맞지 않는다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    state.enemies = [makeEnemy(EnemyKind.Biter, player.x, player.z - 2)]
    player.yaw = 0
    const hpBefore = state.enemies[0].hp

    stepGame(state, new Map([[1, input(0, 0, 1, false, { attack: true })]]))
    expect(state.enemies[0].hp).toBe(hpBefore)
  })

  it('공격 버튼을 누르고 있어도 연타되지 않는다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    state.enemies = [makeEnemy(EnemyKind.Brute, player.x, player.z + 2)]
    player.yaw = 0

    stepGame(state, new Map([[1, input(0, 0, 1, false, { attack: true })]]))
    const afterFirst = state.enemies[0].hp
    for (let i = 0; i < 5; i++) {
      stepGame(state, new Map([[1, input(0, 0, 2 + i, false, { attack: true })]]))
    }
    expect(state.enemies[0].hp).toBe(afterFirst)
  })

  it('적을 처치하면 골드를 얻는다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    const enemy = makeEnemy(EnemyKind.Biter, player.x, player.z + 2)
    enemy.hp = 1
    state.enemies = [enemy]
    player.yaw = 0
    const goldBefore = player.gold

    stepGame(state, new Map([[1, input(0, 0, 1, false, { attack: true })]]))
    expect(enemy.hp).toBe(0)
    expect(player.gold).toBeGreaterThan(goldBefore)
  })

  it('체력이 0이 되면 쓰러졌다가 부활한다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!

    damagePlayer(player, PLAYER_MAX_HP)
    expect(player.hp).toBe(0)
    expect(player.downTimer).toBeGreaterThan(0)

    for (let i = 0; i < 200 && player.downTimer > 0; i++) {
      stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    }
    expect(player.downTimer).toBe(0)
    expect(player.hp).toBeGreaterThan(0)
  })

  it('피격 직후에는 잠깐 무적이다', () => {
    // 없으면 적에게 둘러싸였을 때 한 틱에 여러 번 맞아 즉사한다.
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    expect(damagePlayer(player, 10)).toBe(true)
    expect(damagePlayer(player, 10)).toBe(false)
    expect(player.hp).toBe(PLAYER_MAX_HP - 10)
  })
})

describe('적', () => {
  it('방마다 보스가 하나씩 있고 통로에는 일반 몹이 흩어져 있다', () => {
    const state = dungeonState(CONFIG, 4242)
    const bosses = state.enemies.filter((e) => e.kind === EnemyKind.Boss)
    expect(bosses).toHaveLength(state.maze.rooms.length)
    expect(state.enemies.length).toBeGreaterThan(bosses.length)

    const kinds = new Set(state.enemies.map((e) => e.kind))
    // 세 종류의 일반 몹이 모두 나와야 한다.
    expect(kinds.has(EnemyKind.Biter)).toBe(true)
    expect(kinds.size).toBeGreaterThan(2)
  })

  it('스폰 근처에는 적이 없다', () => {
    // 시작하자마자 둘러싸이면 손쓸 방법이 없다.
    for (const seed of [1, 2, 3, 77]) {
      const state = dungeonState(CONFIG, seed)
      const spawn = cellToWorld(state.maze.spawn)
      for (const enemy of state.enemies) {
        expect(Math.hypot(enemy.x - spawn.x, enemy.z - spawn.z)).toBeGreaterThan(CELL * 2)
      }
    }
  })

  it('같은 시드는 같은 적 배치를 만든다', () => {
    const a = dungeonState(CONFIG, 555).enemies.map((e) => `${e.kind}:${e.x.toFixed(2)}:${e.z.toFixed(2)}`)
    const b = dungeonState(CONFIG, 555).enemies.map((e) => `${e.kind}:${e.x.toFixed(2)}:${e.z.toFixed(2)}`)
    expect(a).toEqual(b)
  })

  it('가까이 가면 쫓아온다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    const enemy = makeEnemy(EnemyKind.Biter, player.x, player.z + 5)
    state.enemies = [enemy]
    const before = Math.hypot(enemy.x - player.x, enemy.z - player.z)

    for (let i = 0; i < 10; i++) stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    expect(Math.hypot(enemy.x - player.x, enemy.z - player.z)).toBeLessThan(before)
  })

  it('근접 적은 붙으면 피해를 준다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    state.enemies = [makeEnemy(EnemyKind.Biter, player.x, player.z + 1.2)]

    for (let i = 0; i < 40 && player.hp === PLAYER_MAX_HP; i++) {
      stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    }
    expect(player.hp).toBeLessThan(PLAYER_MAX_HP)
  })

  it('원거리 적은 투사체를 쏜다', () => {
    const state = dungeonState(CONFIG, 31)
    const player = state.players.get(1)!
    state.enemies = [makeEnemy(EnemyKind.Caster, player.x, player.z + CELL * 2)]

    let fired = false
    for (let i = 0; i < 80 && !fired; i++) {
      stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
      if (state.projectiles.length > 0) fired = true
    }
    expect(fired).toBe(true)
  })

  it('투사체는 시간이 지나면 사라진다', () => {
    const state = dungeonState(CONFIG, 31)
    state.projectiles = [
      { id: 1, x: state.players.get(1)!.x, z: state.players.get(1)!.z + 40, vx: 0, vz: 0, ttl: 0.1, damage: 5 },
    ]
    for (let i = 0; i < 10; i++) stepGame(state, new Map())
    expect(state.projectiles).toHaveLength(0)
  })

  it('로비에는 적이 없다', () => {
    const state = createRunState(CONFIG, 1)
    addPlayer(state, 1, 'A')
    for (let i = 0; i < 20; i++) stepGame(state, new Map([[1, input(0, 0, i + 1)]]))
    expect(state.enemies).toHaveLength(0)
    expect(state.projectiles).toHaveLength(0)
  })
})
