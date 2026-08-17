/**
 * 전송 프로토콜.
 *
 * 자주 오가는 것(입력 / 스냅샷)은 바이너리로 촘촘히 싸고, 드물게 오가는 것
 * (참가 / 레벨 전환)은 JSON 으로 둔다. 디버깅 편의와 대역폭을 둘 다 챙기는
 * 흔한 절충이다.
 *
 * 스팀 P2P 의 Unreliable 패킷은 1200 바이트가 상한이다. 스냅샷은 이 한도 안에
 * 들어와야 하므로 SNAPSHOT_MAX_BYTES 로 검증한다.
 */

import type { RunConfig } from './config'
import type { Zone } from './sim'

export const SNAPSHOT_MAX_BYTES = 1200

export const MsgType = {
  Join: 1,
  Welcome: 2,
  Zone: 3,
  Input: 4,
  Snapshot: 5,
  Roster: 6,
  Buy: 7,
} as const

export type MsgTypeValue = (typeof MsgType)[keyof typeof MsgType]

// ---------------------------------------------------------------------------
// JSON 메시지
// ---------------------------------------------------------------------------

export interface JoinMsg {
  name: string
}

export interface WelcomeMsg {
  playerId: number
  seed: number
  tick: number
  /** 런 설정 전체. 이게 있어야 클라이언트가 미로를 직접 만들 수 있다. */
  config: RunConfig
  zone: ZoneMsg
}

/** 존/레벨 전환. 미로 데이터가 아니라 "어느 존의 몇 번째 레벨인지"만 보낸다. */
export interface ZoneMsg {
  zone: Zone
  levelIndex: number
  tick: number
}

export interface BuyMsg {
  itemId: number
}

export interface RosterMsg {
  players: { id: number; name: string }[]
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeJson(type: MsgTypeValue, payload: unknown): Uint8Array {
  const body = encoder.encode(JSON.stringify(payload))
  const out = new Uint8Array(body.length + 1)
  out[0] = type
  out.set(body, 1)
  return out
}

export function decodeJson<T>(data: Uint8Array): T {
  return JSON.parse(decoder.decode(data.subarray(1))) as T
}

export function messageType(data: Uint8Array): number {
  return data[0]
}

// ---------------------------------------------------------------------------
// 입력 (클라이언트 → 호스트)
// ---------------------------------------------------------------------------

export interface InputMsg {
  tick: number
  dx: number
  dz: number
  yaw: number
  interact: boolean
}

const INPUT_BYTES = 1 + 4 + 1 + 1 + 2 + 1
const FLAG_INTERACT = 1

export function encodeInput(msg: InputMsg): Uint8Array {
  const buf = new ArrayBuffer(INPUT_BYTES)
  const view = new DataView(buf)
  view.setUint8(0, MsgType.Input)
  view.setUint32(1, msg.tick >>> 0)
  view.setInt8(5, clamp(Math.round(msg.dx * 100), -100, 100))
  view.setInt8(6, clamp(Math.round(msg.dz * 100), -100, 100))
  view.setInt16(7, clamp(Math.round(wrapAngle(msg.yaw) * 5000), -32768, 32767))
  view.setUint8(9, msg.interact ? FLAG_INTERACT : 0)
  return new Uint8Array(buf)
}

export function decodeInput(data: Uint8Array): InputMsg {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return {
    tick: view.getUint32(1),
    dx: view.getInt8(5) / 100,
    dz: view.getInt8(6) / 100,
    yaw: view.getInt16(7) / 5000,
    interact: (view.getUint8(9) & FLAG_INTERACT) !== 0,
  }
}

// ---------------------------------------------------------------------------
// 스냅샷 (호스트 → 클라이언트)
// ---------------------------------------------------------------------------

export interface SnapshotPlayer {
  id: number
  x: number
  z: number
  yaw: number
  escaped: boolean
  lastInputTick: number
  gold: number
  inventory: number
}

export interface SnapshotKey {
  x: number
  z: number
  collected: boolean
  carrier: number
}

export interface SnapshotMsg {
  tick: number
  /** 로비는 -1, 던전은 레벨 인덱스. 클라이언트가 자기 존과 맞는지 확인한다. */
  levelIndex: number
  exitOpen: boolean
  cleared: boolean
  players: SnapshotPlayer[]
  keys: SnapshotKey[]
}

const SNAP_HEADER = 1 + 4 + 2 + 1 + 1
const SNAP_PLAYER = 1 + 2 + 2 + 2 + 1 + 4 + 2 + 1
const SNAP_KEY = 1 + 2 + 2 + 1

const FLAG_EXIT_OPEN = 1
const FLAG_CLEARED = 2
const FLAG_ESCAPED = 1
const FLAG_COLLECTED = 1

export function encodeSnapshot(msg: SnapshotMsg): Uint8Array {
  const size = SNAP_HEADER + msg.players.length * SNAP_PLAYER + 1 + msg.keys.length * SNAP_KEY
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)

