/**
 * 게임 시작 전 설정 화면.
 *
 * 레벨을 몇 개든 추가할 수 있고, 각 레벨의 미로 크기 / 방 개수 / 열쇠 개수를 정한다.
 * 테스트가 목적이라 "저장 후 시작"까지 클릭 몇 번으로 끝나야 한다.
 *
 * 설정은 localStorage 에 남긴다. 같은 조합을 반복해서 들여다볼 일이 많아서,
 * 새로고침할 때마다 다시 입력하게 만들면 쓰기 싫어진다.
 */
import {
  DEFAULT_RUN_CONFIG,
  LEVEL_LIMITS,
  clampField,
  nextLevelDefaults,
  sanitizeRunConfig,
  type LevelConfig,
  type RunConfig,
} from '../shared/config'

const STORAGE_KEY = 'maze-run-config'

export function loadStoredConfig(): RunConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return cloneConfig(DEFAULT_RUN_CONFIG)
    return sanitizeRunConfig(JSON.parse(raw))
  } catch {
    // 저장된 값이 깨졌다고 게임을 못 켜면 안 된다.
    return cloneConfig(DEFAULT_RUN_CONFIG)
  }
}

export function storeConfig(config: RunConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 사파리 프라이빗 모드 등에서 실패할 수 있다. 저장 실패로 게임을 막지 않는다.
  }
}

function cloneConfig(config: RunConfig): RunConfig {
  return { levels: config.levels.map((level) => ({ ...level })) }
}

export interface SetupResult {
  config: RunConfig
  viewCount: number
}

/**
 * 설정 화면을 띄우고, 시작을 누르면 결과를 돌려준다.
 * 화면은 시작과 동시에 사라진다.
 */
export function showSetupScreen(initialViewCount: number): Promise<SetupResult> {
  const config = loadStoredConfig()
  let viewCount = initialViewCount

  const root = document.createElement('div')
  root.className = 'setup'
  root.innerHTML = `
    <div class="setup__panel">
      <h1 class="setup__title">미로 탈출 — 설정</h1>
      <p class="setup__lead">
        레벨을 추가하고 미로 크기 · 방 개수 · 열쇠 개수를 정한 뒤 시작합니다.
        로비에서 출발해 던전 구멍으로 들어가면 1층부터 순서대로 진행합니다.
      </p>

      <div class="setup__section">
        <div class="setup__sectionHead">
          <h2>레벨</h2>
          <button type="button" class="setup__add" data-action="add">+ 레벨 추가</button>
        </div>
        <div class="setup__levelHead">
          <span>층</span><span>가로</span><span>세로</span><span>방</span><span>열쇠</span><span></span>
        </div>
        <div class="setup__levels" data-levels></div>
      </div>

      <div class="setup__section">
        <h2>테스트 화면</h2>
        <div class="setup__views" data-views></div>
        <p class="setup__hint">
          한 페이지에서 클라이언트를 여러 개 띄웁니다. 네트코드를 눈으로 확인할 때 씁니다.
        </p>
      </div>

      <div class="setup__actions">
        <button type="button" class="setup__reset" data-action="reset">기본값으로</button>
        <button type="button" class="setup__start" data-action="start">시작</button>
      </div>
    </div>
  `
  document.body.appendChild(root)

  const levelsEl = root.querySelector('[data-levels]') as HTMLElement
  const viewsEl = root.querySelector('[data-views]') as HTMLElement

  const renderLevels = () => {
    levelsEl.textContent = ''
    config.levels.forEach((level, index) => {
      levelsEl.appendChild(buildLevelRow(level, index, config.levels.length, {
        onChange: () => renderLevels(),
        onRemove: () => {
          config.levels.splice(index, 1)
          renderLevels()
        },
      }))
    })
  }

  const renderViews = () => {
    viewsEl.textContent = ''
    for (const count of [1, 2, 4]) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'setup__viewBtn'
      button.textContent = `${count}명`
      button.classList.toggle('is-on', count === viewCount)
      button.addEventListener('click', () => {
        viewCount = count
        renderViews()
      })
      viewsEl.appendChild(button)
    }
  }

  renderLevels()
  renderViews()

  return new Promise<SetupResult>((resolve) => {
    root.addEventListener('click', (event) => {
      const action = (event.target as HTMLElement).dataset?.action
      if (!action) return

      if (action === 'add') {
        config.levels.push(nextLevelDefaults(config.levels[config.levels.length - 1]))
        renderLevels()
        return
      }
      if (action === 'reset') {
        config.levels = cloneConfig(DEFAULT_RUN_CONFIG).levels
        renderLevels()
        return
      }
      if (action === 'start') {
        const finalConfig = sanitizeRunConfig(config)
        storeConfig(finalConfig)
        root.remove()
        resolve({ config: finalConfig, viewCount })
      }
    })
  })
}

interface RowHandlers {
  onChange: () => void
  onRemove: () => void
}

function buildLevelRow(
  level: LevelConfig,
  index: number,
  total: number,
  handlers: RowHandlers,
): HTMLElement {
  const row = document.createElement('div')
  row.className = 'setup__level'

  const label = document.createElement('span')
  label.className = 'setup__levelNo'
  label.textContent = `${index + 1}`
  row.appendChild(label)

  const fields: (keyof typeof LEVEL_LIMITS)[] = ['width', 'height', 'roomCount', 'keyCount']
  for (const field of fields) {
    const input = document.createElement('input')
    input.type = 'number'
    input.min = String(LEVEL_LIMITS[field].min)
    input.max = String(LEVEL_LIMITS[field].max)
    input.value = String(level[field])
    input.className = 'setup__num'
    input.addEventListener('change', () => {
      const value = clampField(field, Number(input.value))
      level[field] = value
      input.value = String(value)
      handlers.onChange()
    })
    row.appendChild(input)
  }

  const remove = document.createElement('button')
  remove.type = 'button'
  remove.className = 'setup__remove'
  remove.textContent = '삭제'
  // 레벨이 하나도 없으면 던전에 들어갈 수가 없다.
  remove.disabled = total <= 1
  remove.addEventListener('click', handlers.onRemove)
  row.appendChild(remove)

  return row
}
