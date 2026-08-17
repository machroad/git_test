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
import { CELL, CLEAR_HOLD_SEC, EXIT_R, INTERACT_R, PICKUP_R, PLAYER_R, TICK_DT } from './constants'
import {
  ATTACK_COOLDOWN,
  ATTACK_DAMAGE,
  ATTACK_HALF_ANGLE,
  ATTACK_RANGE,
  ATTACK_STAMINA_COST,
  ATTACK_SWING_SEC,
  BOSS_RANGED_RANGE,
  DOWN_RESPAWN_SEC,
  ENEMY_DEFS,
  EXHAUST_REFILL_PER_SEC,
  EXHAUST_STUN_SEC,
  EnemyKind,
  HIT_INVULN_SEC,
  PLAYER_MAX_HP,
  PLAYER_MAX_STAMINA,
  PROJECTILE_RADIUS,
  PROJECTILE_SPEED,
  PROJECTILE_TTL,
  RESPAWN_HP_RATIO,
  SPRINT_MULTIPLIER,
  SPRINT_STAMINA_PER_SEC,
  STAMINA_REGEN_DELAY,
  STAMINA_REGEN_PER_SEC,
  inAttackCone,
  type EnemyKindValue,
} from './combat'
import { mulberry32, randInt, shuffle } from './rng'
import { levelAt, type RunConfig } from './config'
import { ItemId, hasItem, itemById, moveSpeedFor, withItem, type ItemIdValue } from './items'
import {
  cellToWorld,
  createLobbyMaze,
  generateMaze,
  resolveCircle,
  roomAt,
  segmentBlocked,
  type Cell,
  type Maze,
} from './maze'

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
  /** 달리기(Shift). 스태미나를 계속 소모한다. */
  sprint: boolean
  /** 공격(Space). 눌린 순간에만 발동한다. */
  attack: boolean
}

export const NO_INPUT: PlayerInput = {
  tick: 0,
  dx: 0,
  dz: 0,
  yaw: 0,
  interact: false,
  sprint: false,
  attack: false,
}

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
  attackHeld: boolean

  hp: number
  stamina: number
  /** 경직 남은 시간(초). 0보다 크면 움직이거나 공격할 수 없다. */
  stunTimer: number
  /** 스태미나 회복이 시작되기까지 남은 시간(초). */
  regenDelay: number
  /** 다음 공격까지 남은 시간(초). */
  attackCooldown: number
  /** 공격 모션이 남은 시간(초). 렌더링용. */
  swingTimer: number
  /** 피격 무적 남은 시간(초). */
  invulnTimer: number
  /** 쓰러진 뒤 부활까지 남은 시간(초). 0이면 살아 있다. */
  downTimer: number
}

export interface EnemyState {
  id: number
  kind: EnemyKindValue
  x: number
  z: number
  yaw: number
  hp: number
  /** 공격 예비 동작 남은 시간(초). 0보다 크면 제자리에서 준비 중이다. */
  windup: number
  /** 다음 공격까지 남은 시간(초). */
  cooldown: number
  /** 노리고 있는 플레이어 id. 없으면 -1. */
  target: number
  /** 맞았을 때 잠깐 붉게 표시하기 위한 타이머. */
  hitFlash: number
}

export interface ProjectileState {
  id: number
  x: number
  z: number
  vx: number
  vz: number
  ttl: number
  damage: number
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
  enemies: EnemyState[]
  projectiles: ProjectileState[]
  nextProjectileId: number
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
    enemies: [],
    projectiles: [],
    nextProjectileId: 1,
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
    attackHeld: false,
    hp: PLAYER_MAX_HP,
    stamina: PLAYER_MAX_STAMINA,
    stunTimer: 0,
    regenDelay: 0,
    attackCooldown: 0,
    swingTimer: 0,
    invulnTimer: 0,
    downTimer: 0,
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
  sprinting = false,
): void {
  let dx = input.dx
  let dz = input.dz
  const len = Math.hypot(dx, dz)
  if (len === 0) return
  if (len > 1) {
    dx /= len
    dz /= len
  }

  const speed = moveSpeedFor(inventory) * (sprinting ? SPRINT_MULTIPLIER : 1)
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

    updatePlayerCombat(state, player, input, dt)

    if (player.escaped || state.phase === 'cleared') continue
    // 경직 중이거나 쓰러져 있으면 움직일 수 없다.
    if (player.stunTimer > 0 || player.downTimer > 0) continue
    movePlayer(state.maze, player, input, dt, player.inventory, isSprinting(player, input))
  }

  if (state.zone === 'dungeon') {
    updateEnemies(state, dt)
    updateProjectiles(state, dt)
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
    enemies: spawnEnemies(maze, dungeonSeed(state.seed, levelIndex), levelIndex),
    projectiles: [],
    nextProjectileId: 1,
  }
  carryPlayers(state, next)
  return next
}

