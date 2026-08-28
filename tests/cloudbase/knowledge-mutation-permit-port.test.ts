import { describe, expect, it, vi } from 'vitest'

describe('Cloud knowledge mutation permit port', () => {
  it('revalidates the DB-owned job capability immediately before a remote side effect', async () => {
    const implementation = await import(
      '../../cloudbase/knowledge/worker/mutation-permit-port.js'
    ).catch(() => ({}))
    expect(implementation).toHaveProperty('createMutationPermitPortHandler')
    const createHandler = (implementation as {
      createMutationPermitPortHandler?: (options: {
        validatePermit: (input: Record<string, string>) => Promise<{ authorized: boolean }>
      }) => {
        run: <T>(input: unknown, mutation: () => Promise<T>) => Promise<T>
      }
    }).createMutationPermitPortHandler
    expect(createHandler).toBeTypeOf('function')
    if (!createHandler) return

    let databaseNow = 0
    const job = {
      workerId: 'worker_1', jobId: 'job_purge', leaseToken: 'lease_job_purge',
      capability: 'opaque_server_permit', mutationDeadlineAt: 100,
      state: 'running', mutationKind: 'storage_delete',
    }
    const validatePermit = vi.fn(async (input: Record<string, string>) => ({
      authorized: databaseNow < job.mutationDeadlineAt
        && job.state === 'running'
        && input.p_worker_id === job.workerId
        && input.p_job_id === job.jobId
        && input.p_lease_token === job.leaseToken
        && input.p_mutation_permit === job.capability
        && input.p_mutation_kind === job.mutationKind,
    }))
    const handler = createHandler({ validatePermit })
    const request = {
      contractVersion: 'db-job-v1',
      mutationKind: 'storage_delete',
      mutationAuthorization: {
        capability: job.capability, workerId: job.workerId,
        jobId: job.jobId, leaseToken: job.leaseToken,
      },
    }
    let sideEffects = 0
    await expect(handler.run(request, async () => ++sideEffects)).resolves.toBe(1)
    expect(sideEffects).toBe(1)

    databaseNow = 100
    await expect(handler.run(request, async () => ++sideEffects)).rejects.toEqual({
      code: 'CONFLICT',
    })
    expect(sideEffects).toBe(1)
    expect(validatePermit).toHaveBeenLastCalledWith({
      p_worker_id: 'worker_1', p_job_id: 'job_purge',
      p_lease_token: 'lease_job_purge', p_mutation_permit: 'opaque_server_permit',
      p_mutation_kind: 'storage_delete',
    })
    await expect(handler.run({ ...request, ownerId: 'forged' }, async () => {
      sideEffects += 1
    })).rejects.toEqual({ code: 'INVALID_INPUT' })
    expect(sideEffects).toBe(1)
  })
})
