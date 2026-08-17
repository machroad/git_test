/**
 * 클라이언트 측 게임 상태.
 *
 * 두 가지를 한다.
 *  1) 원격 플레이어: 스냅샷을 INTERP_DELAY_MS 만큼 지연시켜 두 개 사이를 보간한다.
 *     최신 스냅샷을 바로 그리면 패킷 간격이 흔들릴 때마다 캐릭터가 떤다.
 *  2) 로컬 플레이어: 호스트 응답을 기다리지 않고 즉시 움직인다(예측).
 *     스냅샷이 오면 그때의 예측값과 비교해 오차만 부드럽게 흡수한다.
 *
 * 롤백/재시뮬레이션은 하지 않는다. 협동 게임이라 치팅 방어가 필요 없고,
 * 오차가 커봐야 벽 근처에서 몇십 cm 수준이라 이 정도로 충분하다.
 */
import {
  INTERP_DELAY_MS,
  RECONCILE_TAU,
  RECONCILE_SNAP_DIST,
  TICK_DT,
} from '../shared/constants'
import { cellToWorld, createLobbyMaze, worldToCell, type Maze } from '../shared/maze'
import { DEFAULT_RUN_CONFIG, type RunConfig } from '../shared/config'
import { revealRadiusFor } from '../shared/items'
import {
  MsgType,
  decodeJson,
  decodeSnapshot,
  encodeInput,
  encodeJson,
  messageType,
  wrapAngle,
  type RosterMsg,
  type SnapshotMsg,
  type WelcomeMsg,
  type ZoneMsg,
} from '../shared/protocol'
import { createDungeonMaze, movePlayer, type PlayerInput, type Zone } from '../shared/sim'
import type { ClientTransport } from '../net/transport'

export interface RenderPlayer {
  id: number
  name: string
  x: number
  z: number
  yaw: number
  escaped: boolean
  isLocal: boolean
  gold: number
  inventory: number
}

export interface RenderKey {
  x: number
  z: number
  collected: boolean
  carrier: number
}

export interface RenderEnemy {
  id: number
  kind: number
  x: number
  z: number
  yaw: number
  /** 체력 비율 0~1. */
  hp: number
  windup: boolean
}

export interface RenderProjectile {
  id: number
  x: number
  z: number
}

interface TimedSnapshot {
  recvTime: number
  snapshot: SnapshotMsg
}

export class GameClientState {
  playerId = -1
  seed = 1
  config: RunConfig = DEFAULT_RUN_CONFIG
  zone: Zone = 'lobby'
  /** 로비는 -1. 던전이면 몇 번째 레벨인지. */
  levelIndex = -1
  maze: Maze | null = null
  exitOpen = false
  cleared = false
  connected = false
  /** 내 골드와 아이템. 스냅샷에서 갱신된다. */
  gold = 0
  inventory = 0
  /** 내 체력과 스태미나 비율(0~1). HUD 게이지에 그대로 쓴다. */
  hpRatio = 1
  staminaRatio = 1
  stunned = false
  downed = false
  /** 지금 공격 모션 중인지. 호스트가 알려준다. */
  swinging = false
  /** 예측이 호스트와 같은 속도를 쓰기 위한 스태미나 근사치(0~255). */
  private stamina = 255

  /** 마지막 고정 스텝에서의 로컬 예측 위치. 호스트 권위 위치와 직접 비교되는 값이다. */
  readonly predicted = { x: 0, z: 0 }
  /** 그 직전 스텝의 위치. 화면에는 두 값 사이를 보간해 60fps 로 부드럽게 그린다. */
  private previous = { x: 0, z: 0 }
  yaw = 0

  /** 미니맵 탐사 표시. 팀원 전부의 위치로 채워지므로 협동으로 지도가 열린다. */
  readonly explored = new Set<number>()

  private transport: ClientTransport
  private names = new Map<number, string>()
  private snapshots: TimedSnapshot[] = []
  private history: { tick: number; x: number; z: number }[] = []
  private pending = { x: 0, z: 0 }
  private inputTick = 0
  private hasAuthoritativePosition = false
  private stepAccumulator = 0
  private desiredInput = { dx: 0, dz: 0, yaw: 0, interact: false, sprint: false, attack: false }
  private localEscaped = false
  private onLevelChanged?: (maze: Maze) => void

  constructor(transport: ClientTransport, onLevelChanged?: (maze: Maze) => void) {
    this.transport = transport
    this.onLevelChanged = onLevelChanged
    transport.onMessage((data) => this.handleMessage(data))
    transport.onClose(() => {
      this.connected = false
    })
  }

  setName(name: string): void {
    this.transport.send(encodeJson(MsgType.Join, { name }), true)
  }

