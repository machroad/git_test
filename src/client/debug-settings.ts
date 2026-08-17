/**
 * 개발/디버그용 표시 설정.
 *
 * 게임 규칙에는 영향을 주지 않고 화면에 무엇을 보여줄지만 바꾼다.
 * 모든 뷰가 같은 객체를 참조하므로, 패널에서 한 번 바꾸면 4분할 화면에도 함께 적용된다.
 */
export interface DebugSettings {
  /** 탐사 여부와 무관하게 미로 전체를 미니맵에 그린다. */
  minimapRevealAll: boolean
  /** 미니맵을 화면 중앙에 크게 띄운다. */
  minimapExpanded: boolean
  /** 방 영역을 미니맵에 강조한다. */
  highlightRooms: boolean
}

export const debugSettings: DebugSettings = {
  minimapRevealAll: false,
  minimapExpanded: false,
  highlightRooms: true,
}
