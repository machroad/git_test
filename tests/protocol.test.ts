import { describe, expect, it } from 'vitest'
import { MAX_PLAYERS } from '../src/shared/constants'
import {
  MsgType,
  SNAPSHOT_MAX_BYTES,
  decodeInput,
  decodeJson,
  decodeSnapshot,
  encodeInput,
  encodeJson,
  encodeSnapshot,
  messageType,
  wrapAngle,
  type SnapshotMsg,
} from '../src/shared/protocol'

describe('프로토콜', () => {
  it('입력을 왕복시켜도 값이 유지된다', () => {
    const original = { tick: 4242, dx: 0.71, dz: -0.7, yaw: 2.13 }
    const decoded = decodeInput(encodeInput(original))
    expect(decoded.tick).toBe(original.tick)
    expect(decoded.dx).toBeCloseTo(original.dx, 1)
    expect(decoded.dz).toBeCloseTo(original.dz, 1)
    expect(decoded.yaw).toBeCloseTo(original.yaw, 2)
  })

  it('스냅샷을 왕복시켜도 값이 유지된다', () => {
    const snapshot: SnapshotMsg = {
      tick: 900,
      level: 3,
      exitOpen: true,
      cleared: false,
      players: [
        { id: 1, x: 12.34, z: 56.78, yaw: 1.5, escaped: false, lastInputTick: 300 },
        { id: 2, x: 0.5, z: 163.9, yaw: -2.9, escaped: true, lastInputTick: 299 },
      ],
      keys: [{ x: 40.25, z: 41.5, collected: true, carrier: 2 }],
    }

    const decoded = decodeSnapshot(encodeSnapshot(snapshot))
    expect(decoded.tick).toBe(900)
    expect(decoded.level).toBe(3)
    expect(decoded.exitOpen).toBe(true)
    expect(decoded.cleared).toBe(false)
    expect(decoded.players).toHaveLength(2)
    expect(decoded.players[0].x).toBeCloseTo(12.34, 2)
    expect(decoded.players[1].escaped).toBe(true)
    expect(decoded.players[1].lastInputTick).toBe(299)
    expect(decoded.keys[0].carrier).toBe(2)
    expect(decoded.keys[0].collected).toBe(true)
  })

  it('열쇠를 아무도 안 들고 있으면 carrier 가 -1 로 돌아온다', () => {
    const snapshot: SnapshotMsg = {
      tick: 1,
      level: 1,
      exitOpen: false,
      cleared: false,
      players: [],
      keys: [{ x: 1, z: 2, collected: false, carrier: -1 }],
    }
    expect(decodeSnapshot(encodeSnapshot(snapshot)).keys[0].carrier).toBe(-1)
  })

  it('정원이 가득 찬 스냅샷도 스팀 Unreliable 상한 안에 들어간다', () => {
    // 1200 바이트를 넘으면 스팀 P2P 의 Unreliable 전송이 실패한다.
    const snapshot: SnapshotMsg = {
      tick: 0xffffff,
      level: 12,
      exitOpen: true,
      cleared: true,
      players: Array.from({ length: MAX_PLAYERS }, (_, i) => ({
        id: i + 1,
        x: 163.99,
        z: 163.99,
        yaw: Math.PI,
        escaped: true,
        lastInputTick: 0xffffff,
      })),
      keys: Array.from({ length: 8 }, () => ({ x: 100, z: 100, collected: true, carrier: 1 })),
    }
    expect(encodeSnapshot(snapshot).length).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES)
  })

  it('JSON 메시지의 타입 바이트를 읽을 수 있다', () => {
    const encoded = encodeJson(MsgType.Welcome, { playerId: 2, level: 1, seed: 9, tick: 0 })
    expect(messageType(encoded)).toBe(MsgType.Welcome)
    expect(decodeJson<{ playerId: number }>(encoded).playerId).toBe(2)
  })

  it('각도를 -PI..PI 로 정규화한다', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI, 5)
    expect(wrapAngle(-Math.PI * 3)).toBeCloseTo(-Math.PI, 5)
    expect(wrapAngle(0.5)).toBeCloseTo(0.5, 5)
  })
})
