/**
 * 호스트 권한형 게임 루프.
 *
 * 전송 방식에 대한 의존이 없다. HostTransport 만 주면 InProcess / WebSocket /
 * (나중에) Steam P2P 어디에서든 똑같이 동작한다.
 */
import { MAX_PLAYERS, TICK_MS } from '../shared/constants'
import {
  MsgType,
  SNAPSHOT_MAX_BYTES,
  decodeInput,
  decodeJson,
  encodeJson,
  encodeSnapshot,
  messageType,
  type JoinMsg,
  type LevelMsg,
  type RosterMsg,
  type SnapshotMsg,
  type WelcomeMsg,
} from '../shared/protocol'
import {
  addPlayer,
  createGameState,
  removePlayer,
  stepGame,
  type GameState,
  type PlayerInput,
} from '../shared/sim'
import type { HostTransport, PeerId } from '../net/transport'

export interface GameHostOptions {
  level?: number
  seed?: number
  onStateReplaced?: (state: GameState) => void
}

export class GameHost {
  state: GameState
  private transport: HostTransport
  private inputs = new Map<number, PlayerInput>()
  private peerToPlayer = new Map<PeerId, number>()
  private playerToPeer = new Map<number, PeerId>()
  private nextPlayerId = 1
  private timer: ReturnType<typeof setInterval> | null = null
  private lastTime = 0
  private accumulator = 0
  private onStateReplaced?: (state: GameState) => void
  /** 스냅샷이 1200바이트를 넘은 적이 있으면 한 번만 경고한다. */
  private warnedOversize = false

  constructor(transport: HostTransport, options: GameHostOptions = {}) {
    this.transport = transport
    this.onStateReplaced = options.onStateReplaced
    this.state = createGameState(options.level ?? 1, options.seed ?? 1)

    transport.onPeerJoin((peer) => this.handleJoin(peer))
    transport.onPeerLeave((peer) => this.handleLeave(peer))
    transport.onMessage((peer, data) => this.handleMessage(peer, data))
  }

  start(): void {
    if (this.timer !== null) return
    this.lastTime = performance.now()
    this.accumulator = 0
    // 틱 주기의 절반으로 깨워서 타이머 지터를 누산기로 흡수한다.
    this.timer = setInterval(() => this.pump(), TICK_MS / 2)
  }

  stop(): void {
    if (this.timer === null) return
    clearInterval(this.timer)
    this.timer = null
  }

  playerCount(): number {
    return this.state.players.size
  }

  private pump() {
    const now = performance.now()
    this.accumulator += now - this.lastTime
    this.lastTime = now

    // 탭이 백그라운드로 갔다 돌아오면 누산기가 크게 밀린다.
    // 밀린 만큼 전부 따라잡으면 순간이동처럼 보이므로 상한을 둔다.
    let budget = 5
    while (this.accumulator >= TICK_MS && budget-- > 0) {
      this.accumulator -= TICK_MS
      this.tick()
    }
    if (this.accumulator > TICK_MS * 5) this.accumulator = 0
  }

  private tick() {
    const replaced = stepGame(this.state, this.inputs)
    if (replaced) {
      this.state = replaced
      this.inputs.clear()
      const msg: LevelMsg = { level: replaced.level, seed: replaced.seed, tick: replaced.tick }
      this.transport.broadcast(encodeJson(MsgType.Level, msg), true)
      this.onStateReplaced?.(replaced)
    }
    this.broadcastSnapshot()
  }

  private broadcastSnapshot() {
    const msg: SnapshotMsg = {
      tick: this.state.tick,
      level: this.state.level,
      exitOpen: this.state.exitOpen,
      cleared: this.state.phase === 'cleared',
      players: [...this.state.players.values()].map((p) => ({
        id: p.id,
        x: p.x,
        z: p.z,
        yaw: p.yaw,
        escaped: p.escaped,
        lastInputTick: p.lastInputTick,
      })),
      keys: this.state.keys.map((k) => ({
        x: k.x,
        z: k.z,
        collected: k.collected,
        carrier: k.carrier,
      })),
    }

    const encoded = encodeSnapshot(msg)
    if (encoded.length > SNAPSHOT_MAX_BYTES && !this.warnedOversize) {
      this.warnedOversize = true
      console.warn(
        `[host] 스냅샷이 ${encoded.length} 바이트로 스팀 Unreliable 상한(${SNAPSHOT_MAX_BYTES})을 넘었습니다. ` +
          '전송을 쪼개거나 필드를 줄여야 합니다.',
      )
    }
    this.transport.broadcast(encoded, false)
  }

  private handleJoin(peer: PeerId) {
    if (this.state.players.size >= MAX_PLAYERS) {
      // 정원 초과. 조용히 무시하는 대신 로그를 남긴다.
      console.warn(`[host] 정원이 가득 차 ${peer} 의 참가를 거절했습니다.`)
      return
    }
    const playerId = this.nextPlayerId++
    this.peerToPlayer.set(peer, playerId)
    this.playerToPeer.set(playerId, peer)
    addPlayer(this.state, playerId, `Player ${playerId}`)

    const welcome: WelcomeMsg = {
      playerId,
      level: this.state.level,
      seed: this.state.seed,
      tick: this.state.tick,
    }
    this.transport.sendTo(peer, encodeJson(MsgType.Welcome, welcome), true)
    this.broadcastRoster()
  }

  private handleLeave(peer: PeerId) {
    const playerId = this.peerToPlayer.get(peer)
    if (playerId === undefined) return
    this.peerToPlayer.delete(peer)
    this.playerToPeer.delete(playerId)
    this.inputs.delete(playerId)
    removePlayer(this.state, playerId)
    this.broadcastRoster()
  }

  private handleMessage(peer: PeerId, data: Uint8Array) {
    const playerId = this.peerToPlayer.get(peer)
    if (playerId === undefined) return

    switch (messageType(data)) {
      case MsgType.Input: {
        const input = decodeInput(data)
        const previous = this.inputs.get(playerId)
        // UDP 는 순서를 보장하지 않는다. 늦게 도착한 오래된 입력은 버린다.
        if (previous && previous.tick > input.tick) return
        this.inputs.set(playerId, input)
        break
      }
      case MsgType.Join: {
        const join = decodeJson<JoinMsg>(data)
        const player = this.state.players.get(playerId)
        if (player && join.name) {
          player.name = join.name.slice(0, 16)
          this.broadcastRoster()
        }
        break
      }
      default:
        break
    }
  }

  private broadcastRoster() {
    const msg: RosterMsg = {
      players: [...this.state.players.values()].map((p) => ({ id: p.id, name: p.name })),
    }
    this.transport.broadcast(encodeJson(MsgType.Roster, msg), true)
  }
}