/**
 * 적 배치. 미로와 같은 시드에서 파생시켜 결정론적으로 만든다.
 *
 * 방에는 중간 보스를 하나씩 두고, 통로에는 일반 몹을 흩어 놓는다.
 * 스폰 근처는 비워둔다 — 시작하자마자 둘러싸이면 손쓸 방법이 없다.
 */
export function spawnEnemies(maze: Maze, seed: number, levelIndex: number): EnemyState[] {
  const rng = mulberry32((seed ^ 0x5bf03635) >>> 0)
  const enemies: EnemyState[] = []
  let nextId = 1

  const spawnWorld = cellToWorld(maze.spawn)
  const exitWorld = cellToWorld(maze.exit)
  const safeRadius = CELL * 2.5

  const place = (kind: EnemyKindValue, cx: number, cy: number) => {
    const pos = cellToWorld({ x: cx, y: cy })
    enemies.push({
      id: nextId++,
      kind,
      x: pos.x,
      z: pos.z,
      yaw: 0,
      hp: ENEMY_DEFS[kind].maxHp,
      windup: 0,
      cooldown: 0,
      target: -1,
      hitFlash: 0,
    })
  }

  // 방마다 보스 하나. 방 한가운데에 둔다.
  for (const room of maze.rooms) {
    place(EnemyKind.Boss, room.x + ((room.w / 2) | 0), room.y + ((room.h / 2) | 0))
  }

  // 통로에 일반 몹. 레벨이 깊어질수록 늘린다.
  const cellCount = maze.w * maze.h
  const target = Math.min(40, Math.round(cellCount * 0.045) + levelIndex * 2)
  const kinds: EnemyKindValue[] = [EnemyKind.Biter, EnemyKind.Biter, EnemyKind.Brute, EnemyKind.Caster]

  const candidates: number[] = []
  for (let y = 0; y < maze.h; y++) {
    for (let x = 0; x < maze.w; x++) {
      const world = cellToWorld({ x, y })
      if (Math.hypot(world.x - spawnWorld.x, world.z - spawnWorld.z) < safeRadius) continue
      if (Math.hypot(world.x - exitWorld.x, world.z - exitWorld.z) < CELL) continue
      if (roomAt(maze, x, y)) continue // 방은 보스 담당
      candidates.push(y * maze.w + x)
    }
  }
  shuffle(rng, candidates)

  for (let i = 0; i < Math.min(target, candidates.length); i++) {
    const index = candidates[i]
    place(kinds[randInt(rng, kinds.length)], index % maze.w, (index / maze.w) | 0)
  }

  return enemies
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

// ---------------------------------------------------------------------------
// 전투
// ---------------------------------------------------------------------------

/** 달리는 중인가. 이동 중이고 스태미나가 남아 있어야 한다. */
export function isSprinting(player: PlayerState, input: PlayerInput): boolean {
  if (!input.sprint) return false
  if (player.stunTimer > 0 || player.downTimer > 0) return false
  if (player.stamina <= 0) return false
  return Math.hypot(input.dx, input.dz) > 0.01
}

/**
 * 플레이어의 스태미나 · 경직 · 공격 · 부활을 갱신한다.
 *
 * 스태미나가 0이 되는 순간 경직에 걸린다. 경직 동안은 못 움직이고 못 때리며,
 * 끝나면 스태미나가 빠르게 채워진다. "지치면 잠깐 멈춘다"를 만드는 장치다.
 */
function updatePlayerCombat(
  state: GameState,
  player: PlayerState,
  input: PlayerInput,
  dt: number,
): void {
  player.invulnTimer = Math.max(0, player.invulnTimer - dt)
  player.swingTimer = Math.max(0, player.swingTimer - dt)
  player.attackCooldown = Math.max(0, player.attackCooldown - dt)

  // 쓰러진 상태: 시간이 지나면 스폰 지점에서 절반 체력으로 일어난다.
  if (player.downTimer > 0) {
    player.downTimer -= dt
    player.attackHeld = input.attack
    if (player.downTimer <= 0) {
      player.downTimer = 0
      player.hp = Math.round(PLAYER_MAX_HP * RESPAWN_HP_RATIO)
      player.stamina = PLAYER_MAX_STAMINA
      player.invulnTimer = HIT_INVULN_SEC * 2
      const pos = spawnPosition(state.maze, 0)
      player.x = pos.x
      player.z = pos.z
    }
    return
  }

  // 경직 중에는 스태미나만 빠르게 회복한다.
  if (player.stunTimer > 0) {
    // 빼기만 하면 부동소수점 오차로 아주 작은 음수가 남는다. 0 으로 정확히 맞춘다.
    player.stunTimer = Math.max(0, player.stunTimer - dt)
    player.stamina = Math.min(PLAYER_MAX_STAMINA, player.stamina + EXHAUST_REFILL_PER_SEC * dt)
    player.attackHeld = input.attack
    return
  }

  let spent = false

  if (isSprinting(player, input)) {
    player.stamina -= SPRINT_STAMINA_PER_SEC * dt
    spent = true
  }

  // 공격은 눌린 순간에만. 누르고 있으면 연타되면 안 된다.
  const attackPressed = input.attack && !player.attackHeld
  player.attackHeld = input.attack
  if (
    attackPressed &&
    player.attackCooldown <= 0 &&
    player.stamina >= ATTACK_STAMINA_COST &&
    !player.escaped
  ) {
    player.stamina -= ATTACK_STAMINA_COST
    player.attackCooldown = ATTACK_COOLDOWN
    player.swingTimer = ATTACK_SWING_SEC
    spent = true
    applyPlayerAttack(state, player)
  }

  if (spent) {
    player.regenDelay = STAMINA_REGEN_DELAY
  } else {
    player.regenDelay = Math.max(0, player.regenDelay - dt)
    if (player.regenDelay <= 0) {
      player.stamina = Math.min(PLAYER_MAX_STAMINA, player.stamina + STAMINA_REGEN_PER_SEC * dt)
    }
  }

  if (player.stamina <= 0) {
    player.stamina = 0
    player.stunTimer = EXHAUST_STUN_SEC
  }
}

/** 앞쪽 부채꼴 안의 적을 때린다. */
function applyPlayerAttack(state: GameState, player: PlayerState): void {
  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) continue
    if (!inAttackCone(player.x, player.z, player.yaw, enemy.x, enemy.z, ATTACK_RANGE, ATTACK_HALF_ANGLE)) {
      continue
    }
    enemy.hp -= ATTACK_DAMAGE
    enemy.hitFlash = 0.15
    // 맞으면 때린 사람을 노린다. 뒤에서 때리고 빠지는 걸 막는다.
    enemy.target = player.id
    if (enemy.hp <= 0) {
      enemy.hp = 0
      player.gold += ENEMY_DEFS[enemy.kind].gold
    }
  }
}

