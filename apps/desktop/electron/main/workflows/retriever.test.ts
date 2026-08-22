import { describe, expect, it } from 'vitest'
import type { WorkflowDetail } from '@autoforge/shared'
import { retrieveWorkflows } from './retriever.js'

const baseWorkflow = {
  version: '1.0.0',
  description: '在网页中完成任务。',
  author: 'AutoForge',
  category: 'search',
  enabled: true,
  source: 'installed' as const,
  integrity: 'valid' as const,
  updatedAt: '2026-07-19T00:00:00.000Z',
  permissions: [{
    capability: 'browser.open' as const,
    scope: { origins: ['https://www.baidu.com'] },
  }],
  timeoutMs: 30_000,
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
}

const baiduWorkflow: WorkflowDetail = {
  ...baseWorkflow,
  id: 'browser.search.baidu',
  name: '百度搜索',
  cities: [],
  runtimeIdentity: { id: 'browser.search.baidu', version: '1.0.0', source: 'installed' },
  activationExamples: ['使用百度搜索今日天气'],
  activationNegativeExamples: [],
}

const answerWeatherWorkflow: WorkflowDetail = {
  ...baseWorkflow,
  id: 'weather.answer',
  name: '天气回答',
  cities: [],
  runtimeIdentity: { id: 'weather.answer', version: '1.0.0', source: 'installed' },
  activationExamples: ['回答今日天气'],
  activationNegativeExamples: ['使用百度搜索今日天气'],
}

describe('retrieveWorkflows', () => {
  it('prefers a positive example and excludes a negative example', () => {
    const ranked = retrieveWorkflows('使用百度搜索今日天气', [baiduWorkflow, answerWeatherWorkflow], 3)

    expect(ranked.map((item) => item.id)).toEqual(['browser.search.baidu'])
  })

  it('excludes disabled or non-valid workflows and orders score ties by workflow ID', () => {
    const ranked = retrieveWorkflows('search', [
      { ...baiduWorkflow, id: 'zeta', name: 'search', activationExamples: [] },
      { ...baiduWorkflow, id: 'alpha', name: 'search', activationExamples: [] },
      { ...baiduWorkflow, id: 'disabled', name: 'search', enabled: false, activationExamples: [] },
      { ...baiduWorkflow, id: 'unchecked', name: 'search', integrity: 'unchecked', activationExamples: [] },
    ], 3)

    expect(ranked.map((item) => item.id)).toEqual(['alpha', 'zeta'])
  })

  it('ranks matching description tokens ahead of matching category tokens', () => {
    const ranked = retrieveWorkflows('search', [
      { ...baiduWorkflow, id: 'category', name: '浏览器', description: '自动化工具', category: 'search', activationExamples: [] },
      { ...baiduWorkflow, id: 'description', name: '浏览器', description: 'search', category: 'utility', activationExamples: [] },
    ], 3)

    expect(ranked.map((item) => item.id)).toEqual(['description', 'category'])
  })
})
