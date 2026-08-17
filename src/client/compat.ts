/**
 * 브라우저 환경 차이를 흡수하는 shim.
 *
 * 게임 자체와는 무관하지만, 실행 환경에 따라 초기화 자체가 실패하는 것들을 막는다.
 */

/**
 * Gamepad API 가 permissions policy 로 막힌 환경을 대비한다.
 *
 * Babylon 은 초기화 과정에서 입력 장치를 훑으면서 navigator.getGamepads() 를 부른다.
 * 보통은 문제가 없지만, 샌드박스된 iframe(예: Artifact 뷰어)처럼
 * `gamepad` 기능이 허용되지 않은 곳에서는 이 호출이 예외를 던지고,
 * 그대로 엔진 생성이 실패해 화면이 통째로 뜨지 않는다.
 *
 *   Failed to execute 'getGamepads' on 'Navigator':
 *   Access to the feature "gamepad" is disallowed by permissions policy.
 *
 * 게임패드를 지원하지 않으므로, 막혀 있으면 빈 목록을 돌려주는 함수로 갈아끼운다.
 * 정상적으로 동작하는 브라우저에서는 아무것도 건드리지 않는다.
 */
export function installGamepadFallback(): void {
  if (typeof navigator === 'undefined') return
  const nav = navigator as Navigator & { getGamepads?: () => unknown[] }
  if (typeof nav.getGamepads !== 'function') return

  try {
    nav.getGamepads()
    return // 사용 가능하면 그대로 둔다.
  } catch {
    // 아래에서 대체한다.
  }

  try {
    Object.defineProperty(nav, 'getGamepads', {
      value: () => [],
      configurable: true,
      writable: true,
    })
  } catch {
    // 재정의조차 막힌 환경이면 더 할 수 있는 게 없다.
    // 이 경우 엔진 생성에서 실패하고, main.ts 의 부팅 배너가 이유를 띄운다.
    console.warn('[compat] getGamepads 를 대체하지 못했습니다.')
  }
}

/** 앱 시작 시 한 번 호출한다. 엔진을 만들기 전이어야 한다. */
export function installBrowserCompat(): void {
  installGamepadFallback()
}
