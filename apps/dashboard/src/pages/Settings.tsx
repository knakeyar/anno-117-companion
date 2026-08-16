import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Database, FileJson2, FolderInput, HardDrive, Pencil, Save, Server, ShieldCheck, X } from 'lucide-react'
import { api, queryKeys, useCampaigns, useStatus } from '../api'
import { CatalogBadge, EmptyState, ErrorState, LoadingState, MetricCard, PageHeader, SectionHeader } from '../components/Common'
import type { Campaign } from '../types'
import { formatNumber, titleCase } from '../utils'

function CampaignNameEditor({ campaign }: { campaign: Campaign }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(campaign.display_name)
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => api.renameCampaign(campaign.campaign_id, name.trim()),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.campaigns }),
        queryClient.invalidateQueries({ queryKey: queryKeys.status }),
      ])
      setEditing(false)
    },
  })
  return (
    <div className="campaign-row">
      <span className="campaign-icon"><ShieldCheck size={18} /></span>
      <div className="campaign-main">
        {editing ? <input aria-label="Campaign name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} autoFocus /> : <strong>{campaign.display_name}</strong>}
        <small>Seed {campaign.game_seed ?? 'unknown'} · participant {campaign.participant_guid ?? 'unknown'} · {titleCase(campaign.identity_confidence)}</small>
      </div>
      {editing ? <div className="inline-actions"><button className="icon-button" aria-label="Cancel rename" onClick={() => { setName(campaign.display_name); setEditing(false) }}><X size={16} /></button><button className="icon-button primary" aria-label="Save campaign name" disabled={!name.trim() || mutation.isPending} onClick={() => mutation.mutate()}><Save size={16} /></button></div> : <button className="icon-button" aria-label={`Rename ${campaign.display_name}`} onClick={() => setEditing(true)}><Pencil size={16} /></button>}
    </div>
  )
}