  // -------------------------------------------------------------------------
  // 수신
  // -------------------------------------------------------------------------

  private handleMessage(data: Uint8Array) {
    switch (messageType(data)) {
      case MsgType.Welcome: {
        const msg = decodeJson<WelcomeMsg>(data)
        this.playerId = msg.playerId
        this.connected = true
        this.seed = msg.seed
        this.config = msg.config
        this.loadZone(msg.zone)
        break
      }
      case MsgType.Zone: {
        this.loadZone(decodeJson<ZoneMsg>(data))
        break
      }
      case MsgType.Roster: {
        const msg = decodeJson<RosterMsg>(data)
        this.names.clear()
        for (const p of msg.players) this.names.set(p.id, p.name)
        break
      }
      case MsgType.Snapshot: {
        this.handleSnapshot(decodeSnapshot(data))
        break
      }
      default:
        break
    }
  }

  private loadZone(msg: ZoneMsg) {
    this.zone = msg.zone
    this.levelIndex = msg.levelIndex
    // 미로는 설정 + 시드로부터 각자 만든다. 네트워크로 미로를 보낼 필요가 없다.
    this.maze =
      msg.zone === 'lobby'
        ? createLobbyMaze()
        : createDungeonMaze(this.config, this.seed, msg.levelIndex)
    this.snapshots.length = 0
    this.history.length = 0
    this.explored.clear()
    this.pending.x = 0
    this.pending.z = 0
    this.hasAuthoritativePosition = false
    this.stepAccumulator = 0
    this.localEscaped = false
    this.exitOpen = false
    this.cleared = false

    const spawn = cellToWorld(this.maze.spawn)
    this.predicted.x = spawn.x
    this.predicted.z = spawn.z
    this.previous.x = spawn.x
    this.previous.z = spawn.z
    this.onLevelChanged?.(this.maze)
  }

  private handleSnapshot(snapshot: SnapshotMsg) {
    // 전송 계층에서는 이미 연결됐지만 아직 Welcome 을 못 받은 구간이 존재한다.
    // 이때 들어오는 스냅샷을 받아들이면 미로도 없고 내 playerId 도 모르는 채로
    // 상태가 채워져서, 뒤늦게 온 Welcome 과 어긋난다.
    if (!this.maze || this.playerId < 0) return
    // 존 전환 메시지보다 이전 존의 스냅샷이 늦게 도착할 수 있다.
    if (snapshot.levelIndex !== this.levelIndex) return

    this.snapshots.push({ recvTime: performance.now(), snapshot })
    // 보간에 필요한 것보다 넉넉히 남기고 버린다.
    while (this.snapshots.length > 32) this.snapshots.shift()

    this.exitOpen = snapshot.exitOpen
    this.cleared = snapshot.cleared

    const mine = snapshot.players.find((p) => p.id === this.playerId)
    if (mine) {
      this.localEscaped = mine.escaped
      this.gold = mine.gold
      this.inventory = mine.inventory
      this.hpRatio = mine.hp / 255
      this.staminaRatio = mine.stamina / 255
      this.stamina = mine.stamina
      this.stunned = mine.stunned
      this.downed = mine.downed
      this.swinging = mine.swinging
      this.reconcile(mine.x, mine.z, mine.lastInputTick)
    }
  }

  /** 호스트가 알려준 권위 위치와 그 시점의 예측값을 비교해 오차만 뽑아낸다. */
  private reconcile(authX: number, authZ: number, lastInputTick: number) {
    if (!this.hasAuthoritativePosition) {
      // 첫 스냅샷은 비교 대상이 없으므로 그대로 받아들인다.
      this.predicted.x = authX
      this.predicted.z = authZ
      this.previous.x = authX
      this.previous.z = authZ
      this.pending.x = 0
      this.pending.z = 0
      this.hasAuthoritativePosition = true
      return
    }

    const record = this.history.find((h) => h.tick === lastInputTick)
    if (!record) return

    const errorX = authX - record.x
    const errorZ = authZ - record.z

    // 오래된 기록은 더 이상 쓸 일이 없다.
    this.history = this.history.filter((h) => h.tick >= lastInputTick)

    if (Math.hypot(errorX, errorZ) > RECONCILE_SNAP_DIST) {
      // 크게 어긋났으면(레벨 전환, 긴 끊김 등) 부드럽게 끌고 가봐야 어색하다.
      this.applyCorrection(errorX, errorZ)
      this.pending.x = 0
      this.pending.z = 0
      return
    }

    // 누적(+=)이 아니라 대입(=)이어야 한다.
    // applyCorrection 이 history 까지 함께 보정하므로, 여기서 나온 errorX 는
    // 이미 지금까지 적용한 보정이 반영된 "남은 오차"다. 이걸 더하면 같은 오차를
    // 두 번 세게 되어 과보정 → 진동으로 이어진다.
    this.pending.x = errorX
    this.pending.z = errorZ
  }

