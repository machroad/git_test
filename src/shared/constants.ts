/**
 * 게임 전역 상수.
 *
 * 호스트와 클라이언트가 같은 값을 써야 하므로 shared 에 둔다.
 * 클라이언트 예측(prediction)이 호스트 시뮬레이션과 어긋나지 않으려면
 * 이동 관련 상수는 반드시 여기 한 곳에서만 정의되어야 한다.
 */

/** 호스트 시뮬레이션 틱 레이트. 스냅샷도 매 틱 브로드캐스트한다. */
export const TICK_HZ = 20
export const TICK_MS = 1000 / TICK_HZ
export const TICK_DT = 1 / TICK_HZ

/**
 * 클라이언트 예측도 호스트와 같은 TICK_HZ 고정 스텝으로 돈다.
 *
 * 프레임 단위(60fps)로 적분하면 직선 구간에서는 결과가 같지만, 벽을 스치며
 * 미끄러질 때 스텝 크기에 따라 이동 거리가 달라져 예측이 계속 어긋난다.
 * 입력 전송도 이 스텝에 맞춰서 보낸다. 호스트가 틱당 최신 입력 하나만 쓰므로
 * 더 자주 보내봐야 대역폭만 쓴다.
 */

/** 미로 한 칸의 월드 크기(단위). */
export const CELL = 4
/** 벽 두께. */
export const WALL_T = 0.4
/** 벽 높이. */
export const WALL_H = 3.2

/** 플레이어 충돌 반지름. */
export const PLAYER_R = 0.55
/** 플레이어 이동 속도 (단위/초). */
export const PLAYER_SPEED = 6.0
/** 눈높이 (1인칭 카메라). */
export const EYE_H = 1.55

/** 열쇠 / 탈출구 상호작용 반경. */
export const PICKUP_R = 1.3
export const EXIT_R = 1.6

/** 원격 플레이어 렌더링 지연. 스냅샷 2개분 버퍼를 확보해 튐을 막는다. */
export const INTERP_DELAY_MS = 100

/** 로컬 예측 위치가 권위 위치와 이 이상 벌어지면 부드럽게 보정하지 않고 즉시 스냅한다. */
export const RECONCILE_SNAP_DIST = 2.5

/**
 * 예측 오차가 1/e 로 줄어드는 데 걸리는 시간(초).
 *
 * "프레임당 몇 %" 로 잡으면 60fps 기기와 20fps 기기에서 보정 속도가 3배 차이 난다.
 * 느린 기기일수록 오차가 오래 남아 캐릭터가 밀리는 느낌이 되므로,
 * 반드시 프레임이 아니라 시간을 기준으로 감쇠시켜야 한다.
 */
export const RECONCILE_TAU = 0.12

export const MAX_PLAYERS = 4

/** 레벨 클리어 후 다음 레벨로 넘어가기까지의 대기(초). */
export const CLEAR_HOLD_SEC = 3

/**
 * 레벨별 미로 크기. 홀수로 유지하고 상한을 둔다.
 * 레벨 1 은 "적당한 크기"인 15x15 에서 시작해 레벨마다 4칸씩 커진다.
 */
export function mazeSizeForLevel(level: number): number {
  const size = 15 + (level - 1) * 4
  return Math.min(size, 41)
}

/** 레벨별 필요한 열쇠 개수. 지금은 1개 고정이지만 배열 구조라 늘리기 쉽다. */
export function keyCountForLevel(_level: number): number {
  return 1
}
