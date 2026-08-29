import { defineStore } from 'pinia'
import type {
  MembershipAuditEntry,
  MembershipMutationRequest,
  MembershipSummary,
} from '@autoforge/shared'
import { displayError, getDesktopApi } from '../services/desktop-api'

export const useMembershipStore = defineStore('membership', {
  state: () => ({
    current: undefined as MembershipSummary | undefined,
    selected: undefined as MembershipSummary | undefined,
    audit: [] as MembershipAuditEntry[],
    auditTotal: 0,
    loading: false,
    updating: false,
    error: '',
  }),
  actions: {
    async loadCurrent(): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        this.current = await getDesktopApi().membership.getCurrent()
      } catch {
        this.error = '会员信息暂时不可用'
      } finally {
        this.loading = false
      }
    },
    async loadTarget(targetUserId: string): Promise<void> {
      this.loading = true
      this.error = ''
      try {
        const [membership, audit] = await Promise.all([
          getDesktopApi().membership.getTarget(targetUserId),
          getDesktopApi().membership.listAudit({ targetUserId, page: 1, pageSize: 20 }),
        ])
        this.selected = membership
        this.audit = audit.items
        this.auditTotal = audit.total
      } catch (error) {
        this.error = displayError(error, '会员信息加载失败')
      } finally {
        this.loading = false
      }
    },
    async mutate(input: MembershipMutationRequest): Promise<boolean> {
      this.updating = true
      this.error = ''
      try {
        const result = await getDesktopApi().membership.mutate(input)
        this.selected = result.membership
        const audit = await getDesktopApi().membership.listAudit({
          targetUserId: input.targetUserId, page: 1, pageSize: 20,
        })
        this.audit = audit.items
        this.auditTotal = audit.total
        return true
      } catch (error) {
        this.error = displayError(error, '会员设置失败')
        if (input.targetUserId) await this.loadTarget(input.targetUserId)
        return false
      } finally {
        this.updating = false
      }
    },
    reset(): void {
      this.current = undefined
      this.selected = undefined
      this.audit = []
      this.auditTotal = 0
      this.error = ''
    },
  },
})