  /** 보정은 현재 위치와 예측 기록에 함께 적용해야 다음 스냅샷에서 이중 보정되지 않는다. */
  private applyCorrection(dx: number, dz: number) {
    this.predicted.x += dx
    this.predicted.z += dz
    this.previous.x += dx
    this.previous.z += dz
    for (const record of this.history) {
      record.x += dx
      record.z += dz
    }
  }

  // -------------------------------------------------------------------------
  // 송신 & 예측
  // -------------------------------------------------------------------------

  /** 매 프레임 현재 조작 의도를 넣어준다. 실제 전송은 고정 스텝에서 일어난다. */
  setInput(
    dx: number,
    dz: number,
    yaw: number,
    interact = false,
    sprint = false,
    attack = false,
  ): void {
    this.desiredInput = { dx, dz, yaw, interact, sprint, attack }
    this.yaw = yaw
  }

  /** 상점에 구매를 요청한다. 성공 여부는 다음 스냅샷의 골드/인벤토리로 확인된다. */
  buy(itemId: number): void {
    this.transport.send(encodeJson(MsgType.Buy, { itemId }), true)
  }

  /** 매 프레임 호출. dt 초. */
  update(dt: number): void {
    if (!this.maze) return

    this.stepAccumulator += dt
    // 탭이 백그라운드에 갔다 오면 밀린 시간이 크다. 전부 따라잡으면 순간이동한다.
    let budget = 5
    while (this.stepAccumulator >= TICK_DT && budget-- > 0) {
      this.stepAccumulator -= TICK_DT
      this.stepPrediction()
    }
    if (this.stepAccumulator > TICK_DT * 5) this.stepAccumulator = 0

    // 누적된 오차를 시간 기준으로 감쇠시킨다.
    // 프레임당 고정 비율로 깎으면 프레임레이트에 따라 수렴 속도가 달라진다.
    if (this.pending.x !== 0 || this.pending.z !== 0) {
      const factor = 1 - Math.exp(-dt / RECONCILE_TAU)
      const stepX = this.pending.x * factor
      const stepZ = this.pending.z * factor
      this.applyCorrection(stepX, stepZ)
      this.pending.x -= stepX
      this.pending.z -= stepZ
      if (Math.abs(this.pending.x) < 1e-4) this.pending.x = 0
      if (Math.abs(this.pending.z) < 1e-4) this.pending.z = 0
    }

    this.markExplored()
  }

  /**
   * 고정 스텝 한 번: 입력에 번호를 붙여 보내고, 호스트와 똑같은 dt 로 이동시킨 뒤
   * 그 결과를 기록한다. 호스트도 lastInputTick 을 "적용한 뒤"의 위치와 함께 돌려주므로
   * 기록과 권위 위치가 같은 시점을 가리키게 된다.
   */
  private stepPrediction() {
    this.previous.x = this.predicted.x
    this.previous.z = this.predicted.z

    this.inputTick++
    const input: PlayerInput = {
      tick: this.inputTick,
      dx: this.desiredInput.dx,
      dz: this.desiredInput.dz,
      yaw: this.desiredInput.yaw,
      interact: this.desiredInput.interact,
      sprint: this.desiredInput.sprint,
      attack: this.desiredInput.attack,
    }
    this.transport.send(encodeInput(input), false)

    if (!this.localEscaped && !this.cleared && !this.stunned && !this.downed) {
      // 아이템과 달리기가 속도를 바꾸므로 예측도 같은 조건으로 계산해야 호스트와 어긋나지 않는다.
      const sprinting = input.sprint && this.stamina > 0 && Math.hypot(input.dx, input.dz) > 0.01
      movePlayer(this.maze!, this.predicted, input, TICK_DT, this.inventory, sprinting)
    }

    this.history.push({ tick: this.inputTick, x: this.predicted.x, z: this.predicted.z })
    while (this.history.length > 120) this.history.shift()
  }

  /** 스텝 사이를 메운 화면용 위치. 20Hz 예측을 60fps 로 부드럽게 보여준다. */
  renderPosition(): { x: number; z: number } {
    const alpha = Math.min(1, Math.max(0, this.stepAccumulator / TICK_DT))
    return {
      x: lerp(this.previous.x, this.predicted.x, alpha),
      z: lerp(this.previous.z, this.predicted.z, alpha),
    }
  }

