/**
 * 권위 시뮬레이션.
 *
 * 호스트에서만 "진짜"로 돌고, 클라이언트는 자기 캐릭터를 예측할 때 같은
 * movePlayer() 를 재사용한다. 렌더링이나 입력 장치에 대한 의존이 전혀 없어서
 * Node 에서 그대로 테스트할 수 있다.
 *
 * 게임은 두 개의 존(zone)으로 나뉜다.
 *  - lobby   : 벽 없는 일반 방. 상점에서 아이템을 사고, 던전 구멍으로 들어간다.
 *  - dungeon : 설정에 정의된 레벨들을 차례로 도는 미로.
 * 마지막 레벨을 깨면 다시 로비로 돌아온다. 골드와 아이템은 유지된다.
 */
import { CLEAR_HOLD_SEC, EXIT_R, INTERACT_R, PICKUP_R, PLAYER_R, TICK_DT } from './constants'
import { levelAt, type RunConfig } from './config'
import { ItemId, hasItem, itemById, moveSpeedFor, withItem, type ItemIdValue } from './items'
import { cellToWorld, createLobbyMaze, generateMaze, resolveCircle, type Cell, type Maze } from './maze'

export type Zone = 'lobby' | 'dungeon'

export interface PlayerInput {
  /** 입력이 만들어진 클라이언트 틱. 예측 보정에 쓰인다. */
  tick: number
  /** 월드 기준 이동 방향. 길이는 0~1. */
  dx: number
  dz: number
  /** 바라보는 방향(라디안). 시뮬레이션에는 영향이 없고 렌더링용이다. */
  yaw: number
  /** 상호작용 키(던전 입장 등). */
  interact: boolean
}

export const NO_INPUT: PlayerInput = { tick: 0, dx: 0, dz: 0, yaw: 0, interact: false }

export interface PlayerState {
  id: number
  name: string
  x: number
  z: number
  yaw: number
  escaped: boolean
  /** 마지막으로 반영한 입력의 틱. 클라이언트 예측 보정에 그대로 돌려준다. */
  lastInputTick: number
  gold: number
  /** 보유 아이템 비트마스크. */
  inventory: number
  /** interact 가 눌린 순간만 잡아내기 위한 직전 상태. */
  interactHeld: boolean
}

export interface KeyState {
  homeX: number
  homeZ: number
  x: number
  z: number
  collected: boolean
  /** 들고 있는 플레이어 id. 없으면 -1. */
  carrier: number
}

export type Phase = 'playing' | 'cleared'

export interface GameState {
  tick: number
  seed: number
  config: RunConfig
  zone: Zone
  /** 던전에서 몇 번째 레벨인지. 로비에서는 -1. */
  levelIndex: number
  phase: Phase
  clearTimer: number
  maze: Maze
  players: Map<number, PlayerState>
  keys: KeyState[]
  exitOpen: boolean
  /** 로비에서만 존재한다. */
  shopCell: Cell | null
  entranceCell: Cell | null
}

/** 처음 접속했을 때 주는 골드. 상점을 바로 써볼 수 있어야 한다. */
export const STARTING_GOLD = 100

/** 레벨을 깼을 때 각 플레이어가 받는 골드. */
export function clearReward(levelIndex: number): number {
  return 40 + levelIndex * 20
}

export const LOBBY_SIZE = 9
/** 로비 시설 위치. 클라이언트도 같은 값을 써서 네트워크로 보낼 필요가 없다. */
export const LOBBY_SHOP_CELL: Cell = { x: (LOBBY_SIZE / 2) | 0, y: LOBBY_SIZE - 2 }
export const LOBBY_ENTRANCE_CELL: Cell = { x: (LOBBY_SIZE / 2) | 0, y: 1 }

export function createRunState(config: RunConfig, seed: number): GameState {
  const maze = createLobbyMaze(LOBBY_SIZE)
  return {
    tick: 0,
    seed,
    config,
    zone: 'lobby',
    levelIndex: -1,
    phase: 'playing',
    clearTimer: 0,
    maze,
    players: new Map(),
    keys: [],
    exitOpen: false,
    shopCell: LOBBY_SHOP_CELL,
    entranceCell: LOBBY_ENTRANCE_CELL,
  }
}

/** 설정과 시드로부터 던전 한 레벨을 만든다. 클라이언트도 같은 함수로 같은 미로를 만든다. */
export function createDungeonMaze(config: RunConfig, seed: number, levelIndex: number): Maze {
  const level = levelAt(config, levelIndex)
  return generateMaze(level.width, level.height, dungeonSeed(seed, levelIndex), {
    roomCount: level.roomCount,
    keyCount: level.keyCount,
  })
}