/** 플레이어에게 피해를 준다. 무적 중이면 무시된다. */
export function damagePlayer(player: PlayerState, amount: number): boolean {
  if (player.downTimer > 0) return false
  if (player.invulnTimer > 0) return false
  player.hp -= amount
  player.invulnTimer = HIT_INVULN_SEC
  if (player.hp <= 0) {
    player.hp = 0
    player.downTimer = DOWN_RESPAWN_SEC
    player.stamina = 0
  }
  return true
}

/** 노릴 만한 가장 가까운 플레이어. 쓰러졌거나 탈출한 사람은 제외한다. */
function nearestTarget(state: GameState, x: number, z: number, range: number): PlayerState | null {
  let best: PlayerState | null = null
  let bestDist = range
  for (const player of state.players.values()) {
    if (player.escaped || player.downTimer > 0) continue
    const dist = Math.hypot(player.x - x, player.z - z)
    if (dist <= bestDist) {
      bestDist = dist
      best = player
    }
  }
  return best
}

function updateEnemies(state: GameState, dt: number): void {
  for (const enemy of state.enemies) {
    if (enemy.hp <= 0) continue
    const def = ENEMY_DEFS[enemy.kind]
    enemy.hitFlash = Math.max(0, enemy.hitFlash - dt)
    enemy.cooldown = Math.max(0, enemy.cooldown - dt)

    // 이미 노리던 상대가 유효하지 않으면 새로 찾는다.
    let target = enemy.target >= 0 ? state.players.get(enemy.target) ?? null : null
    if (target && (target.escaped || target.downTimer > 0)) target = null
    if (!target) {
      target = nearestTarget(state, enemy.x, enemy.z, def.aggroRange)
      enemy.target = target?.id ?? -1
    }

    if (!target) {
      enemy.windup = 0
      continue
    }

    const dx = target.x - enemy.x
    const dz = target.z - enemy.z
    const dist = Math.hypot(dx, dz)
    enemy.yaw = Math.atan2(dx, dz)

    // 예비 동작 중에는 제자리에 멈춘다. 이게 있어야 피할 여지가 생긴다.
    if (enemy.windup > 0) {
      enemy.windup -= dt
      if (enemy.windup <= 0) {
        enemy.windup = 0
        fireEnemyAttack(state, enemy, target, dist)
      }
      continue
    }

    const useRanged = def.ranged || (enemy.kind === EnemyKind.Boss && dist > def.attackRange * 1.4)
    const reach = useRanged ? (def.ranged ? def.attackRange : BOSS_RANGED_RANGE) : def.attackRange

    if (dist <= reach && enemy.cooldown <= 0 && hasLineOfSight(state, enemy, target, useRanged)) {
      enemy.windup = def.windup
      continue
    }

    // 이동. 원거리 적은 너무 가까우면 물러난다.
    let moveX = 0
    let moveZ = 0
    if (def.keepDistance > 0 && dist < def.keepDistance) {
      moveX = -dx / (dist || 1)
      moveZ = -dz / (dist || 1)
    } else if (dist > reach * 0.85) {
      moveX = dx / (dist || 1)
      moveZ = dz / (dist || 1)
    }

    if (moveX !== 0 || moveZ !== 0) {
      const out = { x: 0, z: 0 }
      resolveCircle(
        state.maze,
        enemy.x + moveX * def.speed * dt,
        enemy.z + moveZ * def.speed * dt,
        def.radius,
        out,
      )
      enemy.x = out.x
      enemy.z = out.z
    }
  }

  // 죽은 적은 잠깐 두었다가 치운다. 바로 지우면 죽는 순간이 안 보인다.
  if (state.enemies.some((e) => e.hp <= 0)) {
    for (const enemy of state.enemies) {
      if (enemy.hp <= 0) enemy.hitFlash -= dt
    }
    state.enemies = state.enemies.filter((e) => e.hp > 0 || e.hitFlash > -0.6)
  }
}

