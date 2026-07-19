import { describe, expect, it } from 'vitest'
import { defineWorkflow } from './define-workflow.js'

describe('defineWorkflow', () => {
  it('returns a frozen workflow definition', () => {
    const definition = defineWorkflow({
      async run(_context, input: { value: string }) {
        return { value: input.value }
      },
    })

    expect(Object.isFrozen(definition)).toBe(true)
  })
})
