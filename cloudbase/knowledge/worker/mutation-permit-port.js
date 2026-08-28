/* global module */

const CONTRACT_VERSION = 'db-job-v1'
const mutationKinds = new Set(['storage_delete', 'tokenhub_embedding'])

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function exactKeys(value, keys) {
  if (!isRecord(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index])
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value
    && value.length > 0 && value.length <= 128
}

function validAuthorization(value) {
  return exactKeys(value, ['capability', 'workerId', 'jobId', 'leaseToken'])
    && nonEmptyString(value.capability) && nonEmptyString(value.workerId)
    && nonEmptyString(value.jobId) && nonEmptyString(value.leaseToken)
}

function createMutationPermitPortHandler({ validatePermit }) {
  if (typeof validatePermit !== 'function') {
    throw new Error('Mutation permit handler is not configured')
  }
  return Object.freeze({
    async run(input, mutation) {
      if (!exactKeys(input, [
        'contractVersion', 'mutationKind', 'mutationAuthorization',
      ]) || input.contractVersion !== CONTRACT_VERSION
        || !mutationKinds.has(input.mutationKind)
        || !validAuthorization(input.mutationAuthorization)
        || typeof mutation !== 'function') {
        throw { code: 'INVALID_INPUT' }
      }
      const authorization = input.mutationAuthorization
      const result = await validatePermit({
        p_worker_id: authorization.workerId,
        p_job_id: authorization.jobId,
        p_lease_token: authorization.leaseToken,
        p_mutation_permit: authorization.capability,
        p_mutation_kind: input.mutationKind,
      })
      if (!exactKeys(result, ['authorized']) || result.authorized !== true) {
        throw { code: 'CONFLICT' }
      }
      return await mutation()
    },
  })
}

module.exports = { CONTRACT_VERSION, createMutationPermitPortHandler }