/**
 * 레벨별 시드를 원본 시드에서 결정론적으로 파생시킨다.
 * 늦게 들어온 사람도 시드 하나만 받으면 같은 미로를 만들 수 있어야 한다.
 */
export function dungeonSeed(seed: number, levelIndex: number): number {
  return (Math.imul(seed ^ (levelIndex + 1), 0x9e3779b1) >>> 0) || 1
}

/** 스폰 셀 주변에 플레이어들이 겹치지 않게 흩어 놓는다. */
export function spawnPosition(maze: Maze, slot: number): { x: number; z: number } {
  const base = cellToWorld(maze.spawn)
  const ring = [
    [0, 0],
    [0.7, 0.7],
    [-0.7, 0.7],
    [0.7, -0.7],
    [-0.7, -0.7],
  ]
  const offset = ring[slot % ring.length]
  const out = { x: 0, z: 0 }
  resolveCircle(maze, base.x + offset[0], base.z + offset[1], PLAYER_R, out)
  return out
}

export function addPlayer(state: GameState, id: number, name: string): PlayerState {
  const pos = spawnPosition(state.maze, state.players.size)
  const player: PlayerState = {
    id,
    name,
    x: pos.x,
    z: pos.z,
    yaw: 0,
    escaped: false,
    lastInputTick: 0,
    gold: STARTING_GOLD,
    inventory: 0,
    interactHeld: false,
  }
  state.players.set(id, player)
  return player
}

export function removePlayer(state: GameState, id: number): void {
  // 열쇠를 들고 나갔으면 그 자리에 떨어뜨린다. 안 그러면 열쇠가 영영 사라진다.
  const player = state.players.get(id)
  if (player) {
    for (const key of state.keys) {
      if (key.carrier === id) {
        key.carrier = -1
        key.collected = false
        key.x = player.x
        key.z = player.z
      }
    }
  }
  state.players.delete(id)
}

/**
 * 아이템 구매. 호스트에서만 호출된다.
 * 성공하면 true. 골드가 모자라거나 이미 갖고 있으면 false.
 */
export function buyItem(state: GameState, playerId: number, itemId: number): boolean {
  // 상점은 로비에만 있다.
  if (state.zone !== 'lobby') return false
  const player = state.players.get(playerId)
  const item = itemById(itemId)
  if (!player || !item) return false
  if (hasItem(player.inventory, item.id)) return false
  if (player.gold < item.price) return false
  // 상점 앞에 있어야 살 수 있다. 로비 어디서나 살 수 있으면 상점이 장소일 이유가 없다.
  if (!nearShop(state, player)) return false

  player.gold -= item.price
  player.inventory = withItem(player.inventory, item.id)
  return true
}

export function nearShop(state: GameState, player: { x: number; z: number }): boolean {
  if (!state.shopCell) return false
  const shop = cellToWorld(state.shopCell)
  return Math.hypot(player.x - shop.x, player.z - shop.z) <= INTERACT_R
}

export function nearEntrance(state: GameState, player: { x: number; z: number }): boolean {
  if (!state.entranceCell) return false
  const entrance = cellToWorld(state.entranceCell)
  return Math.hypot(player.x - entrance.x, player.z - entrance.z) <= INTERACT_R
}

/**
 * 플레이어 한 명의 이동. 순수 함수에 가깝게 유지한다.
 * 호스트와 클라이언트 예측이 반드시 이 함수를 공유해야 한다.
 * 속도가 아이템에 좌우되므로 inventory 도 함께 받는다.
 */
export function movePlayer(
  maze: Maze,
  player: { x: number; z: number },
  input: PlayerInput,
  dt: number,
  inventory = 0,
): void {
  let dx = input.dx
  let dz = input.dz
  const len = Math.hypot(dx, dz)
  if (len === 0) return
  if (len > 1) {
    dx /= len
    dz /= len
  }

  const speed = moveSpeedFor(inventory)
  const nx = player.x + dx * speed * dt
  const nz = player.z + dz * speed * dt
  const out = { x: 0, z: 0 }
  resolveCircle(maze, nx, nz, PLAYER_R, out)
  player.x = out.x
  player.z = out.z
}

/**
 * 한 틱 진행. inputs 는 플레이어별 최신 입력.
 * 존이나 레벨이 바뀌어야 하면 새 GameState 를 반환하고, 아니면 null 을 반환한다.
 */
