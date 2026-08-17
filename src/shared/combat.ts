/**
 * 전투 관련 정의와 수치.
 *
 * 여기에는 상태 변경이 없다. 순수한 수치와 판정 헬퍼만 둔다.
 * 실제 갱신은 sim.ts 의 틱 루프에서 일어난다.
 */
import { CELL } from './constants'

// ---------------------------------------------------------------------------
// 플레이어 스탯
// ---------------------------------------------------------------------------

export const PLAYER_MAX_HP = 100
export const PLAYER_MAX_STAMINA = 100

/** 달릴 때 속도 배율. */
export const SPRINT_MULTIPLIER = 1.6
/** 달리는 동안 초당 소모하는 스태미나. */
export const SPRINT_STAMINA_PER_SEC = 22
/** 공격 한 번에 소모하는 스태미나. */
export const ATTACK_STAMINA_COST = 18

/** 아무것도 안 할 때 초당 회복량. */
export const STAMINA_REGEN_PER_SEC = 16
/** 회복이 시작되기까지의 대기(초). 소모 직후 바로 차오르면 무한히 달릴 수 있다. */
export const STAMINA_REGEN_DELAY = 0.6

/**
 * 스태미나를 다 쓰면 경직에 걸린다. 이 시간 동안 움직이거나 공격할 수 없다.
 * 경직이 끝나면 스태미나가 빠르게 채워진다.
 */
export const EXHAUST_STUN_SEC = 1.2
export const EXHAUST_REFILL_PER_SEC = 55

/** 공격 사거리와 각도. 부채꼴 안에 들어온 적이 맞는다. */
export const ATTACK_RANGE = 3.2
export const ATTACK_HALF_ANGLE = Math.PI / 3
export const ATTACK_DAMAGE = 26
/** 공격 후 다음 공격까지의 간격(초). */
export const ATTACK_COOLDOWN = 0.45
/** 공격 모션이 보이는 시간(초). 렌더링용. */
export const ATTACK_SWING_SEC = 0.18

/** 피격 후 무적 시간(초). 없으면 적에게 둘러싸였을 때 순식간에 죽는다. */
export const HIT_INVULN_SEC = 0.6

/** 쓰러진 뒤 부활까지(초)와 부활 시 회복량. */
export const DOWN_RESPAWN_SEC = 5
export const RESPAWN_HP_RATIO = 0.5

// ---------------------------------------------------------------------------
// 적
// ---------------------------------------------------------------------------

export const EnemyKind = {
  /** 물어뜯는 녀석. 빠르게 달려와서 짧은 사거리로 문다. */
  Biter: 0,
  /** 밀리. 느리지만 단단하고 한 방이 아프다. */
  Brute: 1,
  /** 멀리서 마법을 쏘는 녀석. 가까워지면 물러난다. */
  Caster: 2,
  /** 방을 지키는 중간 보스. */
  Boss: 3,
} as const

export type EnemyKindValue = (typeof EnemyKind)[keyof typeof EnemyKind]

export interface EnemyDef {
  kind: EnemyKindValue
  name: string
  maxHp: number
  speed: number
  /** 플레이어를 인지하는 거리. */
  aggroRange: number
  /** 공격이 닿는 거리. */
  attackRange: number
  attackDamage: number
  /** 공격 간격(초). */
  attackCooldown: number
  /** 공격 예비 동작(초). 이 시간이 있어야 피할 여지가 생긴다. */
  windup: number
  /** 원거리 공격을 쓰는가. */
  ranged: boolean
  /** 이 거리보다 가까우면 물러난다. 원거리 적만 사용. */
  keepDistance: number
  radius: number
  /** 처치 시 골드. */
  gold: number
}

export const ENEMY_DEFS: Record<EnemyKindValue, EnemyDef> = {
  [EnemyKind.Biter]: {
    kind: EnemyKind.Biter,
    name: '물어뜯는 놈',
    maxHp: 40,
    speed: 7.4,
    aggroRange: CELL * 3,
    attackRange: 1.9,
    attackDamage: 9,
    attackCooldown: 0.9,
    windup: 0.18,
    ranged: false,
    keepDistance: 0,
    radius: 0.5,
    gold: 6,
  },
  [EnemyKind.Brute]: {
    kind: EnemyKind.Brute,
    name: '둔중한 놈',
    maxHp: 90,
    speed: 4.2,
    aggroRange: CELL * 2.5,
    attackRange: 2.6,
    attackDamage: 18,
    attackCooldown: 1.6,
    windup: 0.5,
    ranged: false,
    keepDistance: 0,
    radius: 0.75,
    gold: 12,
  },
  [EnemyKind.Caster]: {
    kind: EnemyKind.Caster,
    name: '주문술사',
    maxHp: 35,
    speed: 3.6,
    aggroRange: CELL * 4,
    attackRange: CELL * 3.5,
    attackDamage: 12,
    attackCooldown: 2.0,
    windup: 0.6,
    ranged: true,
    keepDistance: CELL * 1.6,
    radius: 0.5,
    gold: 14,
  },
  [EnemyKind.Boss]: {
    kind: EnemyKind.Boss,
    name: '방의 주인',
    maxHp: 260,
    speed: 5.0,
    aggroRange: CELL * 4,
    attackRange: 3.2,
    attackDamage: 22,
    attackCooldown: 1.4,
    windup: 0.45,
    // 근접이 기본이지만 멀면 마법을 쏜다. sim 에서 거리로 갈라 쓴다.
    ranged: false,
    keepDistance: 0,
    radius: 1.1,
    gold: 60,
  },
}

/** 보스가 멀리 있는 상대에게 쓰는 원거리 공격 사거리. */
export const BOSS_RANGED_RANGE = CELL * 4

// ---------------------------------------------------------------------------
// 투사체
// ---------------------------------------------------------------------------

export const PROJECTILE_SPEED = 13
export const PROJECTILE_RADIUS = 0.35
/** 최대 비행 시간(초). 벽을 못 맞혀도 언젠가는 사라져야 한다. */
export const PROJECTILE_TTL = 3

// ---------------------------------------------------------------------------

/** 부채꼴 안에 있는지. 플레이어 공격 판정에 쓴다. */
export function inAttackCone(
  fromX: number,
  fromZ: number,
  yaw: number,
  targetX: number,
  targetZ: number,
  range: number,
  halfAngle: number,
): boolean {
  const dx = targetX - fromX
  const dz = targetZ - fromZ
  const dist = Math.hypot(dx, dz)
  if (dist > range) return false
  // 바로 겹쳐 있으면 각도를 따질 수 없다. 맞은 것으로 본다.
  if (dist < 1e-4) return true

  // yaw 0 은 +Z 를 본다.
  const forwardX = Math.sin(yaw)
  const forwardZ = Math.cos(yaw)
  const cos = (dx * forwardX + dz * forwardZ) / dist
  return cos >= Math.cos(halfAngle)
}
