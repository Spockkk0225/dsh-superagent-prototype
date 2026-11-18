/** Standalone project panel for the loopback Codex CLI deployment. */
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { fill } from '../infra/text.ts'
import { caller } from './api.ts'
import STYLES from './client.css?raw'
import THEME from './projects-theme.css?raw'
import { en, zh } from './locales.ts'
import { ProjectsPage } from './projects.tsx'
import { messages } from './provider.tsx'
import type { T } from './text.ts'

type Locale = 'zh' | 'en'
const LANG_KEY = 'superagent.projects.language'
function savedLocale(): Locale {
  try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh' }
  catch { return 'zh' }
}

function StandaloneProjects() {
  const [locale, setLocale] = useState(savedLocale)
  const { t, call } = useMemo(() => {
    const copy = locale === 'zh' ? zh : en
    const t: T = (key, values = {}) => fill(copy[key] ?? key,
      Object.fromEntries(Object.entries(values).map(([name, value]) => [name, String(value)])))
    return { t, call: caller(() => messages(t)) }
  }, [locale])
  useEffect(() => {
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en'
    document.title = `Super-Org · ${t('tab.projects')}`
    try { localStorage.setItem(LANG_KEY, locale) } catch { /* Language still applies for this page. */ }
  }, [locale, t])
  return <>
    <style>{STYLES}{THEME}</style>
    <div className="dt-page"><main className="dt-column">
      <header className="dt-standalone-header">
        <h1 className="dt-title">Super-Org</h1>
        <select className="dt-select dt-project-locale" aria-label={t('project.language')} value={locale}
          onChange={event => setLocale(event.currentTarget.value === 'en' ? 'en' : 'zh')}>
          <option value="zh" lang="zh-CN">简体中文</option>
          <option value="en" lang="en">English</option>
        </select>
      </header>
      <ProjectsPage t={t} call={call} />
    </main></div>
  </>
}

createRoot(document.getElementById('superagent-projects')!).render(<StandaloneProjects />)
