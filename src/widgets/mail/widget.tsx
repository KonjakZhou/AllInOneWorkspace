import { useContext, useMemo, useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import { z } from 'zod'
import { defineWidget, type WidgetContext } from '../../sdk/types'
import { defaultMailFilter, filterSchema, type MailRef, type MailView } from '../../shared/mail'
import { OpenMailPage } from '../../mail/navigation'
import { WorkspaceVisible } from '../../workspace/navigation'
import { MailAccounts, useMailAccounts } from '../../mail/accounts'
import { filterKey, MailFeed, MailFilters } from '../../mail/feed'
import '../../mail/mail.css'

type Config = typeof defaultMailFilter

function MailWidget({ accountId, config, updateConfig }: WidgetContext<Config, null>) {
  const api = useMemo(() => window.workspace.mailFor(accountId), [accountId])
  const { state, error } = useMailAccounts(api)
  const [editing, setEditing] = useState(false)
  const openMailPage = useContext(OpenMailPage)
  const active = useContext(WorkspaceVisible)
  const accounts = state?.accounts ?? []
  const filter = {
    ...config,
    account: accounts.some(({ id }) => id === config.account) ? config.account : null,
  }

  function open(
    selected: MailRef | null,
    trigger: HTMLButtonElement,
    startAt?: MailView['startAt'],
  ) {
    openMailPage(
      {
        accountId,
        filter,
        selected: selected && { account: selected.account, id: selected.id },
        startAt,
      },
      trigger,
    )
  }

  return (
    <div className="mail-card">
      <div className="mail-controls">
        <MailFilters filter={filter} change={updateConfig} accounts={accounts} />
        <div className="widget-actions">
          <button
            className="icon-button compact"
            aria-label="添加邮箱账户"
            aria-haspopup="dialog"
            title="添加或管理邮箱账户"
            onClick={() => setEditing(true)}
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <MailFeed
        key={filterKey(filter) + ':' + accounts.map(({ id }) => id).join(',')}
        api={api}
        filter={filter}
        select={open}
        compact
        active={active}
        footerAction={
          <button
            className="quiet-button"
            data-workspace-page-entry
            onClick={(event) => open(null, event.currentTarget)}
          >
            查看全部 <ChevronRight size={14} aria-hidden="true" />
          </button>
        }
        accounts={accounts}
      />
      {editing && <MailAccounts api={api} state={state} close={() => setEditing(false)} />}
    </div>
  )
}

export default defineWidget({
  type: 'mail.inbox',
  name: '邮箱',
  description: '在一个列表中查看飞书邮箱、163 邮箱和 Gmail。',
  version: 1,
  icon: 'mail',
  accent: 'sage',
  defaultSize: { w: 5, h: 5 },
  minSize: { w: 3, h: 5 },
  defaultConfig: defaultMailFilter,
  defaultData: null,
  configSchema: filterSchema,
  dataSchema: z.null(),
  Component: MailWidget,
})