export function stepGame(
  state: GameState,
  inputs: Map<number, PlayerInput>,
  dt: number = TICK_DT,
): GameState | null {
  state.tick++

  let interactPressed = false
  for (const player of state.players.values()) {
    const input = inputs.get(player.id) ?? NO_INPUT
    player.yaw = input.yaw
    player.lastInputTick = input.tick

    // 누르고 있는 동안 매 틱 발동하면 안 된다. 눌린 순간만 잡는다.
    if (input.interact && !player.interactHeld) interactPressed = true
    player.interactHeld = input.interact

    if (player.escaped || state.phase === 'cleared') continue
    movePlayer(state.maze, player, input, dt, player.inventory)
  }

  if (state.zone === 'lobby') {
    if (interactPressed) {
      for (const player of state.players.values()) {
        if (nearEntrance(state, player)) return enterDungeon(state)
      }
    }
    return null
  }

  if (state.phase === 'playing') {
    updateKeys(state)
    updateExit(state)
    return null
  }

  state.clearTimer += dt
  if (state.clearTimer >= CLEAR_HOLD_SEC) return advanceAfterClear(state)
  return null
}

function updateKeys(state: GameState) {
  for (const key of state.keys) {
    if (key.collected) {
      const carrier = state.players.get(key.carrier)
      if (carrier) {
        key.x = carrier.x
        key.z = carrier.z
      }
      continue
    }
    for (const player of state.players.values()) {
      if (player.escaped) continue
      if (Math.hypot(player.x - key.x, player.z - key.z) <= PICKUP_R) {
        key.collected = true
        key.carrier = player.id
        break
      }
    }
  }

  state.exitOpen = state.keys.length > 0 && state.keys.every((k) => k.collected)
}

function updateExit(state: GameState) {
  if (!state.exitOpen) return
  const exit = cellToWorld(state.maze.exit)

  for (const player of state.players.values()) {
    if (player.escaped) continue
    if (Math.hypot(player.x - exit.x, player.z - exit.z) <= EXIT_R) {
      player.escaped = true
    }
  }

  // 아무도 없는 방에서 즉시 클리어되는 것을 막는다.
  if (state.players.size === 0) return
  for (const player of state.players.values()) {
    if (!player.escaped) return
  }

  state.phase = 'cleared'
  state.clearTimer = 0
  const reward = clearReward(state.levelIndex)
  for (const player of state.players.values()) player.gold += reward
}

/** 로비에서 던전 1층으로. */
export function enterDungeon(state: GameState): GameState {
  return buildDungeonState(state, 0)
}

/** 클리어 후: 다음 레벨이 있으면 그리로, 없으면 로비로 돌아간다. */
function advanceAfterClear(state: GameState): GameState {
  const next = state.levelIndex + 1
  if (next >= state.config.levels.length) return backToLobby(state)
  return buildDungeonState(state, next)
}

export function backToLobby(state: GameState): GameState {
  const fresh = createRunState(state.config, state.seed)
  fresh.tick = state.tick
  carryPlayers(state, fresh)
  return fresh
}

function buildDungeonState(state: GameState, levelIndex: number): GameState {
  const maze = createDungeonMaze(state.config, state.seed, levelIndex)
  const next: GameState = {
    tick: state.tick,
    seed: state.seed,
    config: state.config,
    zone: 'dungeon',
    levelIndex,
    phase: 'playing',
    clearTimer: 0,
    maze,
    players: new Map(),
    keys: maze.keys.map((cell) => {
      const w = cellToWorld(cell)
      return { homeX: w.x, homeZ: w.z, x: w.x, z: w.z, collected: false, carrier: -1 }
    }),
    exitOpen: false,
    shopCell: null,
    entranceCell: null,
  }
  carryPlayers(state, next)
  return next
}

/** 존이 바뀌어도 골드와 아이템은 유지된다. 위치와 탈출 여부만 초기화한다. */
function carryPlayers(from: GameState, to: GameState) {
  let slot = 0
  for (const player of from.players.values()) {
    const pos = spawnPosition(to.maze, slot++)
    to.players.set(player.id, {
      ...player,
      x: pos.x,
      z: pos.z,
      escaped: false,
      // 존 전환을 일으킨 그 키 입력이 다음 존에서 또 발동하지 않도록 눌린 상태로 남겨둔다.
      interactHeld: true,
    })
  }
}

/** 가장 가까운, 아직 안 주운 열쇠까지의 거리. 열쇠 감각 아이템용. */
export function nearestKeyDistance(state: GameState, from: { x: number; z: number }): number | null {
  let best: number | null = null
  for (const key of state.keys) {
    if (key.collected) continue
    const d = Math.hypot(key.x - from.x, key.z - from.z)
    if (best === null || d < best) best = d
  }
  return best
}

export { ItemId }
export type { ItemIdValue }