  private markExplored() {
    if (!this.maze) return
    const radius = revealRadiusFor(this.inventory)
    for (const player of this.renderPlayers()) {
      const cell = worldToCell(this.maze, player.x, player.z)
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const x = cell.x + dx
          const y = cell.y + dy
          if (x < 0 || y < 0 || x >= this.maze.w || y >= this.maze.h) continue
          this.explored.add(y * this.maze.w + x)
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // 렌더링용 조회
  // -------------------------------------------------------------------------

  /** 보간 대상이 되는 두 스냅샷과 그 사이 비율. */
  private interpolationWindow(): { a: SnapshotMsg; b: SnapshotMsg; t: number } | null {
    if (this.snapshots.length === 0) return null
    const renderTime = performance.now() - INTERP_DELAY_MS

    for (let i = this.snapshots.length - 1; i > 0; i--) {
      const b = this.snapshots[i]
      const a = this.snapshots[i - 1]
      if (a.recvTime <= renderTime && renderTime <= b.recvTime) {
        const span = b.recvTime - a.recvTime
        const t = span > 0 ? (renderTime - a.recvTime) / span : 0
        return { a: a.snapshot, b: b.snapshot, t }
      }
    }

    // 렌더 시각이 버퍼 밖이면(패킷이 끊겼거나 막 접속했으면) 가장 가까운 것을 쓴다.
    const last = this.snapshots[this.snapshots.length - 1].snapshot
    const first = this.snapshots[0].snapshot
    return renderTime > this.snapshots[this.snapshots.length - 1].recvTime
      ? { a: last, b: last, t: 0 }
      : { a: first, b: first, t: 0 }
  }

  renderPlayers(): RenderPlayer[] {
    const window = this.interpolationWindow()
    if (!window) return []
    const { a, b, t } = window

    const local = this.renderPosition()
    return a.players.map((pa) => {
      const pb = b.players.find((p) => p.id === pa.id) ?? pa
      const isLocal = pa.id === this.playerId
      return {
        id: pa.id,
        name: this.names.get(pa.id) ?? `Player ${pa.id}`,
        // 로컬 플레이어는 보간값 대신 예측값을 쓴다. 그래야 입력이 즉시 반응한다.
        x: isLocal ? local.x : lerp(pa.x, pb.x, t),
        z: isLocal ? local.z : lerp(pa.z, pb.z, t),
        yaw: isLocal ? this.yaw : lerpAngle(pa.yaw, pb.yaw, t),
        escaped: pb.escaped,
        isLocal,
        gold: pb.gold,
        inventory: pb.inventory,
      }
    })
  }

  renderKeys(): RenderKey[] {
    const window = this.interpolationWindow()
    if (!window) return []
    const { a, b, t } = window

    return a.keys.map((ka, i) => {
      const kb = b.keys[i] ?? ka
      // 들고 있는 사람이 나라면 예측 위치를 따라가야 열쇠가 뒤에 끌려오지 않는다.
      if (kb.collected && kb.carrier === this.playerId) {
        const local = this.renderPosition()
        return { x: local.x, z: local.z, collected: true, carrier: kb.carrier }
      }
      return {
        x: lerp(ka.x, kb.x, t),
        z: lerp(ka.z, kb.z, t),
        collected: kb.collected,
        carrier: kb.carrier,
      }
    })
  }

  renderEnemies(): RenderEnemy[] {
    const window = this.interpolationWindow()
    if (!window) return []
    const { a, b, t } = window

    // 적은 매 스냅샷마다 목록이 바뀔 수 있다(죽거나, 잘려서 빠지거나).
    // 최신 스냅샷을 기준으로 삼고, 이전 스냅샷에 같은 id 가 있을 때만 보간한다.
    return b.enemies.map((eb) => {
      const ea = a.enemies.find((e) => e.id === eb.id)
      if (!ea) return { ...eb, hp: eb.hp / 255 }
      return {
        id: eb.id,
        kind: eb.kind,
        x: lerp(ea.x, eb.x, t),
        z: lerp(ea.z, eb.z, t),
        yaw: lerpAngle(ea.yaw, eb.yaw, t),
        hp: eb.hp / 255,
        windup: eb.windup,
      }
    })
  }

  renderProjectiles(): RenderProjectile[] {
    const window = this.interpolationWindow()
    if (!window) return []
    const { a, b, t } = window
    return b.projectiles.map((pb) => {
      const pa = a.projectiles.find((p) => p.id === pb.id)
      if (!pa) return pb
      return { id: pb.id, x: lerp(pa.x, pb.x, t), z: lerp(pa.z, pb.z, t) }
    })
  }

  localPlayer(): RenderPlayer | null {
    return this.renderPlayers().find((p) => p.isLocal) ?? null
  }

  dispose(): void {
    this.transport.close()
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 각도 보간. -PI/PI 경계에서 한 바퀴 도는 것을 막는다. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t
}
