/**
 * dist/ 결과물을 단일 HTML 로 합친다.
 *
 * Artifact 로 배포하면 외부 호스트 요청이 CSP 로 막히므로, JS 와 CSS 를 전부
 * 인라인해야 한다. 인프로세스 전송만 쓰기 때문에 네트워크 없이도 그대로 돌아간다.
 *
 *   npm run artifact   # build 까지 함께 수행
 *
 * 결과: dist/artifact.html
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DIST = new URL('../dist/', import.meta.url).pathname

const [css, js] = await Promise.all([
  readFile(join(DIST, 'app.css'), 'utf8'),
  readFile(join(DIST, 'app.js'), 'utf8'),
])

// 번들 문자열 안에 </script> 가 들어 있으면 인라인 시 스크립트가 조기 종료된다.
const safeJs = js.replace(/<\/script/gi, '<\\/script')

// Artifact 는 doctype / head / body 를 알아서 감싸주므로 본문만 쓴다.
const html = `<title>미로 탈출</title>
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${safeJs}
</script>
`

const outPath = join(DIST, 'artifact.html')
await writeFile(outPath, html, 'utf8')

const kb = (Buffer.byteLength(html) / 1024).toFixed(0)
console.log(`artifact.html 생성 완료 (${kb} KB) → ${outPath}`)
