import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import AppShell from '../layouts/AppShell.vue'

describe('AppShell', () => {
  it('renders exactly Discover and Settings as primary navigation', () => {
    const wrapper = mount(AppShell, {
      global: {
        stubs: {
          RouterLink: { template: '<a><slot /></a>' },
          RouterView: { template: '<main />' }
        }
      }
    })

    const navigation = wrapper.findAll('[data-testid="primary-nav-item"]')
    expect(navigation).toHaveLength(2)
    expect(navigation.map((item) => item.text())).toEqual(['发现', '设置'])
  })
})
