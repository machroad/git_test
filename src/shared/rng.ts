/**
 * 시드 기반 난수 (mulberry32).
 *
 * 미로를 시드로부터 결정론적으로 생성할 수 있으면, 네트워크로 미로 데이터를
 * 통째로 보낼 필요 없이 시드 하나(4바이트)만 보내면 된다.
 * Math.random() 을 쓰면 이 성질이 깨지므로 게임 로직에서는 절대 쓰지 않는다.
 */
export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** [0, n) 정수 */
export function randInt(rng: Rng, n: number): number {
  return Math.floor(rng() * n)
}

/** 제자리 셔플 (Fisher-Yates) */
export function shuffle<T>(rng: Rng, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1)
    ;[arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr
}