/** 원거리 공격은 벽 너머로 쏠 수 없다. */
function hasLineOfSight(
  state: GameState,
  enemy: EnemyState,
  target: PlayerState,
  ranged: boolean,
): boolean {
  if (!ranged) return true
  return !segmentBlocked(state.maze, enemy.x, enemy.z, target.x, target.z)
}

function fireEnemyAttack(
  state: GameState,
  enemy: EnemyState,
  target: PlayerState,
  distAtWindupStart: number,
): void {
  const def = ENEMY_DEFS[enemy.kind]
  enemy.cooldown = def.attackCooldown

  const dx = target.x - enemy.x
  const dz = target.z - enemy.z
  const dist = Math.hypot(dx, dz)
  const useRanged = def.ranged || (enemy.kind === EnemyKind.Boss && distAtWindupStart > def.attackRange * 1.4)

  if (useRanged) {
    if (dist < 1e-4) return
    state.projectiles.push({
      id: state.nextProjectileId++,
      x: enemy.x,
      z: enemy.z,
      vx: (dx / dist) * PROJECTILE_SPEED,
      vz: (dz / dist) * PROJECTILE_SPEED,
      ttl: PROJECTILE_TTL,
      damage: def.attackDamage,
    })
    return
  }

  // 근접: 예비 동작이 끝난 시점에도 사거리 안에 있어야 맞는다.
  if (dist <= def.attackRange + PLAYER_R) damagePlayer(target, def.attackDamage)
}

function updateProjectiles(state: GameState, dt: number): void {
  if (state.projectiles.length === 0) return
  const survivors: ProjectileState[] = []

  for (const projectile of state.projectiles) {
    projectile.ttl -= dt
    if (projectile.ttl <= 0) continue

    projectile.x += projectile.vx * dt
    projectile.z += projectile.vz * dt

    // 벽에 닿으면 사라진다. resolveCircle 이 위치를 밀어냈다면 벽에 박은 것이다.
    const out = { x: 0, z: 0 }
    resolveCircle(state.maze, projectile.x, projectile.z, PROJECTILE_RADIUS, out)
    if (Math.abs(out.x - projectile.x) > 1e-4 || Math.abs(out.z - projectile.z) > 1e-4) continue

    let hit = false
    for (const player of state.players.values()) {
      if (player.escaped || player.downTimer > 0) continue
      if (Math.hypot(player.x - projectile.x, player.z - projectile.z) <= PLAYER_R + PROJECTILE_RADIUS) {
        damagePlayer(player, projectile.damage)
        hit = true
        break
      }
    }
    if (!hit) survivors.push(projectile)
  }

  state.projectiles = survivors
}