export function SettingsPage() {
  const status = useStatus()
  const campaigns = useCampaigns()
  const queryClient = useQueryClient()
  const assignment = useMutation({
    mutationFn: ({ campaignId, playSessionId }: { campaignId: string; playSessionId: string }) =>
      api.assignCampaign(campaignId, playSessionId),
    onSuccess: async () => {
      await queryClient.invalidateQueries()
    },
  })
  const selection = useMutation({
    mutationFn: (campaignId: string) => api.selectCampaign(campaignId),
    onSuccess: async () => { await queryClient.invalidateQueries() },
  })
  if (status.isLoading || campaigns.isLoading) return <LoadingState label="Inspecting the data pipeline…" />
  const error = status.error || campaigns.error
  if (error) return <ErrorState error={error} retry={() => { void status.refetch(); void campaigns.refetch() }} />
  if (!status.data || !campaigns.data) return null
  const data = status.data
  return (
    <div className="page">
      <PageHeader eyebrow="Settings and health" title="Know exactly what the dashboard knows." description="Inspect log ingestion, database persistence, identity evidence, and catalog coverage." actions={<CatalogBadge catalog={data.catalog} />} />
      <section className="metric-grid compact">
        <MetricCard label="Data service" value={titleCase(data.status)} tone={data.status === 'ok' ? 'positive' : 'critical'} supporting={data.service} icon={<Server size={16} />} />
        <MetricCard label={`Database · ${data.database.journal_mode}`} value={data.database.exists ? `${formatNumber(data.database.size_bytes / 1024, 1)} KB` : 'Missing'} tone={data.database.exists ? 'positive' : 'critical'} supporting={data.database.path} icon={<Database size={16} />} />
        <MetricCard label="Parse failures" value={data.telemetry.parse_error_count} tone={data.telemetry.parse_error_count ? 'critical' : 'positive'} supporting="Raw evidence retained" icon={<FileJson2 size={16} />} />
        <MetricCard label="Catalog" value={`${data.catalog.products} goods`} supporting={`${data.catalog.recipes} verified chains`} tone={data.catalog.coverage === 'missing' ? 'critical' : 'warning'} icon={<HardDrive size={16} />} />
      </section>

      <div className="settings-grid">
        <section className="panel">
          <SectionHeader title="Campaign identity" description="Seed and participant are provisional evidence until you name the campaign." />
          {campaigns.data.length ? <><label className="select-field active-campaign"><span>Dashboard campaign</span><select value={data.selected_campaign_id ?? ''} disabled={selection.isPending} onChange={(event) => selection.mutate(event.target.value)}>{campaigns.data.map((campaign) => <option value={campaign.campaign_id} key={campaign.campaign_id}>{campaign.display_name}</option>)}</select></label><div className="campaign-list">{campaigns.data.map((campaign) => <CampaignNameEditor campaign={campaign} key={campaign.campaign_id} />)}</div></> : <EmptyState title="No campaign observed" description="A campaign will be created when the first snapshot supplies game seed and participant evidence." />}
        </section>
        <section className="panel">
          <SectionHeader title="Current play session" description="Every mod load opens a new authority epoch." />
          {data.play_session ? <dl className="detail-list">
            <div><dt>Session</dt><dd>{data.play_session.play_session_id.slice(0, 8)}…</dd></div>
            <div><dt>Load epoch</dt><dd>{data.play_session.load_epoch}</dd></div>
            <div><dt>Mod version</dt><dd>{data.play_session.mod_version ?? 'Unknown'}</dd></div>
            <div><dt>Started</dt><dd>{new Date(data.play_session.started_at).toLocaleString()}</dd></div>
            {campaigns.data.length > 1 && <div><dt>Assigned campaign</dt><dd>
              <label className="select-field session-assignment">
                <span className="sr-only">Assign current play session to campaign</span>
                <select
                  value={data.play_session.campaign_id ?? ''}
                  disabled={assignment.isPending}
                  onChange={(event) => assignment.mutate({ campaignId: event.target.value, playSessionId: data.play_session!.play_session_id })}
                >
                  {campaigns.data.map((campaign) => <option value={campaign.campaign_id} key={campaign.campaign_id}>{campaign.display_name}</option>)}
                </select>
              </label>
              {assignment.error && <small className="field-error">{assignment.error.message}</small>}
            </dd></div>}
          </dl> : <EmptyState title="No active play session" description="Historical data remains available; start or load a game to create a live authority epoch." />}
        </section>
      </div>

      <section className="panel">
        <SectionHeader title="Telemetry sources" description={`${data.telemetry.directory}/${data.telemetry.glob} is polled for Docker Desktop compatibility.`} />
        {data.telemetry.sources.length ? <div className="source-list">{data.telemetry.sources.map((source) => <div className="source-row" key={source.path}>
          <span className="source-icon"><FolderInput size={18} /></span>
          <div><strong>{source.path}</strong><small>{formatNumber(source.byte_offset)} / {formatNumber(source.file_size)} bytes · {source.last_read_at ? `read ${new Date(source.last_read_at).toLocaleString()}` : 'not read yet'}</small>{source.last_error && <em>{source.last_error}</em>}</div>
          <CheckCircle2 size={18} className={source.last_error ? 'negative' : 'positive'} />
        </div>)}</div> : <EmptyState title="No log file discovered" description="Confirm ANNO_LOG_DIR points to the Anno 117 Documents log directory and contains a matching .log file." />}
      </section>

      <section className="panel">
        <SectionHeader title="OpenAI advisor" description="Optional, on-demand analysis grounded only in deterministic companion actions." />
        <dl className="detail-list"><div><dt>Configured</dt><dd>{data.advisor.configured ? 'Yes' : 'No — deterministic actions still work'}</dd></div><div><dt>Model</dt><dd>{data.advisor.model}</dd></div><div><dt>Reasoning effort</dt><dd>{data.advisor.reasoning_effort}</dd></div><div><dt>Storage</dt><dd>Local conversation · API request store=false</dd></div></dl>
      </section>

      <section className="panel onboarding-panel">
        <SectionHeader title="Local deployment checklist" description="The dashboard is read-only and localhost-bound by default." />
        <ol className="checklist">
          <li><CheckCircle2 size={17} /><span><strong>Production mod</strong>Copy the entire `anno-companion-telemetry` folder into the Documents mods directory.</span></li>
          <li><CheckCircle2 size={17} /><span><strong>Game logs</strong>Set `ANNO_LOG_DIR` to the directory containing the active Anno log.</span></li>
          <li><CheckCircle2 size={17} /><span><strong>Persistent data directory</strong>Set `ANNO_DATA_DIR`; the service creates `anno-companion.sqlite3` and its WAL files inside it.</span></li>
          <li><CheckCircle2 size={17} /><span><strong>Start</strong>Run `docker compose up --build`, then open `http://127.0.0.1:8080`.</span></li>
        </ol>
      </section>
    </div>
  )
}