  let o = 0
  view.setUint8(o, MsgType.Snapshot); o += 1
  view.setUint32(o, msg.tick >>> 0); o += 4
  // 로비(-1)를 부호 없는 값으로 옮겨 담는다.
  view.setUint16(o, msg.levelIndex + 1); o += 2
  view.setUint8(o, (msg.exitOpen ? FLAG_EXIT_OPEN : 0) | (msg.cleared ? FLAG_CLEARED : 0)); o += 1
  view.setUint8(o, msg.players.length); o += 1

  for (const p of msg.players) {
    view.setUint8(o, p.id); o += 1
    view.setInt16(o, coordToInt(p.x)); o += 2
    view.setInt16(o, coordToInt(p.z)); o += 2
    view.setInt16(o, clamp(Math.round(wrapAngle(p.yaw) * 5000), -32768, 32767)); o += 2
    view.setUint8(o, p.escaped ? FLAG_ESCAPED : 0); o += 1
    view.setUint32(o, p.lastInputTick >>> 0); o += 4
    view.setUint16(o, clamp(Math.round(p.gold), 0, 65535)); o += 2
    view.setUint8(o, p.inventory & 0xff); o += 1
  }

  view.setUint8(o, msg.keys.length); o += 1
  for (const k of msg.keys) {
    view.setUint8(o, k.collected ? FLAG_COLLECTED : 0); o += 1
    view.setInt16(o, coordToInt(k.x)); o += 2
    view.setInt16(o, coordToInt(k.z)); o += 2
    view.setUint8(o, k.carrier < 0 ? 255 : k.carrier); o += 1
  }

  return new Uint8Array(buf)
}

export function decodeSnapshot(data: Uint8Array): SnapshotMsg {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let o = 1
  const tick = view.getUint32(o); o += 4
  const levelIndex = view.getUint16(o) - 1; o += 2
  const flags = view.getUint8(o); o += 1
  const playerCount = view.getUint8(o); o += 1

  const players: SnapshotPlayer[] = []
  for (let i = 0; i < playerCount; i++) {
    const id = view.getUint8(o); o += 1
    const x = intToCoord(view.getInt16(o)); o += 2
    const z = intToCoord(view.getInt16(o)); o += 2
    const yaw = view.getInt16(o) / 5000; o += 2
    const pflags = view.getUint8(o); o += 1
    const lastInputTick = view.getUint32(o); o += 4
    const gold = view.getUint16(o); o += 2
    const inventory = view.getUint8(o); o += 1
    players.push({
      id,
      x,
      z,
      yaw,
      escaped: (pflags & FLAG_ESCAPED) !== 0,
      lastInputTick,
      gold,
      inventory,
    })
  }

  const keyCount = view.getUint8(o); o += 1
  const keys: SnapshotKey[] = []
  for (let i = 0; i < keyCount; i++) {
    const kflags = view.getUint8(o); o += 1
    const x = intToCoord(view.getInt16(o)); o += 2
    const z = intToCoord(view.getInt16(o)); o += 2
    const carrier = view.getUint8(o); o += 1
    keys.push({ x, z, collected: (kflags & FLAG_COLLECTED) !== 0, carrier: carrier === 255 ? -1 : carrier })
  }

  return {
    tick,
    levelIndex,
    exitOpen: (flags & FLAG_EXIT_OPEN) !== 0,
    cleared: (flags & FLAG_CLEARED) !== 0,
    players,
    keys,
  }
}

// ---------------------------------------------------------------------------

/** 좌표는 cm 단위 고정소수점. 미로 최대 41칸 * 4단위 = 164 이므로 i16 에 넉넉히 들어간다. */
function coordToInt(v: number): number {
  return clamp(Math.round(v * 100), -32768, 32767)
}

function intToCoord(v: number): number {
  return v / 100
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** 각도를 -PI..PI 로 정규화. i16 고정소수점에 담기 위해 필요하다. */
export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2
  let x = a % twoPi
  if (x > Math.PI) x -= twoPi
  if (x < -Math.PI) x += twoPi
  return x
}
