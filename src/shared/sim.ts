/**
 * 권위 시뮬레이션.
 *
 * 호스트에서만 "진짜"로 돌고, 클라이언트는 자기 캐릭터를 예측할 때 같은
 * movePlayer() 를 재사용한다. 렌더링이나 입력 장치에 대한 의존이 전혀 없어서
 * Node 에서 그대로 테스트할 수 있다.
 */
import {
  CLEAR_HOLD_SEC,
  EXIT_R,
  PICKUP_R,
  PLAYER_R,
  PLAYER_SPEED,
  TICK_DT,
  keyCountForLevel,
  mazeSizeForLevel,
} from './constants'
import { cellToWorld, generateMaze, resolveCircle, type Maze } from './maze'

export interface PlayerInput {
  /** 입력이 만들어진 클라이언트 틱. 예측 보정에 쓰인다. */
  tick: number
  /** 월드 기준 이동 방향. 길이는 0~1. */
  dx: number
  dz: number
  /** 바라보는 방향(라디안). 시뮬레이션에는 영향이 없고 렌더링용이다. */
  yaw: number
}

export const NO_INPUT: PlayerInput = { tick: 0, dx: 0, dz: 0, yaw: 0 }

export interface PlayerState {
  id: number
  name: string
  x: number
  z: number
  yaw: number
  escaped: boolean
  /** 마지막으로 반영한 입력의 틱. 클라이언트 예측 보정에 그대로 돌려준다. */
  lastInputTick: number
}

export interface KeyState {
  /** 원래 놓인 셀. 떨어뜨렸을 때 되돌아갈 자리가 아니라 초기 배치 기록용. */
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
  level: number
  seed: number
  phase: Phase
  /** cleared 상태로 들어간 뒤 지난 초. CLEAR_HOLD_SEC 를 넘으면 다음 레벨. */
  clearTimer: number
  maze: Maze
  players: Map<number, PlayerState>
  keys: KeyState[]
  exitOpen: boolean
}

export function createGameState(level: number, seed: number): GameState {
  const size = mazeSizeForLevel(level)
  const maze = generateMaze(size, size, seed)
  const keyCount = keyCountForLevel(level)

  const keys: KeyState[] = maze.keys.slice(0, keyCount).map((cell) => {
    const w = cellToWorld(cell)
    return { homeX: w.x, homeZ: w.z, x: w.x, z: w.z, collected: false, carrier: -1 }
  })

  return {
    tick: 0,
    level,
    seed,
    phase: 'playing',
    clearTimer: 0,
    maze,
    players: new Map(),
    keys,
    exitOpen: false,
  }
}

/** 스폰 셀 주변에 플레이어들이 겹치지 않게 흩어 놓는다. */
export function spawnPosition(state: GameState, slot: number): { x: number; z: number } {
  const base = cellToWorld(state.maze.spawn)
  const ring = [
    [0, 0],
    [0.6, 0.6],
    [-0.6, 0.6],
    [0.6, -0.6],
    [-0.6, -0.6],
  ]
  const offset = ring[slot % ring.length]
  const out = { x: 0, z: 0 }
  resolveCircle(state.maze, base.x + offset[0], base.z + offset[1], PLAYER_R, out)
  return out
}

export function addPlayer(state: GameState, id: number, name: string): PlayerState {
  const pos = spawnPosition(state, state.players.size)
  const player: PlayerState = {
    id,
    name,
    x: pos.x,
    z: pos.z,
    yaw: 0,
    escaped: false,
    lastInputTick: 0,
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
 * 플레이어 한 명의 이동. 순수 함수에 가깝게 유지한다.
 * 호스트와 클라이언트 예측이 반드시 이 함수를 공유해야 한다.
 */
export function movePlayer(maze: Maze, player: { x: number; z: number }, input: PlayerInput, dt: number): void {
  let dx = input.dx
  let dz = input.dz
  const len = Math.hypot(dx, dz)
  if (len > 1) {
    dx /= len
    dz /= len
  }
  if (len === 0) return

  const nx = player.x + dx * PLAYER_SPEED * dt
  const nz = player.z + dz * PLAYER_SPEED * dt
  const out = { x: 0, z: 0 }
  resolveCircle(maze, nx, nz, PLAYER_R, out)
  player.x = out.x
  player.z = out.z
}

/**
 * 한 틱 진행. inputs 는 플레이어별 최신 입력.
 * 다음 레벨로 넘어가야 하면 새 GameState 를 반환하고, 아니면 null 을 반환한다.
 */
export function stepGame(
  state: GameState,
  inputs: Map<number, PlayerInput>,
  dt: number = TICK_DT,
): GameState | null {
  state.tick++

  for (const player of state.players.values()) {
    const input = inputs.get(player.id) ?? NO_INPUT
    player.yaw = input.yaw
    player.lastInputTick = input.tick
    if (player.escaped || state.phase === 'cleared') continue
    movePlayer(state.maze, player, input, dt)
  }

  if (state.phase === 'playing') {
    updateKeys(state)
    updateExit(state)
  } else {
    state.clearTimer += dt
    if (state.clearTimer >= CLEAR_HOLD_SEC) {
      return nextLevel(state)
    }
  }

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
  let allEscaped = true
  for (const player of state.players.values()) {
    if (!player.escaped) {
      allEscaped = false
      break
    }
  }
  if (allEscaped) {
    state.phase = 'cleared'
    state.clearTimer = 0
  }
}

/** 레벨을 올려 새 미로를 만들고 플레이어를 이어받는다. */
export function nextLevel(state: GameState): GameState {
  const level = state.level + 1
  // 시드를 결정론적으로 파생시켜, 방에 늦게 들어온 사람도 같은 미로를 만들 수 있게 한다.
  const seed = (Math.imul(state.seed ^ level, 0x9e3779b1) >>> 0) || 1
  const next = createGameState(level, seed)
  next.tick = state.tick

  let slot = 0
  for (const player of state.players.values()) {
    const pos = spawnPosition(next, slot++)
    next.players.set(player.id, {
      id: player.id,
      name: player.name,
      x: pos.x,
      z: pos.z,
      yaw: player.yaw,
      escaped: false,
      lastInputTick: player.lastInputTick,
    })
  }
  return next
}
