/**
 * 런(run) 설정.
 *
 * 레벨을 코드에 박아두지 않고 데이터로 뺐다. 테스트할 때 "10x10 에 열쇠 3개"
 * 같은 조합을 바로 만들어보려면 이게 있어야 한다.
 *
 * 호스트가 이 설정을 들고 있고, 참가할 때 클라이언트로 그대로 보낸다.
 * 미로는 여전히 전송하지 않는다 — 설정 + 시드가 같으면 각자 같은 미로를 만든다.
 */

export interface LevelConfig {
  /** 미로 가로 칸 수. */
  width: number
  /** 미로 세로 칸 수. */
  height: number
  /** 뚫을 사각형 방 개수. */
  roomCount: number
  /** 탈출구를 열기 위해 모아야 하는 열쇠 개수. */
  keyCount: number
}

export interface RunConfig {
  levels: LevelConfig[]
}

export const LEVEL_LIMITS = {
  width: { min: 7, max: 41 },
  height: { min: 7, max: 41 },
  roomCount: { min: 0, max: 8 },
  keyCount: { min: 1, max: 6 },
} as const

/** 레벨을 추가할 때 쓰는 기본값. 이전 레벨보다 조금씩 커진다. */
export function nextLevelDefaults(previous?: LevelConfig): LevelConfig {
  if (!previous) return { width: 15, height: 15, roomCount: 2, keyCount: 1 }
  return {
    width: clampField('width', previous.width + 4),
    height: clampField('height', previous.height + 4),
    roomCount: clampField('roomCount', previous.roomCount + 1),
    keyCount: clampField('keyCount', previous.keyCount + (previous.keyCount < 3 ? 1 : 0)),
  }
}

export const DEFAULT_RUN_CONFIG: RunConfig = {
  levels: [
    { width: 15, height: 15, roomCount: 2, keyCount: 1 },
    { width: 19, height: 19, roomCount: 3, keyCount: 2 },
    { width: 23, height: 23, roomCount: 4, keyCount: 3 },
  ],
}

export function clampField(field: keyof typeof LEVEL_LIMITS, value: number): number {
  const limit = LEVEL_LIMITS[field]
  if (!Number.isFinite(value)) return limit.min
  return Math.min(limit.max, Math.max(limit.min, Math.round(value)))
}

/**
 * 바깥에서 들어온 설정을 안전한 범위로 정리한다.
 * 설정 화면과 localStorage, 두 경로 모두 사용자가 손댈 수 있어서 반드시 거쳐야 한다.
 */
export function sanitizeRunConfig(raw: unknown): RunConfig {
  const levels: LevelConfig[] = []
  const rawLevels = (raw as RunConfig | null)?.levels
  if (Array.isArray(rawLevels)) {
    for (const level of rawLevels) {
      if (!level || typeof level !== 'object') continue
      levels.push({
        width: clampField('width', Number((level as LevelConfig).width)),
        height: clampField('height', Number((level as LevelConfig).height)),
        roomCount: clampField('roomCount', Number((level as LevelConfig).roomCount)),
        keyCount: clampField('keyCount', Number((level as LevelConfig).keyCount)),
      })
    }
  }
  // 레벨이 하나도 없으면 게임이 성립하지 않는다.
  if (levels.length === 0) return { levels: DEFAULT_RUN_CONFIG.levels.map((l) => ({ ...l })) }
  return { levels }
}

export function levelAt(config: RunConfig, index: number): LevelConfig {
  return config.levels[Math.min(config.levels.length - 1, Math.max(0, index))]
}
