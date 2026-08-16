import { useEffect, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, X } from 'lucide-react'
import { api, queryKeys, useCampaigns } from '../api'
import type { InventoryItem } from '../types'
import { formatNumber } from '../utils'

export function PolicyEditor({ item, onClose }: { item: InventoryItem | null; onClose: () => void }) {
  const campaigns = useCampaigns()
  const queryClient = useQueryClient()
  const [lowTarget, setLowTarget] = useState('')
  const [highTarget, setHighTarget] = useState('')
  const [priority, setPriority] = useState(0)
  const [excluded, setExcluded] = useState(false)

  useEffect(() => {
    setLowTarget(item?.low_target?.toString() ?? '')
    setHighTarget(item?.high_target?.toString() ?? '')
    setPriority(item?.priority ?? 0)
    setExcluded(item?.excluded ?? false)
  }, [item])

  const mutation = useMutation({
    mutationFn: async () => {
      const campaign = campaigns.data?.[0]
      if (!item || !campaign) throw new Error('No active campaign is available')
      return api.putPolicy({
        campaign_id: campaign.campaign_id,
        area_pk: item.area_pk,
        product_guid: item.product_guid,
        low_target: lowTarget === '' ? null : Number(lowTarget),
        high_target: highTarget === '' ? null : Number(highTarget),
        priority,
        excluded,
      })
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inventory }),
        queryClient.invalidateQueries({ queryKey: queryKeys.overview }),
        queryClient.invalidateQueries({ queryKey: queryKeys.trade }),
        queryClient.invalidateQueries({ queryKey: queryKeys.policies }),
      ])
      onClose()
    },
  })

  if (!item) return null
  const invalid = lowTarget !== '' && highTarget !== '' && Number(highTarget) < Number(lowTarget)
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="policy-dialog" role="dialog" aria-modal="true" aria-labelledby="policy-title">
        <button className="icon-button close" aria-label="Close policy editor" onClick={onClose}><X size={18} /></button>
        <p className="eyebrow">Management policy</p>
        <h2 id="policy-title">{item.product_name} in {item.area_name}</h2>
        <p className="dialog-description">Targets drive pressure signals and advisory transfer amounts. They do not change the game.</p>
        <div className="policy-current">
          <span><small>Available</small><strong>{formatNumber(item.available_stock)}</strong></span>
          <span><small>Capacity</small><strong>{formatNumber(item.capacity)}</strong></span>
          <span><small>Current source</small><strong>{item.policy_source.replace('_', ' ')}</strong></span>
        </div>
        <div className="form-grid">
          <label>Low target<input type="number" min="0" value={lowTarget} onChange={(event) => setLowTarget(event.target.value)} /></label>
          <label>High target<input type="number" min="0" value={highTarget} onChange={(event) => setHighTarget(event.target.value)} /></label>
          <label>Priority<select value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
            <option value={-2}>Low</option><option value={0}>Normal</option><option value={2}>High</option><option value={5}>Critical</option>
          </select></label>
          <label className="checkbox-field"><input type="checkbox" checked={excluded} onChange={(event) => setExcluded(event.target.checked)} />Exclude from transfer candidates</label>
        </div>
        {invalid && <p className="field-error">High target must be at least the low target.</p>}
        {mutation.error && <p className="field-error">{mutation.error.message}</p>}
        <div className="dialog-actions">
          <button className="button ghost" onClick={onClose}>Cancel</button>
          <button className="button primary" disabled={invalid || mutation.isPending} onClick={() => mutation.mutate()}>
            <Save size={16} /> {mutation.isPending ? 'Saving…' : 'Save policy'}
          </button>
        </div>
      </section>
    </div>
  )
}

