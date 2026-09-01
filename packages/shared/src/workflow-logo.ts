import { z } from 'zod'

const workflowLogoUrlPattern = /^https:\/\/img\.liangqy\.com(?:\/|\?|#|$)/

export const workflowLogoSchema = z.url().refine(
  (value) => workflowLogoUrlPattern.test(value),
  { message: 'Expected a workflow logo URL hosted at https://img.liangqy.com' },
)
